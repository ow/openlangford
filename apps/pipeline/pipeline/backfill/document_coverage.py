"""Add native source pages to empty document slots without AI or replacement.

The input is an explicit, reviewed list of standalone PDFs. Audit is read-only;
apply rechecks exact source and database snapshots and appends an atomic receipt.
Existing sections stay untouched. One existing whole-file child can be reused
without changing its metadata; uncertain boundaries and sparse text stay held.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import fitz
import psycopg2
from psycopg2.extras import Json, RealDictCursor, execute_values
from dotenv import load_dotenv

from pipeline.ingestion import letter_privacy
from .history_coverage import digest, query, write_report

VERSION = 'native-source-pages-v2-public-email-policy'
MAX_SECTION_CHARS = 7500  # Leaves title space under the embedding pipeline's 8000-character cap.
DOC_FIELDS = ('id', 'meeting_id', 'title', 'category', 'source_url', 'file_path',
              'file_hash', 'full_text', 'page_count', 'municipality_id')
EXTRACT_FIELDS = ('id', 'document_id', 'agenda_item_id', 'title', 'document_type',
                  'page_start', 'page_end', 'summary', 'key_facts', 'municipality_id')
SECTION_FIELDS = ('id', 'document_id', 'extracted_document_id', 'agenda_item_id',
                  'section_title', 'section_text', 'section_order', 'page_start',
                  'page_end', 'token_count', 'municipality_id')


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def source_file(name, roots):
    path = Path(name)
    if (path.is_symlink() or not path.is_file()
            or not any(path.resolve().is_relative_to(root.resolve()) for root in roots)):
        raise ValueError('Source outside reviewed roots or not a regular file')
    return path


def official_url(url):
    parsed = urlsplit(url or '')
    host = (parsed.hostname or '').lower()
    return parsed.scheme == 'https' and (host == 'langford.ca'
        or host.endswith('.langford.ca') or host.endswith('.escribemeetings.com'))


def native_pdf(path):
    """Preserve native words, page order and blank-page provenance; never OCR."""
    raw = path.read_bytes()
    if not raw.startswith(b'%PDF'):
        raise ValueError('Source is not a PDF')
    if len(raw)>25_000_000:
        raise ValueError('PDF exceeds the 25MB source review budget')
    pages, text, sparse = [], [], []
    with fitz.open(path) as document:
        if document.needs_pass:
            raise ValueError('Encrypted PDF is held')
        if not len(document):
            raise ValueError('Empty PDF is held')
        if len(document)>500:
            raise ValueError('PDF exceeds the 500-page source review budget')
        for index, page in enumerate(document):
            body = page.get_text('text', sort=True).strip()
            visible_chars=len(' '.join(body.split()))
            blank = not body and not page.get_images() and not page.get_drawings()
            if not blank and visible_chars < 100:
                sparse.append(index+1)
            pages.append({'page': index+1, 'native_text_sha256': sha(body.encode()),
                          'characters': visible_chars, 'blank': blank})
            if body:
                text.append({'page': index+1, 'text': body})
    return {'source_sha256': sha(raw), 'source_bytes': len(raw),
            'renderer': fitz.VersionBind, 'pages': pages, 'page_count': len(pages),
            'sparse_pages': sparse, 'text_pages': text,
            'full_text': '\n\n'.join(f"[Source page {p['page']}]\n{p['text']}" for p in text)}


def source_sections(text_pages):
    """Bound embedding inputs without dropping characters from reviewed public text."""
    sections=[]
    for page in text_pages:
        body=page['text'];chunks=[];start=0
        while start<len(body):
            stop=min(start+MAX_SECTION_CHARS,len(body))
            if stop<len(body):
                boundary=max(body.rfind('\n',start,stop),body.rfind(' ',start,stop))
                if boundary>=start+MAX_SECTION_CHARS//2:stop=boundary+1
            chunks.append(body[start:stop]);start=stop
        for index,text in enumerate(chunks,1):
            title=f"Source page {page['page']}"+(f' (part {index} of {len(chunks)})' if len(chunks)>1 else '')
            sections.append({'section_title':title,'section_text':text,'section_order':len(sections),
                'page_start':page['page'],'page_end':page['page'],'token_count':int(len(text.split())*1.3)})
    return sections


def listed_attachment(spec, meeting, roots):
    """New registrations require the original agenda's exact attachment identity."""
    if not spec.get('listing_file'):
        return None
    from pipeline.ingestion.escribe_attachments import parse_agenda_attachments
    path = source_file(spec['listing_file'], roots)
    sidecar = Path(str(path)+'.url')
    if not sidecar.is_file() or sidecar.is_symlink() or sidecar.read_text().strip() != meeting['agenda_url']:
        raise ValueError('Original listing URL does not match this meeting')
    base = urlsplit(meeting['agenda_url'] or '')
    supplied = urlsplit(spec.get('source_url') or '')
    doc_ids = parse_qs(supplied.query).get('DocumentId', [])
    if supplied.hostname != base.hostname or len(doc_ids) != 1:
        raise ValueError('Attachment URL is not owned by the original meeting listing')
    choices = [a for a in parse_agenda_attachments(path.read_text()) if a.doc_id == doc_ids[0]]
    if len(choices) != 1:
        raise ValueError('Attachment identity is not unique in the original listing')
    attachment = choices[0]
    return {'file': str(path), 'sha256': sha(path.read_bytes()), 'url': meeting['agenda_url'],
            'url_sidecar_sha256': sha(sidecar.read_bytes()),
            'document_id': attachment.doc_id, 'filename': attachment.filename,
            'item_title': attachment.item_title}


