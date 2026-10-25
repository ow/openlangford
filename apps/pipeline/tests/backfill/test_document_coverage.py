"""Real PDF and disposable-PostgreSQL proof for additive source-page catch-up."""
from copy import deepcopy
import os
from pathlib import Path
from urllib.parse import urlsplit

import fitz
import psycopg2
import pytest

from pipeline.backfill.document_coverage import audit, apply, verify, sha
from pipeline.backfill.history_coverage import query


def pdf(path,label,raster=False):
    with fitz.open() as document:
        page=document.new_page()
        lines=[f'{label}: original source line {i}, precise amount $12.00, unchanged conditions.' for i in range(8)]
        page.insert_text((30,40),'\n'.join(lines),fontsize=10)
        if raster:
            image=page.get_pixmap().tobytes('png')
            with fitz.open() as scanned:
                scanned.new_page().insert_image(page.rect,stream=image);scanned.save(path)
        else:document.save(path)


@pytest.fixture
def database():
    url=os.environ.get('HISTORY_TEST_DATABASE_URL')
    if not url:pytest.skip('disposable PostgreSQL not configured')
    if urlsplit(url).hostname not in ('localhost','127.0.0.1'):
        pytest.fail('Only a disposable localhost PostgreSQL database is permitted')
    connection=psycopg2.connect(url)
    query(connection,'CREATE SCHEMA document_coverage_test')
    query(connection,'SET LOCAL search_path=document_coverage_test')
    query(connection,'''CREATE TABLE meetings(id int PRIMARY KEY,municipality_id int,
        agenda_url text,meta jsonb,updated_at timestamptz)''')
    query(connection,'''CREATE TABLE agenda_items(id int PRIMARY KEY,meeting_id int REFERENCES meetings(id),title text)''')
    query(connection,'''CREATE TABLE documents(id serial PRIMARY KEY,meeting_id int REFERENCES meetings(id),
        title text,category text,source_url text,file_path text,file_hash text,full_text text,page_count int,
        municipality_id int,embedding text,manual_note text,UNIQUE(meeting_id,file_path))''')
    query(connection,'''CREATE TABLE extracted_documents(id serial PRIMARY KEY,document_id int REFERENCES documents(id),
        agenda_item_id int REFERENCES agenda_items(id),title text,document_type text,page_start int,page_end int,
        summary text,key_facts jsonb,municipality_id int)''')
    query(connection,'''CREATE TABLE document_sections(id serial PRIMARY KEY,document_id int REFERENCES documents(id),
        extracted_document_id int REFERENCES extracted_documents(id),agenda_item_id int REFERENCES agenda_items(id),
        section_title text,section_text text,section_order int,page_start int,page_end int,token_count int,
        municipality_id int,embedding text)''')
    query(connection,'''CREATE TABLE document_images(id serial PRIMARY KEY,extracted_document_id int REFERENCES extracted_documents(id))''')
    for mid in (77,78):
        query(connection,'INSERT INTO meetings VALUES(%s,1,%s,NULL,now())',(mid,f'https://pub-langford.escribemeetings.com/Meeting.aspx?Id=m{mid}'))
    query(connection,"INSERT INTO agenda_items VALUES(100,77,'Road report'),(101,78,'Raster report')")
    yield connection
    connection.rollback();connection.close()


@pytest.fixture
def case(database,tmp_path):
    specs=[]
    for mid,docid,label,filename,raster in [(77,7,'Existing','Existing.pdf',False),
            (77,8,'New','New Report.pdf',False),(78,9,'Raster','Scan.pdf',True)]:
        file=tmp_path/f'{docid}.pdf';pdf(file,label,raster)
        url=f'https://pub-langford.escribemeetings.com/filestream.ashx?DocumentId={docid}'
        Path(str(file)+'.url').write_text(url)
        spec={'meeting_id':mid,'document_id':11 if docid==7 else None,
            'source_file':str(file),'source_url':url,'file_path':f'Attachments/{docid} - {filename}'}
        if docid!=7:
            listing=tmp_path/f'agenda{mid}.html'
            title='Road report' if mid==77 else 'Raster report'
            listing.write_text(f'''<div class="AgendaItem AgendaItem1"><div class="AgendaItemTitle"><a>{title}</a></div>
                <a href="filestream.ashx?DocumentId={docid}">{filename}</a></div>''')
            Path(str(listing)+'.url').write_text(f'https://pub-langford.escribemeetings.com/Meeting.aspx?Id=m{mid}')
            spec['listing_file']=str(listing)
        specs.append(spec)
    query(database,'''INSERT INTO documents(id,meeting_id,title,category,source_url,file_path,file_hash,
        full_text,page_count,municipality_id,embedding,manual_note) VALUES(11,77,'Original title','Attachment',%s,%s,%s,
        NULL,NULL,1,'existing vector','manual evidence')''',
        (specs[0]['source_url'],specs[0]['file_path'],sha(Path(specs[0]['source_file']).read_bytes())))
    return specs,[tmp_path]


