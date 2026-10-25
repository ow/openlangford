"""Run with HISTORY_TEST_DATABASE_URL pointing only at a disposable PostgreSQL DB."""
import os
from uuid import uuid4
from copy import deepcopy

import psycopg2
import pytest

from ingestion.ballot_fixture import official_context, PEOPLE
from pipeline.backfill.history_coverage import (apply_manifest, verify_manifest, plan_meeting,
                                               read_meeting, query, digest)


@pytest.fixture
def database():
    url = os.environ.get('HISTORY_TEST_DATABASE_URL')
    if not url:
        pytest.skip('disposable PostgreSQL not configured')
    connection = psycopg2.connect(url)
    # All DDL is transactional and rolled back, including on a test failure.
    schema='history_coverage_test_'+uuid4().hex
    query(connection, 'CREATE SCHEMA '+schema)
    query(connection, 'SET search_path='+schema)
    query(connection, 'CREATE TABLE organizations(id int primary key,classification text)')
    query(connection, 'CREATE TABLE people(id int primary key,name text)')
    query(connection, '''CREATE TABLE meetings(id int primary key,title text,type text,meeting_date date,
        archive_path text,minutes_url text,meta jsonb,updated_at timestamptz,organization_id int,municipality_id int)''')
    query(connection, '''CREATE TABLE agenda_items(id serial primary key,meeting_id int REFERENCES meetings(id),
        item_order text,title text,category text,slug text)''')
    query(connection, '''CREATE TABLE motions(id serial primary key,meeting_id int REFERENCES meetings(id),
        agenda_item_id int REFERENCES agenda_items(id),text_content text,result text,mover text,seconder text,
        mover_id int,seconder_id int,meta jsonb)''')
    query(connection, 'CREATE TABLE votes(id serial primary key,motion_id int REFERENCES motions(id),vote text)')
    query(connection, "INSERT INTO organizations VALUES(1,'Council')")
    for person in PEOPLE:
        query(connection, 'INSERT INTO people VALUES(%s,%s)', (person['id'], person['name']))
    for mid in (77,78):
        query(connection, "INSERT INTO meetings(id,title,meeting_date,archive_path,organization_id,municipality_id) VALUES(%s,'Council','2026-01-08','archive/meeting',1,1)", (mid,))
    try:
        yield connection
    finally:
        connection.rollback()
        # Concurrency cases commit only disposable fixture setup so a second
        # connection can see it. Unique schemas are always removed afterwards.
        query(connection, 'DROP SCHEMA IF EXISTS '+schema+' CASCADE')
        connection.commit()
        connection.close()


def manifest_for(database, tmp_path):
    context = official_context(tmp_path)
    meeting, motions, items = read_meeting(database,77,1)
    plan = plan_meeting(meeting,motions,items,context['source'])
    meeting, motions, items = read_meeting(database,78,1)
    held = plan_meeting(meeting,motions,items,{'error':'pdf_requires_ocr'})
    return {'version':1,'municipality_id':1,'people_sha256':digest(query(database,'SELECT id,name FROM people ORDER BY id')),
            'meetings':[plan,held]}


def test_mixed_batch_receipts_retry_and_parent_actor_drift(database,tmp_path):
    manifest = manifest_for(database,tmp_path)
    result = apply_manifest(database,manifest,lambda:deepcopy(manifest),tmp_path)
    assert result['status']=='applied'
    assert [p['coverage'] for p in result['meetings']]==['source_occurrences_accounted_for','source_unavailable']
    assert len(query(database,'SELECT * FROM motions'))==1
    assert verify_manifest(database,manifest)['inserted_motions']==1
    # Retry acknowledges its receipt without repeating parsing or insertion.
    def must_not_parse():
        raise AssertionError('already committed receipt must be checked first')
    assert apply_manifest(database,manifest,must_not_parse,tmp_path)['status']=='already_applied'
    for change in ('mover_id=123','agenda_item_id=NULL'):
        query(database,'SAVEPOINT drift')
        query(database,'UPDATE motions SET '+change)
        with pytest.raises(ValueError,match='claims changed'):
            verify_manifest(database,manifest)
        query(database,'ROLLBACK TO SAVEPOINT drift')


def test_concurrent_claim_or_source_change_rejects_before_inserts(database,tmp_path):
    manifest = manifest_for(database,tmp_path)
    query(database,"UPDATE meetings SET title='Corrected title' WHERE id=77")
    with pytest.raises(ValueError,match='database claims changed'):
        apply_manifest(database,manifest,lambda:deepcopy(manifest),tmp_path)
    assert query(database,'SELECT * FROM motions')==[]


