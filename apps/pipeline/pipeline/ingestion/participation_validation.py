"""Conservative public-summary spelling checks; never admits a voice identity.

The people registry supplies display spellings. Statement names are soft aliases
only when tied to that registry and compatible with it. Neither is independent
audio proof, and this module never writes transcript/person links.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import unicodedata

VERSION = 'public-comment-spelling-v1'
VERBS = set('supports opposes raises warns calls requests urges asks questions seeks recommends suggests notes argues reports describes explains objects commends thanks highlights advocates expresses shares speaks discusses stresses proposes encourages wants states cautions thanks thank accepts considers acknowledges agrees praises doubts fears worries favours favors says indicates mentions clarifies identifies presents believes challenges disputes welcomes endorses criticizes emphasises emphasizes'.split())
TYPES = {'rd': 'road', 'st': 'street', 'ave': 'avenue', 'cres': 'crescent',
         'dr': 'drive', 'ct': 'court', 'ln': 'lane', 'hwy': 'highway',
         'pl': 'place', 'blvd': 'boulevard', 'terr': 'terrace', 'pkwy': 'parkway'}
SUFFIX = r'(?:Road|Rd\.?|Street|St\.?|Avenue|Ave\.?|Crescent|Cres\.?|Drive|Dr\.?|Court|Ct\.?|Lane|Ln\.?|Way|Highway|Hwy\.?|Place|Pl\.?|Boulevard|Blvd\.?|Terrace|Circle|Close|Trail|Parkway)'
STREET = re.compile(r"\b(?:[A-Za-z][A-Za-z’'\-]*\s+){1,4}" + SUFFIX + r'\b', re.I)
HOUSE = r'\d{1,6}[A-Za-z¼½¾]?(?:\s+\d/\d)?(?:\s*[-/]\s*\d{1,6}[A-Za-z]?)?'
NUMBER_WORD = r'(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)'
NUMBER_SEQUENCE = NUMBER_WORD + r'(?:[-\s]+(?:and[-\s]+)?' + NUMBER_WORD + r'){0,11}'
ADDRESS = re.compile(r"(?<!\w)(?:(?:unit|suite|apt\.?|apartment)\s*#?\s*\w+\s*[,/\-]?\s*)?#?" + HOUSE + r"\s+(?!units?\b|homes?\b|spaces?\b|years?\b|days?\b|people\b|residents?\b|percent\b)((?:[A-Za-z][A-Za-z’'\-]*\s+){1,4}" + SUFFIX + r')\b', re.I)


def folded(value):
    value = ''.join(c for c in unicodedata.normalize('NFKD', value.casefold()) if not unicodedata.combining(c))
    return re.findall(r"[a-z]+(?:['’-][a-z]+)*", value)


def one_edit(a, b):
    if abs(len(a) - len(b)) > 1:
        return False
    if len(a) > len(b):
        a, b = b, a
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) <= 1
    for index, (x, y) in enumerate(zip(a, b)):
        if x != y:
            return a[index:] == b[index + 1:]
    return True


def name_score(spoken, canonical):
    a, b = folded(spoken), folded(canonical)
    if len(a) < 2 or len(a) != len(b):
        return 0
    if a == b:
        return 1.
    if a[1:] == b[1:] and a[0][0] == b[0][0] and (len(a[0]) == 1 or len(b[0]) == 1):
        return .92
    if a[:-1] == b[:-1] and min(len(a[-1]), len(b[-1])) >= 5 and one_edit(a[-1], b[-1]):
        return .96
    if a[1:] == b[1:] and min(len(a[0]), len(b[0])) >= 4 and one_edit(a[0], b[0]):
        return .94
    return 0


def display_name(spoken, people, statement_names):
    people = [p for p in people if not re.search(r'\d', p.get('name', '')) and len(folded(p.get('name', ''))) >= 2 and
              not re.search(r'\b(speaker|presenter|responder|unknown|resident|staff)\b', p.get('name', ''), re.I)]
    exact = [p for p in people if folded(p['name']) == folded(spoken)]
    if exact:
        return exact[0]['name'] if len(exact) == 1 else None
    aliases = {}
    for row in statement_names:
        aliases.setdefault(row.get('person_id'), set()).add(row.get('speaker_name') or '')
    ranked = []
    for person in people:
        score = name_score(spoken, person['name'])
        # Existing AI statement labels can corroborate a compatible spelling;
        # they cannot manufacture a canonical identity or override ambiguity.
        if any(folded(spoken) == folded(alias) and name_score(alias, person['name']) for alias in aliases.get(person['id'], ())):
            score = max(score, .94)
        if score:
            ranked.append((score, person))
    ranked.sort(key=lambda row: -row[0])
    if not ranked or (len(ranked) > 1 and ranked[0][0] - ranked[1][0] < .06 - 1e-9):
        return None
    return ranked[0][1]['name']


def load_streets():
    path = Path(__file__).parent / 'data/langford-streets.json'
    return json.loads(path.read_text()) if path.exists() else {'streets': [], 'street_aliases': {}}


def street_key(value):
    words = folded(value)
    return ' '.join(TYPES.get(word, word) for word in words)


class StreetCheck:
    def __init__(self, evidence):
        self.names = {street_key(name): name for name in evidence.get('streets', [])}
        self.aliases = {street_key(alias): target for alias, target in evidence.get('street_aliases', {}).items()
                        if street_key(target) in self.names}
        # The GIS inventory includes Ridge, Plateau, Heights, Gardens, etc.;
        # privacy cannot depend on a short conventional road-suffix list.
        endings = sorted({name.split()[-1] for name in evidence.get('streets', [])})
        suffix = '(?:' + SUFFIX + ('|' + '|'.join(map(re.escape, endings)) if endings else '') + ')'
        self.street_pattern = re.compile(STREET.pattern.replace(SUFFIX, suffix), re.I)
        self.address_pattern = re.compile(ADDRESS.pattern.replace(SUFFIX, suffix), re.I)
        street_names = sorted([*self.names.values(), *evidence.get('street_aliases', {})], key=len, reverse=True)
        stems = {name.rsplit(' ', 1)[0] for name in self.names.values() if len(name.rsplit(' ', 1)[0]) >= 5}
        stems -= {'Langford', 'Colwood', 'Highlands', 'View Royal', 'Greater Victoria'}
        self.stem_address = re.compile(r'(?<![\w$.,])' + HOUSE + r'\s+(' + '|'.join(map(re.escape, sorted(stems, key=len, reverse=True))) + r')\b', re.I) if stems else None
        spoken_names = sorted({*street_names, *stems}, key=len, reverse=True)
        self.spoken_address = re.compile(
            r'\b' + NUMBER_SEQUENCE + r'\s+('
            + '|'.join(map(re.escape, spoken_names)) + r')\b', re.I) if spoken_names else None

    def strip_address(self, text):
        if self.spoken_address:
            text = self.spoken_address.sub(lambda match: match[1], text)
        if self.stem_address:
            text = self.stem_address.sub(lambda match: match[1], text)
        def address(match):
            # Do not treat "2025 funding for Madrona Ridge" as an address.
            # Only the actual street phrase may follow the civic number.
            if any(word in {'for', 'from', 'in', 'on', 'at', 'to', 'of', 'funding', 'budget', 'plan', 'units', 'spaces', 'years'} for word in folded(match[1])):
                return match[0]
            return match[1]
        text = self.address_pattern.sub(address, text)
        text = re.sub(r'(?:,\s*)?\b(?:unit|suite|apt\.?|apartment)\s*#?\s*(?:\d+[A-Za-z]?|' + NUMBER_SEQUENCE + r')\b', '', text, flags=re.I)
        # A trailing #12 is also a unit identifier. Preserve explicitly labelled
        # bylaw references, which are public policy identifiers, not addresses.
        text = re.sub(r'#\s*\d+[A-Za-z]?\b', lambda m: m[0] if re.search(r'\bbylaw\s*$', text[:m.start()], re.I) else '', text)
        text = re.sub(r',\s*(?=[.;:!?])', '', text)
        text = re.sub(r'\s+([.,;:!?])', r'\1', text)
        return re.sub(r'\s+', ' ', text).strip(' ,–—-')

    def resolve(self, value):
        # Only street-only values reach lookup. House/unit numbers never appear
        # in labels or in an external geocoder request.
        value = self.strip_address(value)
        value = re.sub(r'\b\d[\w/-]*\b', '', value).strip(' ,#–—-')
        key = street_key(value)
        if key in self.names:
            return self.names[key]
        if key in self.aliases:
            return self.aliases[key]
        words = key.split()
        matches = [name for other, name in self.names.items() if len(words) >= 2 and
                   other.split()[-1] == words[-1] and len(other.split()) == len(words) and
                   one_edit(' '.join(words[:-1]), ' '.join(other.split()[:-1]))]
        return matches[0] if len(matches) == 1 else None

    def clean_text(self, text):
        text = re.sub(r'\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b', '[contact omitted]', str(text or ''))
        text = re.sub(r'(?<!\d)(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)', '[contact omitted]', text)
        text = self.strip_address(text)
        # A greedy street phrase may include introductory words. Resolve only
        # a verified suffix, retaining the preceding sentence words unchanged.
        def replace(match):
            words = match[0].split()
            for offset in range(len(words) - 1):
                canonical = self.resolve(' '.join(words[offset:]))
                if canonical:
                    return ' '.join([*words[:offset], canonical])
            return match[0]
        return self.street_pattern.sub(replace, text).strip()


def verb_led(point):
    point = re.sub(r'^\s*(?:he|she|they)\s+', '', point, flags=re.I)
    # Keep the original antecedent. An internal "his" may refer to the mayor,
    # not to the public speaker; never replace it with "the speaker's".
    point = re.sub(r'\bher\b(?=\s+(?:and|or|to|for|with|from|at|in|on|because|but|who|when|as)\b|[.,;:!?]|$)', 'them', point, flags=re.I)
    point = re.sub(r'\b(?:his|hers|her)\b', 'their', point, flags=re.I)
    point = re.sub(r'\b(?:he|she)\b', 'they', point, flags=re.I)
    point = re.sub(r'\bhim\b', 'them', point, flags=re.I)
    point = re.sub(r'\b(?:himself|herself)\b', 'themselves', point, flags=re.I)
    point = point[:1].upper() + point[1:]
    first = (point.split() or [''])[0].strip(':,').casefold()
    if first and first not in VERBS:
        point = 'States: ' + point
    return point


def canonicalize_participation(data, *, people, statement_names, street_evidence, source_text):
    streets = StreetCheck(street_evidence)
    source_words = folded(source_text)
    speakers = []
    for speaker in data.get('speakers') or []:
        point = streets.clean_text(speaker.get('point'))
        if not point:
            continue
        original = str(speaker.get('who') or 'A resident').strip()
        location = re.search(r'\(([^()]*)\)\s*$', original)
        name = original[:location.start()].strip() if location else original
        canonical = display_name(name, people, statement_names)
        if canonical:
            width = len(folded(canonical))
            if not any(name_score(' '.join(source_words[index:index + width]), canonical) and
                       display_name(' '.join(source_words[index:index + width]), people, statement_names) == canonical
                       for index in range(max(0, len(source_words) - width + 1))):
                canonical = None
        street = streets.resolve(location[1]) if location else None
        who = canonical or 'A resident'
        if street:
            who += f' ({street})'
        speakers.append({'who': who, 'position': speaker.get('position') if speaker.get('position') in
                         {'supports', 'opposes', 'concerned', 'asks', 'mixed', 'other'} else 'other',
                         'point': verb_led(point), 'topic': streets.clean_text(speaker.get('topic'))})
    return {'overview': streets.clean_text(data.get('overview')), 'speakers': speakers,
            'validation': {'version': VERSION, 'names': 'registry_spelling_only_not_voice_identity',
                           'street_source': street_evidence.get('source_url'),
                           'street_source_sha256': street_evidence.get('source_sha256')}}


def load_name_evidence(supabase):
    def pages(table, columns):
        result = []
        while True:
            rows = supabase.table(table).select(columns).order('id').range(len(result), len(result) + 999).execute().data or []
            result.extend(rows)
            if len(rows) < 1000:
                return result
    return pages('people', 'id,name'), pages('key_statements', 'id,person_id,speaker_name,meeting_id')