def plan(connection,case):
    return audit(connection,case[0],case[1],'test-project',1)


def test_two_new_listed_urls_with_identical_pdf_bytes_cannot_register_duplicates(database,case):
    original=deepcopy(case[0][1])
    alias=deepcopy(original)
    alias_path=Path(original['source_file']).with_name('10.pdf')
    alias_path.write_bytes(Path(original['source_file']).read_bytes())
    alias.update(source_file=str(alias_path),
        source_url='https://pub-langford.escribemeetings.com/filestream.ashx?DocumentId=10',
        file_path='Attachments/10 - Alias Report.pdf')
    Path(str(alias_path)+'.url').write_text(alias['source_url'])
    Path(original['listing_file']).write_text('''<div class="AgendaItem AgendaItem1">
        <div class="AgendaItemTitle"><a>Road report</a></div>
        <a href="filestream.ashx?DocumentId=8">New Report.pdf</a>
        <a href="filestream.ashx?DocumentId=10">Alias Report.pdf</a></div>''')
    selected_case=([original,alias],case[1])
    manifest=plan(database,selected_case)
    result=apply(database,manifest,lambda:plan(database,selected_case),case[1])
    assert result['status']=='no_safe_additions'
    assert [p['status'] for p in manifest['documents']]==['held','held']
    assert all('Duplicate PDF bytes' in p['reason'] for p in manifest['documents'])
    assert query(database,'SELECT id FROM documents')==[{'id':11}]
    assert query(database,'SELECT * FROM extracted_documents')==[]
    assert query(database,'SELECT * FROM document_sections')==[]
    assert query(database,'SELECT meta FROM meetings ORDER BY id')==[{'meta':None}]*2


def test_additive_pages_registration_only_and_receipt_retry_preserve_existing_content(database,case):
    manifest=plan(database,case)
    assert [p['status'] for p in manifest['documents']]==['ready','ready','register_only']
    result=apply(database,manifest,lambda:plan(database,case),case[1])
    assert (result['documents'],result['extracted_documents'],result['sections'],result['registered_only_documents'])==(3,2,2,1)
    old=query(database,'SELECT * FROM documents WHERE id=11')[0]
    assert 'Existing: original source line 0, precise amount $12.00, unchanged conditions.' in old['full_text']
    assert old['embedding']=='existing vector' and old['manual_note']=='manual evidence' and old['title']=='Original title'
    new=query(database,"SELECT * FROM documents WHERE file_path='Attachments/8 - New Report.pdf'")[0]
    section=query(database,'SELECT * FROM document_sections WHERE document_id=%s',(new['id'],))[0]
    assert section['agenda_item_id']==100 and section['page_start']==section['page_end']==1
    assert section['section_text'].startswith('New: original source line 0')
    assert query(database,'SELECT summary,key_facts FROM extracted_documents')==[{'summary':None,'key_facts':None}]*2
    raster=query(database,"SELECT * FROM documents WHERE file_path='Attachments/9 - Scan.pdf'")[0]
    assert raster['page_count']==1 and raster['full_text'] is None
    assert query(database,'SELECT * FROM extracted_documents WHERE document_id=%s',(raster['id'],))==[]
    def already_committed():raise AssertionError('Committed retry must check receipt before parsing')
    assert apply(database,manifest,already_committed,case[1])['status']=='already_applied'
    receipt=query(database,"SELECT meta->'document_catchup_receipts' as receipt FROM meetings WHERE id=77")[0]['receipt']
    assert 'original source line' not in str(receipt)
    query(database,"UPDATE documents SET embedding='refreshed separately' WHERE id=11")
    assert verify(database,manifest)['documents']==3
    query(database,'UPDATE document_sections SET agenda_item_id=NULL WHERE id=%s',(section['id'],))
    with pytest.raises(ValueError,match='Committed document batch changed'):verify(database,manifest)


@pytest.mark.parametrize('change',['parent','child','pdf','listing_url','download_url','collision'])
def test_change_after_parsing_rejects_before_any_source_content_write(database,case,change):
    manifest=plan(database,case);specs,roots=case
    if change=='parent':query(database,"UPDATE documents SET manual_note='changed' WHERE id=11")
    elif change=='child':query(database,"INSERT INTO extracted_documents(document_id,title) VALUES(11,'existing good child')")
    elif change=='pdf':Path(specs[0]['source_file']).write_bytes(Path(specs[0]['source_file']).read_bytes()+b'changed')
    elif change=='listing_url':Path(specs[1]['listing_file']+'.url').write_text('https://langford.ca/other-meeting')
    elif change=='download_url':Path(specs[1]['source_file']+'.url').write_text('https://langford.ca/other.pdf')
    else:query(database,"INSERT INTO documents(meeting_id,source_url,file_path) VALUES(78,%s,'collision.pdf')",(specs[1]['source_url'],))
    with pytest.raises(ValueError):apply(database,manifest,lambda:deepcopy(manifest),roots)
    assert query(database,'SELECT full_text FROM documents WHERE id=11')[0]['full_text'] is None
    assert query(database,'SELECT * FROM document_sections')==[]


