"""Original formal-envelope ownership, independent of recognized mover spelling.

Compact text can only detect collisions and remove text-only candidates. It
never creates an alias, motion, occurrence key, or corrected source text.
"""
import hashlib
import re

from .vote_evidence import named_vote_declarations

_SECOND = re.compile(r'(?im)^[ \t]*\*{0,2}SECONDED(?:[ \t]+BY)?[ \t]*[:;][^\n]*(?:\n|$)')
_RESUMED = re.compile(r'(?im)^[ \t]*\*{0,2}(?:On[ \t]+(?:the[ \t]+)?(?:Main[ \t]+)?Motion(?:[ \t]+as[ \t]+amended)?|Voting[ \t]+resumed[ \t]+on[ \t]+(?:the[ \t]+)?Main[ \t]+Motion)[ \t]*:?[ \t]*\*{0,2}[ \t]*$')
_OUTCOME = re.compile(r'(?im)^[ \t]*\*{0,2}(?:Motion[ \t]+)?(?:CARRIED(?:[ \t]+UNANIMOUSLY)?|NOT CARRIED|DEFEATED|WITHDRAWN|TABLED)\b[^\n]*')


# This clerk formula records a result but supplies no complete resumed body.
# It is a diagnostic only, never a formal envelope or source identity.
_CLERK_MAIN_RESULT = re.compile(
    r'(?im)^[ \t]*(?P<quote>The[ \t\r\n]+vote[ \t\r\n]+was[ \t\r\n]+taken[ \t\r\n]+on[ \t\r\n]+'
    r'the[ \t\r\n]+Main[ \t\r\n]+Motion[ \t\r\n]+as[ \t\r\n]+amended[ \t\r\n]+'
    r'and[ \t\r\n]+declared[ \t\r\n]+(?P<outcome>NOT[ \t]+CARRIED|CARRIED|DEFEATED|WITHDRAWN|TABLED)\.)[ \t]*(?=\n|$)'
)


def _compact(text):
    return re.sub(r'[^a-z0-9]', '', text.casefold())


def original_formal_inventory(text):
    """Retain every seconder/body/outcome or explicit resumed-main envelope."""
    anchors = sorted([(m, 'seconded_motion') for m in _SECOND.finditer(text)] +
                     [(m, 'resumed_main_motion') for m in _RESUMED.finditer(text)], key=lambda entry: entry[0].start())
    envelopes = []
    for index, (anchor, kind) in enumerate(anchors):
        stop = anchors[index+1][0].start() if index+1 < len(anchors) else len(text)
        outcome = _OUTCOME.search(text, anchor.end(), stop)
        if not outcome:
            continue
        body = text[anchor.end():outcome.start()].strip()
        if not body:
            continue
        # Reuse the same bounded clerk-declaration reader as the motion parser;
        # vote declarations do not become a different operative body.
        view = body
        for declaration in named_vote_declarations({'before_outcome_votes': body, 'after_outcome': '',
                                                     'source_block': text[anchor.start():outcome.end()]}):
            quote = declaration.get('source_quote')
            if not quote:
                continue
            pattern = ''.join(r'\s+' if part.isspace() else re.escape(part) for part in re.split(r'(\s+)', quote) if part)
            found = re.search(pattern+r'[ \t]*[.;]?', view, re.I)
            if found:
                view = view[:found.start()]+'\n'+view[found.end():]
        prefix = text[:anchor.start()].rstrip()
        start = prefix.rfind('\n')+1 if kind == 'seconded_motion' else anchor.start()
        envelopes.append({'kind': kind, 'anchor_offset': anchor.start(), 'body_start': anchor.end(),
                          'outcome_offset': outcome.start(), 'outcome_end': outcome.end(),
                          'body': body, 'body_view': view.strip(), 'body_compact': _compact(view),
                          'outcome_quote': outcome[0].strip(), 'source_start': start,
                          'source_quote': text[start:outcome.end()]})
    return {'text_sha256': hashlib.sha256(text.encode()).hexdigest(), 'envelopes': envelopes}


