"""Lossless operative views; raw source identity and ballot proof are immutable."""
from copy import deepcopy
from datetime import datetime
import hashlib
from pathlib import Path
import re

import fitz

VERSION = 'native-operative-body-v2'
_DATE = re.compile(r'(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(st|nd|rd|th)?\s*,\s*(20\d{2})', re.I)
_EVENT = r'(?:Mayor [A-Z][A-Za-z’\'-]+|The (?:Chair|Mayor)|Acting Mayor [A-Z]\. [A-Z][A-Za-z’\'-]+) adjourned the meeting at (?:[1-9]|1[0-2]):[0-5][0-9]\s*(?:a\.?m\.?|p\.?m\.?)\.?'
_ADJOURN = re.compile(r'(THAT (?:Council|the Committee) adjourn the meeting\.)\s+('+_EVENT+r')', re.I)


def _compact(text):
    return ''.join(c.casefold() for c in text if c.isalnum())


def _native_lines(document):
    lines = []
    for index, page in enumerate(document):
        for group in page.get_text('dict', flags=fitz.TEXTFLAGS_DICT & ~fitz.TEXT_PRESERVE_IMAGES)['blocks']:
            for line in group.get('lines', []):
                text = ''.join(span['text'] for span in line['spans']).strip()
                if text:
                    lines.append({'quote': text, 'page': index+1, 'bbox': list(line['bbox']), 'page_rect': list(page.rect)})
    return sorted(lines, key=lambda line:(line['page'], line['bbox'][1], line['bbox'][0]))


def _bound_body(body, lines):
    stream, owners = '', []
    ordered=list(enumerate(lines))
    # Native list labels may be a separate PDF line whose baseline differs by
    # thousandths of a point. Restore only a left-hand alphabetic label on
    # the same physical baseline; preserve every label and every body word.
    for position in range(1,len(ordered)):
        _,label=ordered[position];_,text=ordered[position-1]
        if (re.fullmatch(r'[a-z]\.',label['quote']) and label['page']==text['page']
                and label['bbox'][2]<text['bbox'][0]
                and abs(label['bbox'][1]-text['bbox'][1])<.1
                and abs(label['bbox'][3]-text['bbox'][3])<.1):
            ordered[position-1],ordered[position]=ordered[position],ordered[position-1]
    for index, line in ordered:
        # Ordinary loader already excludes minutes titles and page-only digits.
        if re.match(r'Minutes of\b', line['quote'], re.I) or line['quote'].isdigit():
            continue
        compact = _compact(line['quote'])
        stream += compact
        owners.extend([index]*len(compact))
    target = _compact(body)
    if not target or stream.count(target) != 1:
        return None
    start = stream.index(target)
    matched_owners=owners[start:start+len(target)]
    return min(matched_owners), max(matched_owners)


def _printed_date(quote):
    match = _DATE.fullmatch(quote)
    if not match:
        return None
    month, day, suffix, year = match.groups()
    day = int(day)
    correct = 'th' if 11 <= day % 100 <= 13 else {1:'st', 2:'nd', 3:'rd'}.get(day % 10, 'th')
    if suffix and suffix.lower() != correct:
        return None
    try:
        return datetime.strptime(f'{month} {day} {year}', '%B %d %Y').date().isoformat()
    except ValueError:
        return None


def _header_spans(body, lines, source_date, page_count):
    found = []
    for index, line in enumerate(lines):
        if line['page'] <= 1 or _printed_date(line['quote']) != source_date:
            continue
        width, height = line['page_rect'][2:]
        if line['bbox'][0] < width*.60 or line['bbox'][3] > height*.12 or index+1 >= len(lines):
            continue
        count = lines[index+1]
        if count['page'] != line['page'] or count['quote'] != f"Page {line['page']} of {page_count}":
            continue
        if count['bbox'][0] < width*.60 or count['bbox'][3] > height*.12 or not (line['bbox'][3] <= count['bbox'][1] <= line['bbox'][3]+15):
            continue
        title = [p for p in lines[max(0,index-2):index] if p['page']==line['page'] and re.match(r'Minutes of\b',p['quote'],re.I) and p['bbox'][3]<=line['bbox'][1] and p['bbox'][0]>=width*.5]
        if len(title) != 1 or body.count(line['quote']) != 1 or body.count(count['quote']) != 1:
            continue
        first, second = body.index(line['quote']), body.index(count['quote'])
        if second < first+len(line['quote']) or body[first+len(line['quote']):second].strip():
            continue
        for item in (line, count):
            at = body.index(item['quote'])
            found.append({'body_start':at,'body_end':at+len(item['quote']),'quote':item['quote'],'kind':'page_decoration','geometry':item,'basis':'native_top_right_running_header_same_actual_date_and_page_count'})
    return found


def _footer_spans(body, lines, bounds, page_count):
    """Only an isolated actual page digit plus underscore in its footer zone."""
    found=[]
    if page_count < 2:
        return found
    for line in lines[bounds[0]:bounds[1]+1]:
        quote=line['quote'];width,height=line['page_rect'][2:]
        if quote != f"{line['page']}_" or line['bbox'][0] < width*.85 or line['bbox'][1] < height*.90:
            continue
        matches=list(re.finditer(r'(?m)^[ \t]*'+re.escape(quote)+r'[ \t]*$',body))
        if len(matches)!=1:
            continue
        match=matches[0];start=body.index(quote,match.start(),match.end())
        found.append({'body_start':start,'body_end':start+len(quote),'quote':quote,
                      'kind':'page_decoration','geometry':line,
                      'basis':'isolated_native_actual_page_digit_underscore_in_bottom_right_footer'})
    return found


