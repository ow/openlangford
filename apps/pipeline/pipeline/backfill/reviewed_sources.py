"""Explicit original-image/source reviews for deterministic catch-up only.

Scans stay scans. Reviewed OCR never becomes official HTML/native PDF text,
attendance or ballot authority. Original files are never rewritten.
"""
import hashlib
import json
from pathlib import Path
import subprocess

import fitz

from pipeline.ingestion.source_claims import digest
from pipeline.ingestion.official_ballots import minutes_text_source
from pipeline.ingestion.canonical_motions import source_identity

STORE = Path(__file__).parent / 'data' / 'source-reviews'
ENROLLED = {
    42: 'd7670a977e457a0a7af2e3908bb3983d60ffa1d9556eff7ccf461b1d0eba910d',
    223: 'fdbfb0bbe762ca77e9ec466765df0b4ab8fa3a9e806e6768b644a502cd63df1b',
    142: '1308caf3740b882b31070c148aa28bc25099c3ee6b162fdd0134f532231c4e31',
    270: '86bab9faf3fadd49fbeabe2999b6a83c9b9ac0f8a1bebfff390647ec99ecb2b2',
    204: '7745f7963a821c5bdfb0f0cd19b3fb2afe59d8847d945540bab695f297da5dde',
    279: '56079e9785e1133fdc49ee757f9d476f3383797779e0ce8c75326b35a5543b23',
    73: 'ed59d1a4ab6c44a124ed9dafcfb2072d07c2accbbaf44ac6a30dce969b953f3c',
    119: '7d025e020b485fb6cf0f53650b425708b3a8ac08578c08f32b0a0ae513faf7cd',
    217: 'a34c18f51ddae5a218078850d1bb1619923a6d64dd276cc60c4f7180f0e718c2',
    303: 'ce234e2aaf8ce032ee1d5f97f593229d55eed4c0842ce9d6fab90207dca5ed56',
    123: '29347cdade7c6905337d1a62360784cf18dcb429a8ad9a56c9c3a2d58d6c4e4e',
    86: '433959b2389fecf540475f4713bdd369486c5aee3fea501d99c730f967cae035',
    125: 'f0c2cc7b09696130b1b8f65115d2c2291580301f3f1cd6faf823a5fd5e6e599f',
    282: '201f37a3898585f87d5151e89c9ca646d43932e0424d66b8db4b968ea99942b6',
    144: '1b89118050d37b2e548acefbe88a295c581d3d9b1e1711fbc27412efa7ca4240',
}


def sha(value):
    return hashlib.sha256(value).hexdigest()


def bound_file(root, name, expected):
    path = root / name
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()) or sha(path.read_bytes()) != expected:
        raise ValueError('Reviewed source file changed')
    return path


def source_inventory(root, meeting):
    folder = root / meeting['archive_path'] / 'Minutes'
    if not folder.resolve().is_relative_to(root.resolve()):
        raise ValueError('Source inventory escapes archive root')
    entries=[]
    for path in sorted(folder.glob('*')):
        if path.suffix.lower() not in ('.pdf','.html'):
            continue
        if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError('Untrusted original source path')
        sidecar=Path(str(path)+'.url')
        if sidecar.is_symlink():
            raise ValueError('Untrusted original URL sidecar')
        entries.append({'file':str(path.relative_to(root)), 'sha256':sha(path.read_bytes()),
                        'url':sidecar.read_text().strip() if sidecar.exists() else None})
    return entries


def validate_source_review(review, *, meeting, root, project_ref, municipality_id):
    if (review['schema'] != 'reviewed-original-minutes-v1' or review['project_ref'] != project_ref
            or review['municipality_id'] != municipality_id
            or any(meeting.get(k) != v for k,v in review['catalog'].items())
            or sorted(review['file_inventory'],key=lambda r:r['file']) != source_inventory(root,meeting)):
        raise ValueError('Reviewed source catalog/inventory changed')
    for file in review['file_inventory']:
        bound_file(root,file['file'],file['sha256'])
    if review['review_status'] != 'independently_reviewed_original_source':
        raise ValueError('Original source review not complete')


