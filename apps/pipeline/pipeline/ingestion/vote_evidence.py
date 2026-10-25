"""Conservative recovery of outcomes from official minutes, never attendance ballots."""
import re
from difflib import SequenceMatcher

_FORMAL_START = re.compile(
    r"(?im)^[ \t]*(?:Amendment[ \t]*:[ \t]*|\.[ \t]*)?\*{0,2}(?:MOVED(?:[ \t]+BY\b[ \t]*:?|[ \t]*:)|"
    r"(?:On[ \t]+(?:the[ \t]+)?(?:Main[ \t]+)?Motion(?:[ \t]+as[ \t]+amended)?|"
    r"Voting[ \t]+resumed[ \t]+on[ \t]+(?:the[ \t]+)?Main[ \t]+Motion)[ \t]*:?[ \t]*\*{0,2}[ \t]*$)"
)


# Native OCR can split the printed M in the clerk's MOVED label into IVI/IVl.
# Recognize only the anchored label, retaining its raw bytes and requiring a
# separately recorded seconder; this never repairs a person's name.
_OCR_MOVED_START = re.compile(
    r"(?im)^[ \t]*(?:Amendment[ \t]*:[ \t]*|\.[ \t]*)?\*{0,2}IV[IL]OVED[ \t]*BY[ \t]*:"
)

# Some signed originals literally print MOVE BY: rather than MOVED BY:.
# Treat that anchored variant as a separate recovered header, preserving its
# bytes and requiring one separately recorded seconder and its own outcome.
_PRINTED_MOVE_START = re.compile(
    r"(?im)^[ \t]*(?:Amendment[ \t]*:[ \t]*|\.[ \t]*)?\*{0,2}MOVE[ \t]+BY[ \t]*:"
)


def normalize_text(text):
    # Native PDF extraction sometimes joins these two formal words. Segment
    # only the exact known phrase; retain original source words in every proof.
    text = re.sub(r'\bTHAT(?=(?:Council|Committee)\b)', 'THAT ', text or '', flags=re.I)
    return re.sub(r"[^a-z0-9]+", " ", text.casefold()).strip()


def special_voting_threshold(text):
    """Keep procedural uncertainty held; exclude only proved incidental references.

    An owner's request deadline and a staff review of extension rules are not
    themselves procedural motions. Unrecognized procedural wording stays held.
    """
    body = ' '.join(text.split())
    # Inspect every action independently: a reference to extending participation
    # must not consume a later operative extension of the meeting itself.
    for hit in re.finditer(r'extend', body, re.I):
        if not re.search(r'meeting', body[hit.end():], re.I):
            continue
        prefix = body[:hit.start()]
        directive = re.split(r'\b(?:AND\s+)?THAT\s+Council\b', prefix, flags=re.I)[-1]
        review = (re.search(r'\bdirect\s+staff\b.*\breview\b', directive, re.I)
                  and re.search(r'\bneed\s+for\s+unanimous\s+consent\s+to\s*$', prefix, re.I))
        if not review:
            return True
    for hit in re.finditer(r'reconsider\w*', body, re.I):
        prefix = body[:hit.start()]
        owner_right = (hit[0].casefold() == 'reconsideration'
                       and re.search(r'\b(?:owner|person|applicant)\b', prefix, re.I)
                       and re.search(r'\b(?:period\s+for\s+request\s+of|(?:they|owner|person|applicant)\s+may\s+request)\s*$', prefix, re.I))
        if not owner_right:
            return True
    return bool(re.search(r'sustain.*chair|presiding|appeal.*chair|chair.*appeal|ruling.*chair', body, re.I))


