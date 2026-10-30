"""Match a refined agenda item to an already persisted agenda_items row.

Re-ingesting a meeting re-runs the AI refinement, which renders the same
agenda item differently from run to run: "4(a)" / "4a" / "4.a" / "4 a",
"1." / "1", "a) Title" / "Title", an OCR typo fixed in one run but not the
other, or two sibling items swapped in order. Exact order + title matching
then inserted a duplicate beside the original (or failed on the slug unique
index). This module decides when two renderings are the same item.

Tiers, most to least strict. Each tier must yield exactly one row; a fuzzy tier
with several candidates returns no match rather than guessing:
  1. same normalized order and same normalized title
  2. same normalized title, the title being unique among the meeting's rows
     (siblings renumbered or swapped)
  3. same normalized order and a near-identical title (OCR typo, or one title
     extends the other word-for-word at either end, e.g. a header merged with
     its child title, or
     both start with the same numbered identifier such as "Bylaw No. 1989")
Items whose order AND title both differ are never matched.
"""
from difflib import SequenceMatcher
import re

# A parenthetical with whitespace is an annotation ("4.c (moved from 4.d)"),
# while "4(a)" / "4(iii)" are part of the number.
_ORDER_ANNOTATION = re.compile(r'\([^)]*\s[^)]*\)')
_ORDER_TOKENS = re.compile(r'\d+|[a-z]+')
# "1. Call", "4.1 Minutes", "a) Planning", "(b) Report", "iii - Report".
_TITLE_ENUMERATOR = re.compile(
    r'^\s*\(?(?:([0-9]+(?:\.[0-9]+)*)\.?\)?\s+|([a-z]{1,4})\s*(?:[.)]|\s[-–—:])\s*)', re.I)
FUZZY_TITLE_RATIO = 0.9
MIN_PREFIX_WORDS = 3


def normalize_order(order):
    """'4(a)', '4a', '4.a', '4 a', '4.A.' -> '4.a'; '1.' -> '1'; '04' -> '4'."""
    text = _ORDER_ANNOTATION.sub(' ', str(order or '').casefold())
    tokens = _ORDER_TOKENS.findall(text)
    if tokens and tokens[0] == 'item':
        tokens = tokens[1:]
    return '.'.join(str(int(token)) if token.isdigit() else token for token in tokens)


def _words(text):
    text = str(text or '').casefold().replace('&', ' and ')
    return re.sub(r'[^a-z0-9]+', ' ', text).split()


def normalize_title(title, order=None):
    """Case/punctuation-insensitive title, minus a leading copy of its own number.

    Only an enumerator equal to the item's own order (or its last component) is
    stripped, so a title that genuinely starts with a number ("2022 Budget",
    "820 Hockley Ave") is kept intact.
    """
    title = str(title or '')
    norm_order = normalize_order(order)
    match = _TITLE_ENUMERATOR.match(title)
    if match and norm_order:
        prefix = normalize_order(match.group(1) or match.group(2))
        if prefix and (prefix == norm_order or prefix == norm_order.split('.')[-1]):
            title = title[match.end():]
    return ' '.join(_words(title))


def _near_title(a, b):
    if not a or not b:
        return False
    # A typo may differ; a number never may ("Bylaw 1998" is not "Bylaw 1999").
    if (re.findall(r'\d+', a) == re.findall(r'\d+', b)
            and SequenceMatcher(None, a, b, autojunk=False).ratio() >= FUZZY_TITLE_RATIO):
        return True
    short, long_ = sorted((a.split(), b.split()), key=len)
    if len(short) >= MIN_PREFIX_WORDS and short in (long_[:len(short)], long_[-len(short):]):
        # One title extends the other: a header merged with its child title,
        # "ADOPTION OF THE MINUTES — <child>" under either number.
        return True
    # Same leading identifier, differently described: "Bylaw No. 1989 (Second and
    # Third Readings)" / "Bylaw No. 1989 — Langford OCP Amendment No. 41".
    shared = 0
    while shared < len(short) and short[shared] == long_[shared]:
        shared += 1
    return shared >= MIN_PREFIX_WORDS and any(re.search(r'\d', word) for word in short[:shared])


def existing_agenda_item(item, existing_items, claimed=()):
    """Return the persisted row this refined item refers to, or None.

    `claimed` holds row ids already matched to other refined items of the same
    run; fuzzy tiers never hand the same row to two items.
    """
    order = normalize_order(item.get('item_order'))
    title = normalize_title(item.get('title'), item.get('item_order'))
    keyed = [(old, normalize_order(old.get('item_order')), normalize_title(old.get('title'), old.get('item_order')))
             for old in existing_items]

    exact = [old for old, old_order, old_title in keyed if old_order == order and old_title == title]
    if len(exact) > 1:
        # Rows already differing only in punctuation: the literal rendering decides.
        literal = [old for old in exact if str(old.get('item_order') or '') == str(item.get('item_order') or '')
                   and _words(old.get('title')) == _words(item.get('title'))]
        if len(literal) != 1:
            raise RuntimeError('Ambiguous existing agenda identity; no agenda refresh applied')
        return literal[0]
    if exact:
        return exact[0]
    if not title:
        return None

    open_rows = [(old, old_order, old_title) for old, old_order, old_title in keyed if old['id'] not in claimed]
    same_title = [old for old, _, old_title in keyed if old_title == title]
    if len(same_title) == 1 and same_title[0]['id'] not in claimed:
        return same_title[0]

    if order:
        near = [old for old, old_order, old_title in open_rows if old_order == order and _near_title(title, old_title)]
        if len(near) == 1:
            return near[0]
    return None