def scope_snapshot(connection, spec, source_sha=None):
    rows = query(connection, '''SELECT * FROM documents WHERE id=%s
        OR (meeting_id=%s AND file_path=%s) OR source_url=%s
        OR (meeting_id=%s AND file_hash=%s) ORDER BY id''',
        (spec.get('document_id'), spec['meeting_id'], spec['file_path'], spec['source_url'],spec['meeting_id'],source_sha))
    ids = [row['id'] for row in rows]
    child = query(connection, 'SELECT * FROM extracted_documents WHERE document_id=ANY(%s) ORDER BY id', (ids,)) if ids else []
    child_ids = [row['id'] for row in child]
    sections = query(connection, '''SELECT id FROM document_sections
        WHERE document_id=ANY(%s) OR extracted_document_id=ANY(%s) ORDER BY id''', (ids, child_ids)) if ids else []
    images = query(connection, 'SELECT id FROM document_images WHERE extracted_document_id=ANY(%s) ORDER BY id', (child_ids,)) if child_ids else []
    return rows, {'documents_sha256': digest(rows), 'extracted_ids': child_ids,'extracted_sha256':digest(child),
                  'section_ids': [row['id'] for row in sections], 'image_ids': [row['id'] for row in images]},child


def exact_agenda_id(listing, items):
    if not listing or not listing['item_title']:
        return None
    normalize = lambda text: ' '.join((text or '').casefold().split())
    choices = [row['id'] for row in items if normalize(row['title']) == normalize(listing['item_title'])]
    return choices[0] if len(choices) == 1 else None