def minutes_motion_blocks(minutes):
    """Keep a recorded decision bounded by its own mover and the next mover.

    Markdown exports may repeat the minutes; identical normalized blocks are
    deduplicated. Notices and narrative without an explicit outcome stay unknown.
    """
    seen = set()
    starts = list(_FORMAL_START.finditer(minutes))
    recovered = list(_OCR_MOVED_START.finditer(minutes))
    printed = list(_PRINTED_MOVE_START.finditer(minutes))
    legacy_boundaries = sorted(match.start() for match in [*starts, *recovered])
    boundaries = sorted([*legacy_boundaries, *(match.start() for match in printed)])
    printed_offsets = {match.start() for match in printed}
    # Persisted source identities already include the legacy parser ordinal.
    # Keep every legacy block and ordinal unchanged. Newly recognized headers
    # use appended identity ordinals; source_offset supplies chronological order.
    candidates = [(match, starts[index + 1].start() if index + 1 < len(starts) else len(minutes), index, False)
                  for index, match in enumerate(starts)]
    candidates.extend((match, next((offset for offset in legacy_boundaries if offset > match.start()), len(minutes)),
                       len(starts) + index, True) for index, match in enumerate(recovered))
    candidates.extend((match, next((offset for offset in boundaries if offset > match.start()), len(minutes)),
                       len(starts) + len(recovered) + index, True) for index, match in enumerate(printed))
    for match, end, source_order, recovered_header in sorted(candidates, key=lambda entry: entry[0].start()):
        block = minutes[match.start():end]
        outcome = re.search(r"(?im)^\s*\*{0,2}(?:Motion\s+)?(CARRIED(?:\s+UNANIMOUSLY)?|DEFEATED|WITHDRAWN|NOT CARRIED|TABLED)\b[^\n]*", block)
        if not outcome:
            continue
        # Motion text begins after the seconder line and before its outcome.
        resumed = not recovered_header and not re.search(r'\bMOVED\b', match.group(), re.I)
        before = block[match.end()-match.start():outcome.start()] if resumed else block[:outcome.start()]
        seconder = re.search(r"(?im)^.*SECONDED[^\n]*\n", before)
        if match.start() in printed_offsets:
            seconders = list(re.finditer(r"(?im)^[ \t]*\*{0,2}SECONDED(?:[ \t]+BY)?[ \t]*[:;][^\n]*(?:\n|$)", before))
            if len(seconders) != 1:
                continue
            seconder = seconders[0]
        if recovered_header and not seconder:
            continue
        body = before[seconder.end():] if seconder else before
        # Keep the complete formal body, including recitals. The first word
        # "that" can occur halfway through a WHEREAS clause and is no boundary.
        # A separate clerk declaration before CARRIED is ballot evidence, not
        # part of the operative motion text.
        vote_start = re.search(
            r"(?im)^\s*(?:\*{0,2}(?:OPPOSED|AGAINST|NO|IN FAVOU?R|FOR|YES|ABSTAIN(?:ED)?|RECUSED)(?:\s*\(\d+\))?\s*:|"
            r"(?:Mayor|Councillors?)\s+[^\n]*\b(?:opposed|voted against|voted no|voted(?: in)? favou?r|voted yes|abstained|recused)(?=[.;]|\s*$))",
            body,
        )
        before_votes = ""
        if vote_start:
            # A recorded roll call can occur between operative clauses. Remove
            # exact clerk declarations only; preserve later motion clauses.
            tail = body[vote_start.start():]
            spans = []
            for declaration in named_vote_declarations({'before_outcome_votes':tail, 'after_outcome':'', 'source_block':block}):
                pattern = ''.join(r'\s+' if part.isspace() else re.escape(part) for part in re.split(r'(\s+)', declaration['source_quote']) if part)
                found = re.search(pattern+r'[ \t]*[.;]?', tail, re.I)
                if found and not any(found.start()<stop and start<found.end() for start,stop in spans):
                    spans.append((found.start(),found.end()))
            if spans:
                before_votes = '\n'.join(tail[start:stop] for start,stop in sorted(spans))
                for start,stop in sorted(spans,reverse=True):
                    tail = tail[:start]+'\n'+tail[stop:]
                body = body[:vote_start.start()]+tail
        key = normalize_text(body)
        source_key = normalize_text(block)
        if not key or source_key in seen:
            continue
        seen.add(source_key)
        yield {"motion_text": body.strip(), "result": outcome.group(1).upper(),
               "outcome_quote": outcome.group(0).strip(),
               "before_outcome_votes": before_votes,
               "after_outcome": block[outcome.end():].strip(), "source_block": block.strip(),
               "source_offset": match.start(), "source_order": source_order,
               "formal_source_kind": "resumed_main_motion" if resumed else "moved_motion"}


def match_minutes_motion(motion_text, minutes, *, threshold=1.0, margin=0.06):
    """Return an exact normalized source motion or None; ambiguity requires no write.

    No fuzzy matching is eligible for persistence: a one-digit bylaw/address or
    amount change, or added negation, can reverse which decision is identified.
    """
    target = normalize_text(motion_text)
    candidates=[]
    for block in minutes_motion_blocks(minutes):
        score=SequenceMatcher(None,target,normalize_text(block['motion_text']),autojunk=False).ratio()
        candidates.append((score,block))
    candidates.sort(key=lambda pair:pair[0],reverse=True)
    if not candidates or candidates[0][0]<threshold:
        return None
    if len(candidates)>1 and candidates[0][0]-candidates[1][0]<margin:
        return None
    score,block=candidates[0]
    return {**block,"match_score":round(score,5)}