def source_from_review(review, *, meeting, root, people, cache_dir, project_ref, municipality_id):
    validate_source_review(review,meeting=meeting,root=root,project_ref=project_ref,municipality_id=municipality_id)
    proof = {'review_sha256':digest(review),'mode':review['mode'],'authority':'deterministic_catchup_only',
             'file_inventory':review['file_inventory'], 'catalog':review['catalog']}
    if review['mode']=='no_decisions_expected':
        notice=review['notice'];bound_file(root,notice['file'],notice['sha256'])
        return {'error':'no_decisions_expected_from_original_notice', 'notice':notice,
                'source_file':notice['file'],'source_sha256':notice['sha256'],'source_url':notice['url'],
                'source_review_evidence':proof}
    path=bound_file(root,review['selected_file'],review['source_sha256'])
    if review['mode']=='reviewed_scan':
        if fitz.VersionBind!=review['pymupdf_version']:
            raise ValueError('Reviewed scan renderer changed')
        helper=Path(__file__).parents[1]/'ingestion'/'native_header_vision.swift'
        if sha(helper.read_bytes())!=review['helper_source_sha256']:
            raise ValueError('Reviewed OCR helper changed')
        with fitz.open(path) as document:
            if [p['page'] for p in review['pages']]!=list(range(1,len(document)+1)):
                raise ValueError('Reviewed scan pages incomplete')
            for page in review['pages']:
                image=document[page['page']-1].get_pixmap(matrix=fitz.Matrix(review['render_scale'],review['render_scale']))
                if (sha(image.tobytes('png'))!=page['render_sha256'] or page['source_sha256']!=review['source_sha256']
                        or page['source_url']!=review['source_url'] or page['render_scale']!=review['render_scale']
                        or page['ocr']['engine']!='macOS Vision VNRecognizeTextRequest' or page['ocr']['vision_revision']!=3):
                    raise ValueError('Reviewed scan image/OCR provenance changed')
        text=review['reviewed_text'];source_format='original_pdf_reviewed_local_ocr'
    else:
        with fitz.open(path) as document:
            if sha(document[0].get_text().encode())!=review['native_first_page_sha256']:
                raise ValueError('Reviewed native header changed')
        text=subprocess.run(['pdftotext','-layout',str(path),'-'],check=True,capture_output=True,text=True,timeout=40).stdout
        source_format='original_pdf_layout'
        if review['mode']=='reviewed_native_image_corrections':
            if fitz.VersionBind!=review['pymupdf_version'] or sha(text.encode())!=review['native_layout_sha256']:
                raise ValueError('Reviewed native extraction changed')
            native_pages=text.split('\f')
            with fitz.open(path) as document:
                if [p['page'] for p in review['pages']]!=list(range(1,len(document)+1)):
                    raise ValueError('Reviewed native image pages incomplete')
                for page in review['pages']:
                    original=document[page['page']-1]
                    render=original.get_pixmap(matrix=fitz.Matrix(review['render_scale'],review['render_scale']))
                    if (sha(original.get_text().encode())!=page['native_text_sha256']
                            or sha(render.tobytes('png'))!=page['render_sha256']):
                        raise ValueError('Reviewed native image evidence changed')
            for correction in review['text_corrections']:
                page=correction['page'];before=correction['native_quote']
                if (correction['authority']!='original_image_text_correction_only'
                        or type(page) is not int or page<1 or page>len(review['pages'])
                        or not before or native_pages[page-1].count(before)!=1 or text.count(before)!=1):
                    raise ValueError('Reviewed native correction is not uniquely page-bound')
                text=text.replace(before,correction['reviewed_quote'],1)
            if sha(text.encode())!=review['corrected_text_sha256']:
                raise ValueError('Reviewed image-corrected text changed')
            source_format='original_pdf_reviewed_image_corrections'
    source=minutes_text_source(meeting,root=root,people=people,cache_dir=cache_dir,path=path,text=text,
                               source_format=source_format,source_sha256=review['source_sha256'])
    if source.get('error'):
        return source
    if source['source_url']!=review['source_url']:
        raise ValueError('Reviewed original public URL changed')
    source['source_review_evidence']=proof
    if review.get('header_date'):
        source['local_date']=review['header_date']['date']
        source['source_date_evidence']={'method':'reviewed_original_image_header_date',**review['header_date'],**proof}
        from pipeline.ingestion.operative_motion_body import derive_operative_motion_views
        views=derive_operative_motion_views(source['blocks'],source_file=path,source_sha256=source['source_sha256'],source_date=source['local_date'])
        source['operative_views']={f"{b['source_offset']}:{b['source_order']}":v for b,v in zip(source['blocks'],views)}
    if review.get('committee_scope'):
        source.update(reviewed_committee_scope=review['committee_scope'],present=[],header_attendance=None,
                      roster_unknown=['committee_scope_review_does_not_certify_roster'])
    if review['mode']=='reviewed_native_image_corrections':
        if digest(source['blocks'])!=review['parsed_blocks_sha256']:
            raise ValueError('Reviewed image-corrected occurrences changed')
        # Apply after any header-derived views. This view accounts for existing
        # legacy occurrences only; it cannot certify new text, results, actors,
        # attendance or individual ballots.
        source.update(operative_views={},present=[],header_attendance=None,
                      roster_unknown=['image_corrections_not_new_fact_or_ballot_authority'])
        proof['authority']='legacy_occurrence_accounting_only'
    if review['mode']=='reviewed_scan':
        if digest(source['blocks'])!=review['parsed_blocks_sha256'] or sha(source['text'].encode())!=review['source_text_sha256']:
            raise ValueError('Reviewed scan parsing changed')
        accepted={entry['source_key']:entry for entry in review['accepted_decisions']}
        if len(accepted)!=len(review['accepted_decisions']):
            raise ValueError('Duplicate reviewed scan occurrence')
        views={}
        for block in source['blocks']:
            identity=source_identity(meeting['id'],source,block);entry=accepted.get(identity['key'])
            view={'source_sha256':source['source_sha256'],'raw_block':block,'status':'scan_body_not_independently_reviewed_held'}
            if entry:
                pages=entry['pages']
                if (digest(block)!=entry['raw_block_sha256'] or entry['result']!=block['result']
                        or not pages or any(type(p) is not int for p in pages)
                        or pages!=list(range(pages[0],pages[-1]+1))
                        or pages[0]<1 or pages[-1]>len(review['pages'])):
                    raise ValueError('Reviewed scan decision changed')
                if len(pages)>1:
                    span=entry.get('span_review',{})
                    reviewer=span.get('review_sha256','')
                    evidence=[{'page':p,'render_sha256':review['pages'][p-1]['render_sha256'],
                               'ocr_sha256':digest(review['pages'][p-1]['ocr'])} for p in pages]
                    if (span.get('status')!='independently_reviewed_complete_motion_span'
                            or not isinstance(reviewer,str) or len(reviewer)!=64
                            or any(c not in '0123456789abcdef' for c in reviewer)
                            or span.get('operative_body_sha256')!=sha(entry['operative_body'].encode())
                            or span.get('page_evidence')!=evidence):
                        raise ValueError('Complete cross-page source review required')
                view.update(status='explicit_operative',version='reviewed-original-image-ocr-body-v1',
                            operative_body=entry['operative_body'],match_aliases=[],excluded_spans=[],
                            original_image_review={'review_sha256':digest(review),'pages':entry['pages'],
                                                   'corrections':entry.get('corrections',[]),'authority':'operative_body_and_result_only',
                                                   **({'span_review':entry['span_review']} if len(pages)>1 else {})})
            views[f"{block['source_offset']}:{block['source_order']}"]=view
        if len(accepted)!=sum(v['status']=='explicit_operative' for v in views.values()):
            raise ValueError('Reviewed scan occurrence not found')
        source.update(operative_views=views,present=[],header_attendance=None,
                      source_date_evidence={'method':'reviewed_original_scan_header','review_sha256':digest(review),
                                            'raw_ocr_header':source['source_header']},
                      roster_unknown=['scan_not_attendance_or_ballot_authority'],
                      source_review_holds=review.get('remaining_holds',[]))
    return source


def load_reviewed_minutes(meeting, *, root, people, cache_dir, project_ref, municipality_id):
    if meeting['id'] not in ENROLLED:
        return None
    try:
        path=STORE/f"{meeting['id']}.json"
        if STORE.is_symlink() or path.is_symlink() or not path.resolve().is_relative_to(STORE.resolve()):
            raise ValueError('Untrusted source review path')
        raw=path.read_bytes()
        if sha(raw)!=ENROLLED[meeting['id']]:
            raise ValueError('Enrolled source review changed')
        return source_from_review(json.loads(raw),meeting=meeting,root=root,people=people,cache_dir=cache_dir,
                                  project_ref=project_ref,municipality_id=municipality_id)
    except (ValueError,OSError,KeyError,RuntimeError,subprocess.SubprocessError) as error:
        return {'error':'reviewed_original_source_held','reason':str(error)}