def audit(connection, specs, roots, project_ref, municipality_id):
    if not specs or len(specs) > 30:
        raise ValueError('Select 1–30 explicit standalone sources')
    if any(not {'meeting_id','file_path','source_url','source_file'} <= set(spec) for spec in specs):
        raise ValueError('Each source requires meeting, path, public URL and original file')
    identities = [(s['meeting_id'], s['file_path']) for s in specs]
    if len(set(identities)) != len(specs) or len({s['source_url'] for s in specs})!=len(specs):
        raise ValueError('Duplicate document selection')
    mids = sorted({s['meeting_id'] for s in specs})
    meetings = query(connection, 'SELECT id,municipality_id,agenda_url,meta,updated_at FROM meetings WHERE id=ANY(%s) ORDER BY id', (mids,))
    if len(meetings) != len(mids) or any(m['municipality_id'] != municipality_id for m in meetings):
        raise ValueError('Meeting missing or outside selected municipality')
    if any(m['meta'] is not None and not isinstance(m['meta'], dict) for m in meetings):
        raise ValueError('Non-object meeting metadata requires review')
    if any((m['meta'] or {}).get('document_catchup_receipts') is not None
            and not isinstance(m['meta']['document_catchup_receipts'],dict) for m in meetings):
        raise ValueError('Non-object document receipt namespace requires review')
    agenda = query(connection, 'SELECT id,meeting_id,title FROM agenda_items WHERE meeting_id=ANY(%s) ORDER BY id', (mids,))
    by_meeting = {m['id']: m for m in meetings}
    plans = []
    for spec in specs:
        plan = {'spec': spec, 'status': 'held'}
        try:
            if not official_url(spec.get('source_url')):
                raise ValueError('Source URL is not an official public source')
            path = source_file(spec['source_file'], roots)
            original = native_pdf(path)
            plan['source'] = {k: v for k, v in original.items() if k not in ('full_text', 'text_pages')}
            listing = listed_attachment(spec, by_meeting[spec['meeting_id']], roots)
            if listing:
                plan['listing'] = listing
            rows, snapshot, children = scope_snapshot(connection, spec, original['source_sha256'])
            plan['snapshot'] = snapshot
            reused=None
            if spec.get('document_id'):
                if len(rows) != 1 or rows[0]['id'] != spec['document_id'] or rows[0]['meeting_id'] != spec['meeting_id']:
                    raise ValueError('Existing document identity is not unique in this meeting')
                row = rows[0]
                if row['municipality_id']!=municipality_id:
                    raise ValueError('Document is outside selected municipality')
                if row['file_path'] != spec['file_path'] or row['source_url'] != spec['source_url'] or row['file_hash'] != original['source_sha256']:
                    raise ValueError('Existing document source identity changed')
                if row['full_text'] is not None or any(snapshot[k] for k in ('section_ids','image_ids')):
                    raise ValueError('Existing document content must be preserved')
                if children:
                    if (len(children)!=1 or type(children[0]['page_start']) is not int or type(children[0]['page_end']) is not int
                            or not 1<=children[0]['page_start']<=children[0]['page_end']<=original['page_count']
                            or children[0]['municipality_id']!=municipality_id):
                        raise ValueError('Existing logical-document boundaries require review')
                    reused={k:children[0][k] for k in EXTRACT_FIELDS}
                    if reused['agenda_item_id'] is not None and not any(a['id']==reused['agenda_item_id'] and a['meeting_id']==spec['meeting_id'] for a in agenda):
                        raise ValueError('Existing logical document links outside this meeting')
                if row['page_count'] is not None and row['page_count'] != original['page_count']:
                    raise ValueError('Existing document page count conflicts with original')
                payload = {k: row[k] for k in DOC_FIELDS if k != 'id'}
            else:
                if rows:
                    raise ValueError('Document already registered; select its existing identity explicitly')
                if not listing:
                    raise ValueError('New registration requires original agenda attachment evidence')
                url_sidecar=source_file(str(path)+'.url',roots)
                if url_sidecar.read_text().strip()!=spec['source_url']:
                    raise ValueError('Downloaded PDF URL sidecar does not match its listed source')
                plan['download_url_sha256']=sha(url_sidecar.read_bytes())
                safe = re.sub(r'[^\w.\- ]+', '_', listing['filename'])[:150]
                expected_path = f"Attachments/{listing['document_id']} - {safe}"
                if spec['file_path'] != expected_path:
                    raise ValueError('New registration path differs from the original attachment identity')
                payload = {'meeting_id': spec['meeting_id'], 'title': re.sub(r'\.pdf$', '', listing['filename'], flags=re.I),
                    'category': 'Attachment', 'source_url': spec['source_url'], 'file_path': spec['file_path'],
                    'file_hash': original['source_sha256'], 'municipality_id': municipality_id}
            if original['sparse_pages'] or not original['text_pages']:
                if spec.get('document_id'):
                    raise ValueError('Sparse/image-only pages require OCR review; no complete native extraction')
                payload.update(full_text=None,page_count=original['page_count'])
                plan.update(status='register_only',reason='Native extraction held for sparse/image-only pages',
                    document=payload,agenda_item_id=None,sections=[])
                plans.append(plan)
                continue
            public_full_text=letter_privacy.scrub_emails(original['full_text'])
            public_pages=[{**page,'text':letter_privacy.scrub_emails(page['text'])} for page in original['text_pages']]
            plan['public_text_policy']={
                'policy':'letter_privacy.scrub_emails_non_city_v1',
                'implementation_sha256':sha(Path(letter_privacy.__file__).read_bytes()),
                'removed_email_occurrences':len(letter_privacy.EMAIL.findall(original['full_text']))
                    -len(letter_privacy.EMAIL.findall(public_full_text)),
                'public_full_text_sha256':sha(public_full_text.encode()),
                'source_native_hashes_retained':True}
            if not any(page['text'].strip() for page in public_pages):
                raise ValueError('No usable public text remains after public email privacy redaction')
            payload.update(full_text=public_full_text, page_count=original['page_count'])
            item=exact_agenda_id(listing,[a for a in agenda if a['meeting_id']==spec['meeting_id']])
            if reused:
                plan['reuse_extracted']=reused
                plan['unassigned_source_pages']=[p['page'] for p in original['text_pages']
                    if not reused['page_start']<=p['page']<=reused['page_end']]
                if item is not None and reused['agenda_item_id'] is not None and item!=reused['agenda_item_id']:
                    item=None
                    plan['source_link_state']='existing_logical_document_link_conflict_held'
                elif item is None and reused['page_start']==1 and reused['page_end']==original['page_count'] and reused['agenda_item_id'] is not None:
                    item=reused['agenda_item_id']
                    plan['source_link_state']='preserved_existing_whole_document_link'
            plan.setdefault('source_link_state','exact_literal_title' if item is not None else 'no_unique_literal_title')
            plan.update(status='ready', document=payload,
                agenda_item_id=item,
                sections=source_sections(public_pages))
        except (ValueError, OSError, RuntimeError) as error:
            plan['reason'] = str(error)
        plans.append(plan)
    new_sources = {}
    for plan in plans:
        if not plan['spec'].get('document_id') and plan['status'] in ('ready','register_only'):
            key = (plan['spec']['meeting_id'], plan['source']['source_sha256'])
            new_sources.setdefault(key, []).append(plan)
    for aliases in new_sources.values():
        if len(aliases) > 1:
            for plan in aliases:
                plan.update(status='held', reason='Duplicate PDF bytes in this meeting\'s selected new sources; review aliases')
    return {'version': VERSION, 'project_ref': project_ref, 'municipality_id': municipality_id,
        'source_roots': [str(r.resolve()) for r in roots], 'specs': specs, 'meetings': mids,
        'meetings_sha256': digest(meetings), 'agenda_sha256': digest(agenda), 'documents': plans}