def named_vote_declarations(block):
    """Read complete clerk name lists inside this decision's structural scope.

    Blank pages and wrapped names do not limit a ballot to an arbitrary number
    of lines. A new agenda item, resumed motion or outcome ends the scope.
    Unparsed choice language is returned as a hold, never absence of dissent.
    """
    if not block:
        return []
    after = block.get('after_outcome', '')
    boundary = re.search(
        r'(?im)^\s*(?:\*{0,2}(?:Motion\s+)?(?:CARRIED|DEFEATED|WITHDRAWN)\b|'
        r'\d+(?:\.\d+)*\.?\s+[A-Z]|(?:MOVED|MOVE|IV[IL]OVED)[ \t]*BY[ \t]*:|(?:On\s+(?:the\s+)?(?:Main\s+)?Motion|Voting\s+resumed\s+on)\b)', after)
    if boundary:
        after = after[:boundary.start()]
    declarations = []
    prefix_pattern = re.compile(r'(OPPOSED|AGAINST|NO|IN FAVOU?R|FOR|YES|ABSTAIN(?:ED)?|RECUSED)(?:\s*\((\d+)\))?\s*:\s*(.*)', re.I)
    suffix_pattern = re.compile(r'((?:\d+\s+)?(?:Mayor|Councillors?|Committee [Mm]embers?)\s+.+?)\s+(opposed|voted against|voted (?:in )?favou?r|voted yes|voted no|abstained|recused)(?=[.;]|\s*$)', re.I)
    name_line = re.compile(r"(?:(?:[A-Z][A-Za-z'-]*\.?|[A-Z](?:\.[A-Z])*\.?|and|members?)[,;/\s]*)+")
    for scope in [block.get('before_outcome_votes', ''), after]:
        # A second role-prefixed sentence is a separate clerk statement, not a
        # continuation of the first person's name list.
        scope = re.sub(r'(?<=[.;])\s+(?=(?:Mayor|Councillors?|Committee [Mm]embers?)\b)', '\n', scope)
        lines = [re.sub(r'[*_>]', '', line).strip() for line in scope.splitlines()]
        index = 0
        while index < len(lines):
            clean = lines[index]
            index += 1
            if not clean:
                continue
            prefix = prefix_pattern.match(clean)
            suffix = suffix_pattern.match(clean)
            starts_names = bool(re.match(r'(?:Mayor|Councillors?|Committee [Mm]embers?)\b', clean))
            if prefix or (starts_names and not suffix):
                # Join only name-shaped continuations, preserving exact source
                # words; arbitrary narrative cannot join a clerk name list.
                while index < len(lines):
                    following = lines[index]
                    if not following or re.fullmatch(r'\d+', following):
                        index += 1
                        continue
                    if prefix_pattern.match(following) or (prefix and suffix_pattern.match(following)):
                        break
                    combined = clean + ' ' + following
                    if name_line.fullmatch(following) or (starts_names and suffix_pattern.match(combined)):
                        clean = combined
                        index += 1
                        if starts_names and suffix_pattern.match(clean):
                            break
                    else:
                        break
                prefix = prefix_pattern.match(clean)
                suffix = suffix_pattern.match(clean)
            if prefix:
                verb, declared_count, names = prefix.groups()
                quote = clean
            elif suffix:
                names, verb = suffix.groups()
                declared_count = None
                quote = clean[:suffix.end()]
            else:
                if starts_names and re.search(r'\b(?:opposed|against|abstain\w*|recus\w*|voted)\b', clean, re.I):
                    declarations.append({'names':'', 'vote':None, 'source_quote':clean, 'unparsed':True})
                continue
            names = re.split(r'\bOn the (?:Main )?Motion\b|\s+\d+\.(?:\d+)?\s', names, flags=re.I)[0].strip()
            if prefix:
                quote = clean[:prefix.start(3)] + names
            if normalize_text(quote) not in normalize_text(block['source_block']):
                declarations.append({'names':'', 'vote':None, 'source_quote':quote, 'unparsed':True})
                continue
            normalized = verb.casefold()
            choice = 'Yes' if normalized in ('yes','for','in favour','in favor','voted in favour','voted in favor','voted favour','voted favor','voted yes') else 'Abstain' if normalized.startswith('abstain') else 'Recused' if normalized.startswith('recus') else 'No'
            declarations.append({'names':names, 'vote':choice, 'source_quote':quote, 'declared_count':int(declared_count) if declared_count else None})
    return declarations