def test_existing_children_are_never_replaced_and_ambiguous_title_stays_unassociated(database,case):
    query(database,"INSERT INTO extracted_documents(document_id,title,summary) VALUES(11,'keep','manually reviewed')")
    query(database,"INSERT INTO agenda_items VALUES(102,77,'Road report')")
    manifest=plan(database,case)
    assert manifest['documents'][0]['status']=='held'
    assert manifest['documents'][1]['agenda_item_id'] is None
    apply(database,manifest,lambda:plan(database,case),case[1])
    assert query(database,'SELECT title,summary FROM extracted_documents WHERE document_id=11')==[{'title':'keep','summary':'manually reviewed'}]
    assert query(database,'SELECT full_text FROM documents WHERE id=11')[0]['full_text'] is None


def test_whole_file_boundary_metadata_is_reused_without_replacement(database,case):
    query(database,"""INSERT INTO extracted_documents(document_id,agenda_item_id,title,document_type,page_start,page_end,
        summary,key_facts,municipality_id) VALUES(11,100,'Reviewed report','staff_report',1,1,'keep reviewed summary','["keep fact"]',1)""")
    before=query(database,'SELECT * FROM extracted_documents WHERE document_id=11')
    manifest=plan(database,case)
    assert manifest['documents'][0]['status']=='ready'
    result=apply(database,manifest,lambda:plan(database,case),case[1])
    assert result['reused_extracted_documents']==1 and result['new_extracted_documents']==1
    assert query(database,'SELECT * FROM extracted_documents WHERE document_id=11')==before
    assert query(database,'SELECT extracted_document_id FROM document_sections WHERE document_id=11')==[{'extracted_document_id':before[0]['id']}]
    assert verify(database,manifest)['reused_extracted_documents']==1


def test_late_receipt_failure_rolls_back_documents_sections_and_updates(database,case):
    manifest=plan(database,case)
    query(database,'SAVEPOINT before_apply')
    query(database,'ALTER TABLE meetings ADD CONSTRAINT no_second_receipt CHECK(id<>78 OR meta IS NULL)')
    with pytest.raises(psycopg2.IntegrityError):apply(database,manifest,lambda:deepcopy(manifest),case[1])
    query(database,'ROLLBACK TO SAVEPOINT before_apply')
    assert len(query(database,'SELECT * FROM documents'))==1
    assert query(database,'SELECT full_text FROM documents WHERE id=11')[0]['full_text'] is None
    assert query(database,'SELECT * FROM extracted_documents')==[]
    assert query(database,'SELECT * FROM document_sections')==[]
    assert verify(database,manifest) is None


def test_raster_existing_source_is_held_without_text_or_image_inference(database,case):
    spec=case[0][0];pdf(Path(spec['source_file']),'Image only',raster=True)
    query(database,'UPDATE documents SET file_hash=%s WHERE id=11',(sha(Path(spec['source_file']).read_bytes()),))
    manifest=audit(database,[spec],case[1],'test-project',1)
    assert manifest['documents'][0]['status']=='held'
    assert manifest['documents'][0]['source']['sparse_pages']==[1]
    assert apply(database,manifest,lambda:deepcopy(manifest),case[1])['status']=='no_safe_additions'
    assert query(database,'SELECT full_text FROM documents WHERE id=11')[0]['full_text'] is None


@pytest.mark.parametrize('change',['municipality','listing_document','public_url','same_pdf'])
def test_scope_and_listing_evidence_cannot_register_unreviewed_sources(database,case,change):
    specs,roots=deepcopy(case)
    if change=='municipality':
        with pytest.raises(ValueError,match='municipality'):audit(database,specs,roots,'test-project',2)
        return
    if change=='listing_document':Path(specs[1]['listing_file']).write_text('<p>No attachment here</p>')
    elif change=='same_pdf':Path(specs[1]['source_file']).write_bytes(Path(specs[0]['source_file']).read_bytes())
    else:specs[1]['source_url']='https://unrelated.example/report.pdf'
    manifest=audit(database,specs,roots,'test-project',1)
    assert manifest['documents'][1]['status']=='held'
    assert query(database,'SELECT * FROM documents WHERE id<>11')==[]


