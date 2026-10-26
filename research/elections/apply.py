#!/usr/bin/env python3
"""Insert Langford 2008/2011/2014 elections from results.json.

Usage: python3 -I apply.py            # dry run: print plan, validate SQL in a rolled-back transaction
       python3 -I apply.py --apply    # backup + commit in one transaction
Reads DATABASE_URL from the main checkout .env; psql via libpq.
"""
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
PSQL = '/opt/homebrew/opt/libpq/bin/psql'
TODAY = '2026-10-25'
data = json.load(open(os.path.join(HERE, 'results.json')))
years = [y for y in data if y.isdigit()]

url = None
for l in open('/Users/owen/Projects/viewroyal/.env'):
    if l.startswith('DATABASE_URL='):
        url = l.split('=', 1)[1].strip().strip('"\'')


def run(sql, extra=()):
    r = subprocess.run([PSQL, url, '-v', 'ON_ERROR_STOP=1', *extra], input=sql, capture_output=True, text=True)
    if r.returncode:
        sys.exit('psql failed: ' + r.stderr)
    return r.stdout


def q(s):
    return "'" + str(s).replace("'", "''") + "'"


def jq(o):
    return q(json.dumps(o)) + '::jsonb'


# people to create (unique by name across years)
new_people = []
for y in years:
    for off in data[y]['offices'].values():
        for c in off['candidates']:
            if 'person_id' not in c and c['name'] not in new_people:
                new_people.append(c['name'])

# sanity: elected counts, council term match
for y in years:
    e = data[y]
    for o, off in e['offices'].items():
        n = sum(1 for c in off['candidates'] if c['elected'])
        assert n == off['seats'], (y, o, n)
        assert all(c.get('votes') is not None or c.get('acclaimed') for c in off['candidates'])
    ids = sorted(c['person_id'] for off in e['offices'].values() for c in off['candidates'] if c['elected'])
    mem = run(f"select p.id from memberships m join people p on p.id=m.person_id where m.council_term_id={e['council_term_id']} order by 1", ['-t', '-A'])
    assert ids == sorted(int(x) for x in mem.split()), (y, ids, mem)

print('PLAN')
print(' new people:', new_people)
for y in years:
    e = data[y]
    print(f" {e['name']} ({e['election_date']}) -> council_terms.id={e['council_term_id']} status={e['results_status']}")
    for o, off in e['offices'].items():
        for c in off['candidates']:
            print(f"   {o:10} {c['name']:22} votes={c.get('votes')} elected={c['elected']} person={c.get('person_id', 'NEW')}")

sql = ['begin;']
for n in new_people:
    sql.append(f"insert into people (name, is_councillor, meta) values ({q(n)}, false, {jq({'created_for': 'historical election results import', 'created_on': TODAY})});")
for y in years:
    e = data[y]
    meta = {'historical_results_import': {
        'source_url': e['source_url'], 'source_note': e['source_note'], 'verified_on': TODAY,
        'results_status': e['results_status'], 'turnout': e['turnout'],
        'office_candidate_vote_sums': {o: sum(c.get('votes') or 0 for c in off['candidates']) for o, off in e['offices'].items()}}}
    sql.append(f"insert into elections (name, election_date, classification, term_length_years, results_status, source_url, meta) values ({q(e['name'])}, {q(e['election_date'])}, 'General', {e['term_length_years']}, {q(e['results_status'])}, {q(e['source_url'])}, {jq(meta)});")
    for o, off in e['offices'].items():
        sql.append(f"insert into election_offices (election_id, office, seats_available) select id, {q(o)}, {off['seats']} from elections where name={q(e['name'])};")
        for c in off['candidates']:
            cm = {'source_url': e['source_url'], 'ballot_name': c['name'], 'verified_on': TODAY, 'results_status': e['results_status']}
            pid = str(c['person_id']) if 'person_id' in c else f"(select id from people where name={q(c['name'])})"
            votes = 'null' if c.get('votes') is None else c['votes']
            sql.append(
                "insert into candidacies (election_office_id, person_id, is_elected, is_acclaimed, votes_received, meta) "
                f"select eo.id, {pid}, {str(c['elected']).lower()}, {str(bool(c.get('acclaimed'))).lower()}, {votes}, {jq(cm)} "
                f"from election_offices eo join elections el on el.id=eo.election_id where el.name={q(e['name'])} and eo.office={q(o)};")
    sql.append(f"update council_terms set election_id=(select id from elections where name={q(e['name'])}) where id={e['council_term_id']} and election_id is null;")
body = '\n'.join(sql)

if '--apply' not in sys.argv:
    print(run(body + '\nrollback;'))
    print('DRY RUN OK (rolled back). Statements:', len(sql))
    sys.exit(0)

backup = {}
names = [q(n) for n in new_people] + ["'Michael Mortimore'"]
for t, w in [('elections', 'true'), ('election_offices', 'true'), ('candidacies', 'true'),
             ('council_terms', 'id in (4,5,6)'), ('people', f"name in ({','.join(names)})")]:
    out = run(f"select coalesce(json_agg(t), '[]') from (select * from {t} where {w}) t", ['-t', '-A'])
    backup[t] = json.loads(out)
json.dump(backup, open(os.path.join(HERE, f'backup-{TODAY}.json'), 'w'), indent=1, default=str)
print(run(body + '\ncommit;'))
print('APPLIED')
