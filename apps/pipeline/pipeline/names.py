# People's names come from each municipality's records in the database (see
# MeetingIngester._get_canonical_names). This module used to carry View Royal's
# council and staff roster, nicknames and typos, which mapped e.g. "Councillor
# Anderson" in another town to a View Royal councillor. It holds no names now.

# Names or terms that should never be created as Person records
PERSON_BLOCKLIST = [
    "the mayor", "staff", "resident", "unknown", "speaker", "everyone",
    "all council", "public", "audience", "applicant", "consultant",
    "gallery", "various", "multiple", "unidentified", "city staff",
    "town staff", "clerk", "recording secretary", "moderator",
    "presenter", "developer", "architect", "engineer", "planner"
]

def is_valid_name(name):
    """
    Returns False if the name is empty, too short, or in the blocklist.
    """
    if not name: return False
    
    clean = name.lower().strip()
    
    # 1. Blocklist check (exact or contains)
    for blocked in PERSON_BLOCKLIST:
        if clean == blocked or clean.startswith(blocked + " "):
            return False
            
    # 2. Too short (likely noise)
    if len(clean) < 3:
        return False
        
    # 3. Numeric noise
    if any(char.isdigit() for char in clean):
        return False
        
    return True

def get_canonical_name(name):
    """
    Returns the name unchanged. Matching to known people happens against the
    municipality's own records (utils.match_person, MeetingIngester), never a
    hardcoded roster.
    """
    return name