def test_blank_page_is_accounted_without_synthesizing_source_text(database,case,tmp_path):
    spec=case[0][0];path=Path(spec['source_file'])
    with fitz.open(path) as original:
        original.new_page();original.save(tmp_path/'blank-last-page.pdf')
    path.write_bytes((tmp_path/'blank-last-page.pdf').read_bytes())
    query(database,'UPDATE documents SET file_hash=%s WHERE id=11',(sha(path.read_bytes()),))
    manifest=audit(database,[spec],case[1],'test-project',1)
    assert manifest['documents'][0]['status']=='ready'
    assert manifest['documents'][0]['document']['page_count']==2
    result=apply(database,manifest,lambda:deepcopy(manifest),case[1])
    assert result['sections']==1
    assert query(database,'SELECT page_start,page_end FROM document_sections')==[{'page_start':1,'page_end':1}]


def test_existing_document_tenant_is_not_inferred_from_parent_meeting(database,case):
    query(database,'UPDATE documents SET municipality_id=2 WHERE id=11')
    manifest=plan(database,case)
    assert manifest['documents'][0]['status']=='held'
    assert 'municipality' in manifest['documents'][0]['reason']


def test_partial_existing_boundary_keeps_unassigned_pages_outside_child_and_agenda(database,case,tmp_path):
    spec=case[0][0];path=Path(spec['source_file'])
    with fitz.open(path) as document:
        page=document.new_page();page.insert_text((30,40),'\n'.join('Appendix source words remain independent of the earlier logical report.' for _ in range(8)),fontsize=10)
        document.save(tmp_path/'with-appendix.pdf')
    path.write_bytes((tmp_path/'with-appendix.pdf').read_bytes())
    query(database,'UPDATE documents SET file_hash=%s WHERE id=11',(sha(path.read_bytes()),))
    query(database,"""INSERT INTO extracted_documents(document_id,agenda_item_id,title,page_start,page_end,
        summary,municipality_id) VALUES(11,100,'Reviewed first-page report',1,1,'keep boundary and summary',1)""")
    before=query(database,'SELECT * FROM extracted_documents WHERE document_id=11')
    manifest=audit(database,[spec],case[1],'test-project',1)
    assert manifest['documents'][0]['unassigned_source_pages']==[2]
    apply(database,manifest,lambda:deepcopy(manifest),case[1])
    assert query(database,'SELECT * FROM extracted_documents WHERE document_id=11')==before
    assert query(database,'SELECT page_start,extracted_document_id,agenda_item_id FROM document_sections ORDER BY section_order')==[
        {'page_start':1,'extracted_document_id':before[0]['id'],'agenda_item_id':100},
        {'page_start':2,'extracted_document_id':None,'agenda_item_id':None}]


def test_layout_padding_is_not_usable_native_text(database,case,tmp_path):
    spec=case[0][0];path=Path(spec['source_file'])
    with fitz.open() as document:
        page=document.new_page()
        for y in (40,80,120):
            page.insert_text((30,y),'left',fontsize=8);page.insert_text((540,y),'right',fontsize=8)
        assert len(page.get_text('text',sort=True).strip())>100
        document.save(tmp_path/'padded-labels.pdf')
    path.write_bytes((tmp_path/'padded-labels.pdf').read_bytes())
    query(database,'UPDATE documents SET file_hash=%s WHERE id=11',(sha(path.read_bytes()),))
    manifest=audit(database,[spec],case[1],'test-project',1)
    assert manifest['documents'][0]['status']=='held'
    assert manifest['documents'][0]['source']['sparse_pages']==[1]


def test_dense_native_page_is_chunked_without_embedding_truncation_or_lost_characters(database,case,tmp_path):
    spec=case[0][0];path=Path(spec['source_file'])
    lines=[f'{i:03} Original source records retain exact amounts and every condition, rather than a truncated prefix. ' * 2 for i in range(95)]
    lines.append('LAST_SOURCE_MARKER')
    original='\n'.join(lines)
    with fitz.open() as document:
        page=document.new_page();page.insert_text((20,30),original,fontsize=4)
        document.save(tmp_path/'dense-source.pdf')
    path.write_bytes((tmp_path/'dense-source.pdf').read_bytes())
    query(database,'UPDATE documents SET file_hash=%s WHERE id=11',(sha(path.read_bytes()),))
    manifest=audit(database,[spec],case[1],'test-project',1)
    assert len(manifest['documents'][0]['sections'])>1
    apply(database,manifest,lambda:deepcopy(manifest),case[1])
    sections=query(database,'SELECT section_title,section_text,page_start,page_end FROM document_sections ORDER BY section_order')
    assert all(len(s['section_title']+'\n'+s['section_text'])<=8000 for s in sections)
    assert ' '.join(''.join(s['section_text'] for s in sections).split())==' '.join(original.split())
    assert all(s['page_start']==s['page_end']==1 for s in sections)