def selected(connection, table, fields, ids):
    return query(connection, f"SELECT {','.join(fields)} FROM {table} WHERE id=ANY(%s) ORDER BY id", (ids,)) if ids else []


def fingerprints(rows):
    return [{'id':row['id'],'sha256':digest(row)} for row in sorted(rows,key=lambda row:row['id'])]


def verify(connection, manifest):
    key = digest(manifest)
    rows = query(connection, "SELECT id,meta->'document_catchup_receipts'->%s as receipt FROM meetings WHERE id=ANY(%s) ORDER BY id", (key, manifest['meetings']))
    if len(rows) != len(manifest['meetings']):
        raise ValueError('Missing batch meeting')
    if not any(row['receipt'] for row in rows):
        return None
    if not all(row['receipt'] for row in rows):
        raise ValueError('Partial receipt state; reconcile read-only')
    for table, fields, label in [('documents',DOC_FIELDS,'documents'),('extracted_documents',EXTRACT_FIELDS,'extracted'),('document_sections',SECTION_FIELDS,'sections')]:
        expected = [record for row in rows for record in row['receipt'][label]]
        actual = selected(connection,table,fields,[row['id'] for row in expected])
        if fingerprints(actual) != sorted(expected,key=lambda row:row['id']):
            raise ValueError('Committed document batch changed; do not retry')
    return {'status':'already_applied','manifest_sha256':key,
        'documents':sum(len(r['receipt']['documents']) for r in rows),
        'extracted_documents':sum(len(r['receipt']['extracted']) for r in rows),
        'new_extracted_documents':sum(len(r['receipt']['extracted'])-len(r['receipt']['reused_extracted_ids']) for r in rows),
        'reused_extracted_documents':sum(len(r['receipt']['reused_extracted_ids']) for r in rows),
        'registered_only_documents':sum(p['status']=='register_only' for r in rows for p in r['receipt']['held']),
        'sections':sum(len(r['receipt']['sections']) for r in rows)}


def insert(connection, table, payload, fields):
    keys = list(payload)
    return query(connection, f"INSERT INTO {table} ({','.join(keys)}) VALUES ({','.join(['%s']*len(keys))}) RETURNING {','.join(fields)}", tuple(payload[k] for k in keys))[0]


def insert_sections(connection, payloads):
    keys=list(payloads[0])
    with connection.cursor(cursor_factory=RealDictCursor) as cursor:
        rows=execute_values(cursor,f"INSERT INTO document_sections ({','.join(keys)}) VALUES %s RETURNING {','.join(SECTION_FIELDS)}",
            [tuple(row[k] for k in keys) for row in payloads],page_size=1000,fetch=True)
        return [dict(row) for row in rows]