def _lexical_alias(body, lines, bounds):
    """Bounded lexical spellings, with raw spans; no identifier or digit repair."""
    rules=[
        (r'(?<=\d)m2(?=\s+of\s+gross\s+floor\s+area\b)', 'm²', 'square_metre_unit_typography'),
        (r'\bFiveYear(?=\s+Financial\s+Plan\b)', 'Five Year', 'financial_plan_word_segmentation'),
        (r'(?<=Administrative Assistant - )Bylawto(?=\s+regular\s+full-time\b)', 'Bylaw to', 'job_title_to_preposition_segmentation'),
    ]
    spans=[]
    for pattern,replacement,basis in rules:
        for match in re.finditer(pattern,body):
            # This raw phrase must be on an actual line inside the uniquely
            # bound complete body. Receipts never replace raw source keys.
            geometry=[line for line in lines[bounds[0]:bounds[1]+1] if match[0] in line['quote']]
            if len(geometry)!=1:
                continue
            spans.append({'body_start':match.start(),'body_end':match.end(),'quote':match[0],
                          'alias':replacement,'basis':basis,'geometry':geometry[0]})
    alias=body
    for span in sorted(spans,key=lambda s:s['body_start'],reverse=True):
        alias=alias[:span['body_start']]+span['alias']+alias[span['body_end']:]
    return alias,spans


def _empty_view(block, source_sha256):
    return {'version':VERSION,'source_sha256':source_sha256,'raw_block':deepcopy(block),'operative_body':None,'excluded_spans':[],'motion_kind':None,'context':[],'match_aliases':[],'lexical_spans':[],'status':'source_unavailable_held'}


def derive_operative_motion_views(blocks, *, source_file, source_sha256, source_date):
    """Extract native geometry once per binary; never decode embedded images."""
    try:
        binary = Path(source_file).read_bytes()
        if hashlib.sha256(binary).hexdigest() != source_sha256:
            return [{**_empty_view(block, source_sha256),'status':'source_hash_conflict_held'} for block in blocks]
        with fitz.open(stream=binary, filetype='pdf') as document:
            lines, page_count = _native_lines(document), len(document)
    except (OSError, RuntimeError, ValueError):
        return [_empty_view(block, source_sha256) for block in blocks]
    return [_derive_from_native(block, source_sha256=source_sha256, source_date=source_date,
                                lines=lines, page_count=page_count) for block in blocks]


def derive_operative_motion_body(block, *, source_file, source_sha256, source_date):
    """Derive typed exact exclusions; never edit a block or certify a ballot."""
    return derive_operative_motion_views([block], source_file=source_file,
        source_sha256=source_sha256, source_date=source_date)[0]


def _derive_from_native(block, *, source_sha256, source_date, lines, page_count):
    body, witness = block['motion_text'], block['source_block']
    result = _empty_view(block, source_sha256)
    if witness.count(body) != 1:
        return {**result,'status':'raw_body_not_uniquely_bound_held'}
    bounds = _bound_body(body, lines)
    if bounds is None:
        return {**result,'status':'native_body_not_uniquely_bound_held'}
    body_in_witness = witness.index(body)
    excluded = _header_spans(body, lines, source_date, page_count) + _footer_spans(body, lines, bounds, page_count)
    operative = body
    for span in sorted(excluded,key=lambda s:s['body_start'],reverse=True):
        operative = operative[:span['body_start']]+operative[span['body_end']:]
    operative = operative.strip()
    prefix = lines[max(0,bounds[0]-4):bounds[0]]
    actor_lines = witness.splitlines()[:2]
    if len(prefix)>=3 and len(actor_lines)==2 and all(_compact(prefix[-2+i]['quote'])==_compact(actor_lines[i]) for i in (0,1)) and re.fullmatch(r'Amendment:',prefix[-3]['quote'],re.I):
        result['motion_kind']='amendment'
        result['context']=[{**prefix[-3],'kind':'motion_kind_context'}]
    adjourn_heading = any(re.fullmatch(r'(?:\d+\.?\s*)?ADJOURNMENT',line['quote'],re.I) for line in prefix[:-2])
    event = _ADJOURN.fullmatch(body)
    if event and adjourn_heading:
        start,end = event.span(2)
        excluded.append({'body_start':start,'body_end':end,'quote':body[start:end],'kind':'execution_event','basis':'separate_completed_event_after_exact_unconditional_adjournment','geometry':{'first_body_line':lines[bounds[0]],'last_body_line':lines[bounds[1]]}})
        operative = event[1]
    for span in excluded:
        span['start'],span['end'] = body_in_witness+span['body_start'],body_in_witness+span['body_end']
        assert witness[span['start']:span['end']] == span['quote']
    result['excluded_spans']=excluded
    if re.fullmatch(_EVENT,body,re.I):
        return {**result,'status':'documentary_event_only_held'}
    # A list label may lead the body ("a) THAT ...", "1. That Council ..."); the words must still open the resolution.
    if not re.match(r'^(?:(?:[a-z]\)|\d{1,2}[.)])\s*)?(?:THAT(?=\s|Council\b|Committee\b)|WHEREAS\b)',operative,re.I):
        return {**result,'status':'operative_boundary_unknown_held'}
    result.update(operative_body=operative,status='explicit_operative')
    if result['motion_kind']=='amendment':
        result['match_aliases']=['AMENDMENT: '+operative]
    alias,lexical_spans=_lexical_alias(operative,lines,bounds) if not excluded else (operative,[])
    for span in lexical_spans:
        span['start'],span['end']=body_in_witness+span['body_start'],body_in_witness+span['body_end']
        assert witness[span['start']:span['end']]==span['quote']
    result['lexical_spans']=lexical_spans
    if lexical_spans:
        result['match_aliases'].append(alias)
    return result