def formal_inventory(source):
    text = source.get('text', '')
    inventory = source.get('formal_occurrence_inventory')
    if inventory and inventory.get('text_sha256') == hashlib.sha256(text.encode()).hexdigest():
        return inventory
    return original_formal_inventory(text)


def matching_formal_envelopes(source, block):
    key = _compact(block['motion_text'])
    return [envelope for envelope in formal_inventory(source)['envelopes'] if key == envelope['body_compact']]


def own_formal_envelopes(source, block):
    """The block's own outcome must belong to its complete original envelope."""
    text = source.get('text', '')
    start = text.find(block['source_block'], block['source_offset'])
    if start < 0:
        return []
    outcome = text.find(block['outcome_quote'], start, start+len(block['source_block']))
    expected = 'resumed_main_motion' if block.get('formal_source_kind') == 'resumed_main_motion' else 'seconded_motion'
    return [envelope for envelope in matching_formal_envelopes(source, block)
            if envelope['kind'] == expected
            and (start <= envelope['anchor_offset'] or
                 (envelope['anchor_offset'] < start < envelope['body_start']
                  and not text[envelope['anchor_offset']:start].strip()))
            and envelope['anchor_offset'] < outcome
            and envelope['outcome_offset'] <= outcome < envelope['outcome_end']]


def text_occurrence_unique(source, block):
    return len(matching_formal_envelopes(source, block)) == 1 and len(own_formal_envelopes(source, block)) == 1


def envelope_proof(source, envelope):
    return {key: value for key, value in envelope.items() if key not in ('body_compact', 'body_view')} | {
        'source_sha256': source.get('source_sha256'), 'source_text_sha256': formal_inventory(source)['text_sha256']}


def _unaccounted_clerk_main_results(source):
    """Retain explicit main-result prose excluded by the formal body parser.

    A parsed amendment's source_block includes its post-result context. Only an
    actual parsed outcome span can account another result in that context.
    """
    text = source.get('text', '')
    accounted = []
    for block in source.get('blocks', []):
        quote = block.get('outcome_quote')
        raw = block.get('source_block', '')
        if not quote or not raw:
            continue
        offset = block.get('source_offset')
        if not isinstance(offset, int) or offset < 0:
            continue
        start = text.find(raw, offset)
        if start < 0 or text[offset:start].strip():
            continue
        outcome = text.find(quote, start, start+len(raw))
        if outcome >= 0:
            accounted.append((outcome, outcome+len(quote)))
    leads = []
    for match in _CLERK_MAIN_RESULT.finditer(text):
        if any(start <= match.start('outcome') and match.end('outcome') <= stop for start, stop in accounted):
            continue
        leads.append({'kind': 'explicit_clerk_main_motion_result_lead',
            'authority': 'coverage_diagnostic_only',
            'reason': 'explicit_main_motion_result_without_bound_body',
            'source_start': match.start('quote'), 'source_quote': match['quote'],
            'outcome_offset': match.start('outcome'), 'outcome_end': match.end('quote'),
            'outcome_quote': text[match.start('outcome'):match.end('quote')],
            'source_sha256': source.get('source_sha256'),
            'source_text_sha256': hashlib.sha256(text.encode()).hexdigest(),
            'source_file': source.get('source_file'), 'source_url': source.get('source_url')})
    return leads


def unparsed_formal_envelopes(source):
    owned = {(envelope['anchor_offset'], envelope['outcome_offset'])
             for block in source.get('blocks', []) for envelope in own_formal_envelopes(source, block)}
    return [envelope_proof(source, envelope) for envelope in formal_inventory(source)['envelopes']
            if (envelope['anchor_offset'], envelope['outcome_offset']) not in owned] + _unaccounted_clerk_main_results(source)


def matching_envelopes_all_parsed(source, block):
    """A current parsed occurrence may be retried only when no twin was skipped."""
    matching = matching_formal_envelopes(source, block)
    owned = {(envelope['anchor_offset'], envelope['outcome_offset'])
             for candidate in source.get('blocks', []) for envelope in own_formal_envelopes(source, candidate)}
    return bool(matching) and all((envelope['anchor_offset'], envelope['outcome_offset']) in owned for envelope in matching)