def test_changed_original_and_late_failure_leave_no_partial_batch(database,tmp_path):
    manifest = manifest_for(database,tmp_path)
    source = tmp_path/manifest['meetings'][0]['source_file']
    original = source.read_bytes()
    source.write_bytes(original+b'changed')
    with pytest.raises(ValueError,match='Original source changed'):
        apply_manifest(database,manifest,lambda:deepcopy(manifest),tmp_path)
    assert query(database,'SELECT * FROM motions')==[]
    source.write_bytes(original)
    query(database,'SAVEPOINT apply_batch')
    # A database constraint failure after the first insertion must rollback it.
    query(database,"ALTER TABLE meetings ADD CONSTRAINT receipt_rejected CHECK (id<>78 OR meta IS NULL)")
    with pytest.raises(psycopg2.IntegrityError):
        apply_manifest(database,manifest,lambda:deepcopy(manifest),tmp_path)
    query(database,'ROLLBACK TO SAVEPOINT apply_batch')
    assert query(database,'SELECT * FROM motions')==[]
    assert verify_manifest(database,manifest) is None


def closing_case(connection,tmp_path,monkeypatch,kind="conflict"):
    from psycopg2.extras import Json
    from test_closing_conflicts import case, AGENDA, CLOSING
    if kind=="blank":
        from test_blank_time_preservation import case
    from pipeline.backfill.history_coverage import audit
    query(connection,"INSERT INTO agenda_items(id,meeting_id,item_order,title) VALUES(99,77,'1','Agenda'),(100,77,'15','Adjournment')")
    for mid,aid,body in [(100,99,AGENDA),(309,100,CLOSING)]:
        query(connection,'INSERT INTO motions(id,meeting_id,agenda_item_id,text_content,result,meta) VALUES(%s,77,%s,%s,%s,%s)',
            (mid,aid,body,None if kind=='blank' and mid==309 else 'CARRIED',Json({})))
    meeting,rows,_=read_meeting(connection,77,1)
    class Request:param={'meeting':meeting,'rows':rows}
    fixture=case.__wrapped__(tmp_path,monkeypatch,Request())
    def regenerate():return audit(connection,[77],1,tmp_path,tmp_path/'cache',project_ref='test-project')
    manifest=regenerate()
    assert len(manifest['meetings'][0]['new_motions'])==1
    return fixture,manifest,regenerate


@pytest.mark.parametrize('kind',['conflict','blank'])
def test_authoritative_scoped_vote_counts_block_preexisting_votes_and_persist_partial_receipt(database,tmp_path,monkeypatch,kind):
    from pipeline.backfill.history_coverage import audit
    fixture,manifest,regenerate=closing_case(database,tmp_path,monkeypatch,kind)
    plan=manifest['meetings'][0]
    assert plan['closing_linked_vote_counts']['counts']==[{'motion_id':309,'linked_votes':0}]
    old_before=query(database,'SELECT * FROM motions ORDER BY id')
    query(database,"INSERT INTO votes(motion_id,vote) VALUES(309,'Yes')")
    held=audit(database,[77],1,tmp_path,tmp_path/'cache',project_ref='test-project')['meetings'][0]
    assert held['new_motions']==[] and held['closing_linked_vote_counts']['counts']==[{'motion_id':309,'linked_votes':1}]
    assert 'zero linked-vote' in held['source_report']['held'][0]['detail']
    query(database,'DELETE FROM votes')
    result=apply_manifest(database,manifest,regenerate,tmp_path)
    assert result['meetings'][0]['coverage']=='review_required'
    assert query(database,'SELECT * FROM motions WHERE id=ANY(%s) ORDER BY id',([100,309],))==old_before
    stored=query(database,"SELECT value FROM meetings,jsonb_each(meta->'history_catchup_receipts') WHERE id=77")[0]['value']
    assert stored['remaining_coverage']=='review_required' and stored['blank_time_documentary_preserved_legacy_ids' if kind=='blank' else 'unresolved_closing_conflict_ids']==[309]
    assert stored['closing_linked_vote_counts']['counts']==[{'motion_id':309,'linked_votes':0}]
    assert any(h['reason']==('reviewed_blank_time_adjournment_preserved_time_unknown_no_rewrite' if kind=='blank' else 'existing_closing_outcome_unresolved_no_rewrite') and h['legacy_ids']==[309] for h in stored['held'])
    assert verify_manifest(database,manifest)['inserted_motions']==1


@pytest.mark.parametrize('kind',['conflict','blank'])
def test_vote_arriving_after_regeneration_rejects_before_any_insert(database,tmp_path,monkeypatch,kind):
    _,manifest,_=closing_case(database,tmp_path,monkeypatch,kind)
    def reviewed_before_late_vote():
        query(database,"INSERT INTO votes(motion_id,vote) VALUES(309,'Yes')")
        return deepcopy(manifest)
    with pytest.raises(ValueError,match='Closing linked votes changed'):
        apply_manifest(database,manifest,reviewed_before_late_vote,tmp_path)
    assert query(database,'SELECT id FROM motions ORDER BY id')==[{'id':100},{'id':309}]
    assert verify_manifest(database,manifest) is None