def apply(connection, manifest, regenerate, roots):
    prior = verify(connection,manifest)
    if prior:
        return prior
    if digest(regenerate()) != digest(manifest):
        raise ValueError('Document/source/catalog changed; audit and review again')
    ready = [p for p in manifest['documents'] if p['status'] in ('ready','register_only')]
    if not ready:
        return {'status':'no_safe_additions','manifest_sha256':digest(manifest),'documents':0,'extracted_documents':0,
            'new_extracted_documents':0,'reused_extracted_documents':0,'registered_only_documents':0,'sections':0}
    query(connection,'LOCK TABLE documents,extracted_documents,document_sections,document_images,agenda_items IN SHARE ROW EXCLUSIVE MODE NOWAIT')
    query(connection,'SELECT id FROM meetings WHERE id=ANY(%s) ORDER BY id FOR UPDATE',(manifest['meetings'],))
    prior = verify(connection,manifest)
    if prior:
        return prior
    meetings = query(connection,'SELECT id,municipality_id,agenda_url,meta,updated_at FROM meetings WHERE id=ANY(%s) ORDER BY id',(manifest['meetings'],))
    agenda = query(connection,'SELECT id,meeting_id,title FROM agenda_items WHERE meeting_id=ANY(%s) ORDER BY id',(manifest['meetings'],))
    if digest(meetings)!=manifest['meetings_sha256'] or digest(agenda)!=manifest['agenda_sha256']:
        raise ValueError('Current meeting/agenda changed; review again')
    for plan in manifest['documents']:
        if 'snapshot' in plan:
            _, snapshot, _ = scope_snapshot(connection,plan['spec'],plan.get('source',{}).get('source_sha256'))
            if snapshot != plan['snapshot']:
                raise ValueError('Current document/children changed; review again')
        if plan.get('source') and sha(source_file(plan['spec']['source_file'],roots).read_bytes())!=plan['source']['source_sha256']:
            raise ValueError('Original PDF changed; review again')
        if plan.get('listing') and sha(source_file(plan['listing']['file'],roots).read_bytes())!=plan['listing']['sha256']:
            raise ValueError('Original attachment listing changed; review again')
        if plan.get('listing') and sha(source_file(plan['listing']['file']+'.url',roots).read_bytes())!=plan['listing']['url_sidecar_sha256']:
            raise ValueError('Original listing URL changed; review again')
        if plan.get('download_url_sha256') and sha(source_file(plan['spec']['source_file']+'.url',roots).read_bytes())!=plan['download_url_sha256']:
            raise ValueError('Downloaded PDF URL changed; review again')
    receipts = {mid:{'documents':[],'extracted':[],'sections':[],'source_hashes':[],'reused_extracted_ids':[],
        'held':[{'file_path':p['spec']['file_path'],'reason':p.get('reason'),'status':p['status']} for p in manifest['documents'] if p['spec']['meeting_id']==mid and p['status']!='ready'],
        'source_authority':'native_source_pages_only_no_semantic_or_image_inference'} for mid in manifest['meetings']}
    for plan in ready:
        spec=plan['spec']; payload=plan['document']; mid=spec['meeting_id']; item=plan['agenda_item_id']
        if spec.get('document_id'):
            document=query(connection,f"UPDATE documents SET full_text=%s,page_count=COALESCE(page_count,%s) WHERE id=%s AND full_text IS NULL RETURNING {','.join(DOC_FIELDS)}",(payload['full_text'],payload['page_count'],spec['document_id']))
            if len(document)!=1:
                raise ValueError('Document changed during additive write')
            document=document[0]
        else:
            document=insert(connection,'documents',payload,DOC_FIELDS)
        receipts[mid]['documents']+=fingerprints([document])
        receipts[mid]['source_hashes'].append({'document_id':document['id'],
            'source_sha256':plan['source']['source_sha256'],'renderer':plan['source']['renderer'],
            'public_text_policy':plan.get('public_text_policy'),
            'source_link_state':plan.get('source_link_state','source_registration_only_text_held'),
            'unassigned_source_pages':plan.get('unassigned_source_pages',[])})
        if plan['status']=='register_only':
            continue
        extracted=plan.get('reuse_extracted') or insert(connection,'extracted_documents',{'document_id':document['id'],'agenda_item_id':item,
            'title':document['title'],'document_type':'other','page_start':1,'page_end':payload['page_count'],
            'summary':None,'key_facts':None,'municipality_id':manifest['municipality_id']},EXTRACT_FIELDS)
        if plan.get('reuse_extracted'):
            receipts[mid]['reused_extracted_ids'].append(extracted['id'])
        section_rows=[]
        for section in plan['sections']:
            covered=extracted['page_start']<=section['page_start']<=extracted['page_end']
            section_item=item if covered else None
            if (plan.get('reuse_extracted') and item is None and covered
                    and plan['source_link_state']!='existing_logical_document_link_conflict_held'):
                section_item=extracted['agenda_item_id']
            section_rows.append({**section,'document_id':document['id'],
                'extracted_document_id':extracted['id'] if covered else None,'agenda_item_id':section_item,
                'municipality_id':manifest['municipality_id']})
        sections=insert_sections(connection,section_rows)
        receipts[mid]['extracted']+=fingerprints([extracted]);receipts[mid]['sections']+=fingerprints(sections)
    key=digest(manifest)
    for mid,receipt in receipts.items():
        query(connection,"UPDATE meetings SET meta=jsonb_set(COALESCE(meta,'{}'::jsonb),'{document_catchup_receipts}',COALESCE(meta->'document_catchup_receipts','{}'::jsonb)||jsonb_build_object(%s,%s::jsonb)) WHERE id=%s",(key,Json(receipt),mid))
    return {'status':'applied','manifest_sha256':key,'documents':sum(len(r['documents']) for r in receipts.values()),
        'extracted_documents':sum(len(r['extracted']) for r in receipts.values()),
        'new_extracted_documents':sum(len(r['extracted'])-len(r['reused_extracted_ids']) for r in receipts.values()),
        'reused_extracted_documents':sum(len(r['reused_extracted_ids']) for r in receipts.values()),
        'registered_only_documents':sum(p['status']=='register_only' for r in receipts.values() for p in r['held']),
        'sections':sum(len(r['sections']) for r in receipts.values())}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('audit','apply','verify'))
    parser.add_argument('--env-file',type=Path)
    parser.add_argument('--project-ref',required=True)
    parser.add_argument('--municipality-id',type=int,default=1)
    parser.add_argument('--source-root',type=Path,action='append',required=True)
    parser.add_argument('--sources',type=Path)
    parser.add_argument('--manifest',type=Path)
    parser.add_argument('--reviewed-sha256')
    parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args();load_dotenv(args.env_file)
    url=os.environ.get('DATABASE_URL','');parsed=urlsplit(url)
    if not ((parsed.hostname or '').endswith('.pooler.supabase.com') and parsed.username=='postgres.'+args.project_ref) and parsed.hostname!=f'db.{args.project_ref}.supabase.co':
        raise ValueError('Configured database does not match selected project')
    manifest=json.loads(args.manifest.read_text()) if args.manifest else None
    if args.action!='audit':
        if not manifest or digest(manifest)!=args.reviewed_sha256 or manifest['version']!=VERSION or manifest['project_ref']!=args.project_ref or manifest['municipality_id']!=args.municipality_id or manifest['source_roots']!=[str(r.resolve()) for r in args.source_root]:
            raise ValueError('Exact reviewed manifest/project/source roots required')
    specs=manifest['specs'] if manifest else json.loads(args.sources.read_text())
    connection=psycopg2.connect(url,sslmode='require',connect_timeout=10)
    connection.set_session(readonly=args.action!='apply');committing=committed=False
    try:
        query(connection,'SET LOCAL statement_timeout=15000');query(connection,'SET LOCAL lock_timeout=1000')
        regenerate=lambda:audit(connection,specs,args.source_root,args.project_ref,args.municipality_id)
        if args.action=='audit':
            result=regenerate();connection.rollback()
        elif args.action=='verify':
            result=verify(connection,manifest) or {'status':'not_applied','manifest_sha256':digest(manifest)};connection.rollback()
        else:
            result=apply(connection,manifest,regenerate,args.source_root);committing=True;connection.commit();committed=True
        write_report(args.report,result)
        print(json.dumps({'action':args.action,'status':result.get('status','audited'),
            'manifest_sha256':digest(result) if args.action=='audit' else result['manifest_sha256'],'report':str(args.report)}))
    except BaseException:
        if committing:
            print(json.dumps({'status':'committed_receipt_output_failed' if committed else 'uncertain_commit','next':'Run verify read-only; do not repeat apply.'}))
        else:connection.rollback()
        raise
    finally:connection.close()


if __name__=='__main__':
    main()