def _declaration_names(declaration, canonical_names):
    """Resolve every name token; a partly understood declaration yields no rows."""
    if declaration.get('unparsed'):
        return []
    text = declaration['names']
    surnames = {}
    for name in set(canonical_names):
        parts = normalize_text(name).split()
        if len(parts) >= 2 and len(parts[-1]) >= 3:
            surnames.setdefault(parts[-1], []).append(name)
    resolved = []
    for surname, candidates in surnames.items():
        if not re.search(r'\b'+re.escape(surname)+r'\b', normalize_text(text)):
            continue
        initial = re.search(r'\b([A-Z])\.\s*'+re.escape(surname)+r'\b', text, re.I)
        if initial:
            candidates = [name for name in candidates if name[0].casefold()==initial[1].casefold()]
        if len(candidates) != 1:
            return []
        resolved.append(candidates[0])
    allowed = {'mayor','councillor','councillors','committee','member','members','and','acting'}
    allowed.update(word for name in resolved for word in normalize_text(name).split())
    allowed.update(name[0].casefold() for name in resolved)
    if not resolved or any(word not in allowed for word in normalize_text(text).split()):
        return []
    if declaration.get('declared_count') is not None and len(resolved)!=declaration['declared_count']:
        return []
    return resolved


def named_votes(block, canonical_names):
    """Validate explicit source choices only; never trust model or attendance votes.

    Read the structurally bounded clerk declarations for one decision, stop at
    the next decision, and resolve surnames uniquely to existing canonical names.
    An outcome/unanimity alone never supplies a person's choice.
    """
    votes=[]
    for declaration in named_vote_declarations(block):
        for name in _declaration_names(declaration, canonical_names):
            votes.append({'person_name':name,'vote':declaration['vote'],'source_quote':declaration['source_quote']})
    choices={}
    for vote in votes:choices.setdefault(vote['person_name'],set()).add(vote['vote'])
    # Contradictory source choices remain held; duplicated exports are harmless.
    unique={}
    for vote in votes:
        if len(choices[vote['person_name']])==1:unique[(vote['person_name'],vote['vote'])]=vote
    return list(unique.values())


def outcome_family(result):
    result=normalize_text(result)
    if result.startswith('carried') or result=='passed':return 'passed'
    if result in ('defeated','not carried','failed'):return 'failed'
    return result


def critical_identity(text):
    """Protect identifiers, quantities/units, action polarity and conditions."""
    numbers=tuple(re.findall(r'\$?\d[\d,]*(?:\.\d+)?%?',text or ''))
    protected={'not','no','never','without','unless','except','against','deny','refuse','reject','approve','adopt','receive','authorize','include','exclude','remove','reduce','increase','amend','delete','retain','proceed','defer','table','refer','rescind','waive','terminate'}
    words=normalize_text(text).split()
    return numbers,tuple(sorted(w for w in words if w in protected))


def match_motion_record(motion,minutes):
    """Prefer exact motion text; permit a uniquely verified verbatim source anchor.

    A source quote may rescue editorial wording only when identifiers/quantities,
    polarity and every substantive proposed token are supported by that quote.
    Callers persist the official motion text for quote-rescued proposals, retaining
    the proposal separately so a shortened description cannot alter the decision.
    """
    source=match_minutes_motion(motion.get('motion_text'),minutes)
    if source:return {**source,'anchor_method':'exact_motion_text'}
    quote=motion.get('motion_source_quote')
    if not quote or critical_identity(motion.get('motion_text'))!=critical_identity(quote):return None
    stop={'the','a','an','that','to','of','for','and','be','is','as','by','with','it','its','on','in','at','from','this','these','those'}
    proposed=set(normalize_text(motion.get('motion_text')).split())-stop
    official=set(normalize_text(quote).split())-stop
    if not proposed or not proposed<=official:return None
    source=match_minutes_motion(quote,minutes)
    return {**source,'anchor_method':'verbatim_quote_exact_identity'} if source else None