@pytest.mark.parametrize('order',['operator_first','uncommitted_vote_first','committed_vote_during_regeneration'])
@pytest.mark.parametrize('kind',['conflict','blank'])
def test_actual_vote_writes_without_any_foreign_key_are_serialized_or_rejected_before_insertion(database,tmp_path,monkeypatch,order,kind):
    _,manifest,_=closing_case(database,tmp_path,monkeypatch,kind)
    query(database,'ALTER TABLE votes DROP CONSTRAINT votes_motion_id_fkey')
    schema=query(database,'SHOW search_path')[0]['search_path']
    database.commit()  # Publish ONLY this unique disposable fixture to the other connection.
    writer=psycopg2.connect(os.environ['HISTORY_TEST_DATABASE_URL'])
    try:
        query(writer,'SET search_path='+schema)
        query(writer,"SET lock_timeout='200ms'")
        if order=='operator_first':
            # Prove the ordinary motions/agenda locks do not block vote DML.
            query(database,'LOCK TABLE motions, agenda_items IN SHARE ROW EXCLUSIVE MODE NOWAIT')
            query(writer,"INSERT INTO votes(motion_id,vote) VALUES(309,'Yes')")
            writer.rollback();database.rollback()
            query(writer,'SET search_path='+schema);query(writer,"SET lock_timeout='200ms'")
            result=apply_manifest(database,manifest,lambda:deepcopy(manifest),tmp_path)
            assert result['status']=='applied'
            with pytest.raises(psycopg2.errors.LockNotAvailable):
                query(writer,"INSERT INTO votes(motion_id,vote) VALUES(309,'Yes')")
            writer.rollback()
            assert query(database,'SELECT * FROM votes')==[]
            stored=query(database,"SELECT value FROM meetings,jsonb_each(meta->'history_catchup_receipts') WHERE id=77")[0]['value']
            assert stored['remaining_coverage']=='review_required' and stored['blank_time_documentary_preserved_legacy_ids' if kind=='blank' else 'unresolved_closing_conflict_ids']==[309]
        elif order=='uncommitted_vote_first':
            query(writer,"INSERT INTO votes(motion_id,vote) VALUES(309,'Yes')")
            with pytest.raises(psycopg2.errors.LockNotAvailable):
                apply_manifest(database,manifest,lambda:deepcopy(manifest),tmp_path)
            database.rollback();writer.rollback()
            query(database,'SET search_path='+schema)
            assert query(database,'SELECT id FROM motions ORDER BY id')==[{'id':100},{'id':309}]
            assert verify_manifest(database,manifest) is None
        else:
            def regeneration_before_vote_commit():
                query(writer,"INSERT INTO votes(motion_id,vote) VALUES(309,'Yes')")
                writer.commit()
                return deepcopy(manifest)
            with pytest.raises(ValueError,match='Closing linked votes changed'):
                apply_manifest(database,manifest,regeneration_before_vote_commit,tmp_path)
            assert query(database,'SELECT id FROM motions ORDER BY id')==[{'id':100},{'id':309}]
            assert verify_manifest(database,manifest) is None
    finally:
        writer.rollback();writer.close()


@pytest.mark.parametrize('kind',['conflict','blank'])
def test_repeatable_read_cannot_reuse_a_stale_zero_vote_snapshot(database,tmp_path,monkeypatch,kind):
    _,manifest,_=closing_case(database,tmp_path,monkeypatch,kind)
    schema=query(database,'SHOW search_path')[0]['search_path']
    database.commit()
    query(database,'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    query(database,'SET LOCAL search_path='+schema)
    with pytest.raises(ValueError,match='READ COMMITTED'):
        apply_manifest(database,manifest,lambda:deepcopy(manifest),tmp_path)
    assert query(database,'SELECT id FROM motions ORDER BY id')==[{'id':100},{'id':309}]


def test_ordinary_manifest_never_blocks_vote_writers(database,tmp_path):
    from psycopg2.extras import Json
    query(database,"INSERT INTO agenda_items(id,meeting_id,item_order,title) VALUES(100,78,'15','Adjournment')")
    query(database,"INSERT INTO motions(id,meeting_id,agenda_item_id,text_content,result,meta) VALUES(309,78,100,'That the meeting be adjourned.','CARRIED',%s)",(Json({}),))
    manifest=manifest_for(database,tmp_path)
    schema=query(database,'SHOW search_path')[0]['search_path']
    database.commit()
    writer=psycopg2.connect(os.environ['HISTORY_TEST_DATABASE_URL'])
    try:
        query(writer,'SET search_path='+schema);query(writer,"SET lock_timeout='200ms'")
        result=apply_manifest(database,manifest,lambda:deepcopy(manifest),tmp_path)
        assert result['status']=='applied'
        # Main transaction still owns the established ordinary locks here.
        query(writer,"INSERT INTO votes(motion_id,vote) VALUES(309,'Yes')")
        assert query(writer,'SELECT COUNT(*) n FROM votes')[0]['n']==1
    finally:
        writer.rollback();writer.close()
