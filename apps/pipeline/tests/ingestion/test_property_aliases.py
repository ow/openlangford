"""An address merged into another (properties.meta.merged_into) maps its mentions onto that address."""

from pipeline.ingestion import properties as props


class Table:
    def __init__(self, db, name):
        self.db, self.name, self.filters, self.op, self.payload = db, name, [], "select", None

    def select(self, *_a, **_k):
        return self

    def order(self, *_a, **_k):
        return self

    def range(self, start, end):
        self.window = (start, end)
        return self

    def eq(self, col, val):
        self.filters.append(lambda r: r.get(col) == val)
        return self

    def in_(self, col, vals):
        self.filters.append(lambda r: r.get(col) in vals)
        return self

    def upsert(self, rows, on_conflict):
        self.op, self.payload = "upsert", rows
        return self

    def insert(self, rows):
        self.op, self.payload = "insert", rows
        return self

    def update(self, patch):
        self.op, self.payload = "update", patch
        return self

    def delete(self):
        self.op = "delete"
        return self

    def execute(self):
        rows = self.db.setdefault(self.name, [])
        match = [r for r in rows if all(f(r) for f in self.filters)]
        if self.op == "select":
            start, end = getattr(self, "window", (0, 10**9))
            return type("R", (), {"data": match[start:end + 1]})
        if self.op == "upsert":
            out = []
            for row in self.payload:
                hit = next((r for r in rows if r["slug"] == row["slug"]), None)
                if hit:
                    hit.update(row)
                else:
                    hit = {"id": max([r["id"] for r in rows] + [0]) + 1, "meta": {}, **row}
                    rows.append(hit)
                out.append(hit)
            return type("R", (), {"data": out})
        if self.op == "insert":
            for row in self.payload:
                rows.append({"id": max([r["id"] for r in rows] + [0]) + 1, "hidden": False, **row})
            return type("R", (), {"data": self.payload})
        if self.op == "update":
            for r in match:
                r.update(self.payload)
        if self.op == "delete":
            self.db[self.name] = [r for r in rows if r not in match]
        return type("R", (), {"data": match})


class DB:
    def __init__(self, tables):
        self.tables = tables

    def table(self, name):
        return Table(self.tables, name)


def test_a_merged_spelling_links_to_the_address_it_was_merged_into(monkeypatch):
    for name in ("refresh_property_privacy", "geocode_missing", "mark_shared_points"):
        monkeypatch.setattr(props, name, lambda *a, **k: {})
    tables = {
        "matters": [{"id": 7, "title": "Road-length variance", "meta": {}, "merged_into": None}],
        "agenda_items": [{"id": 1, "matter_id": 7, "title": "Variance", "related_address": ["245 Atkins Road"], "geo_location": None},
                         {"id": 2, "matter_id": 7, "title": "Permit", "related_address": ["245 Atkins Avenue"], "geo_location": None}],
        "properties": [{"id": 10, "slug": "245-atkins-avenue", "geo": None, "meta": {}},
                       {"id": 11, "slug": "245-atkins-road", "geo": None, "meta": {"merged_into": 10}, "hidden": True}],
        "property_links": [],
    }
    props.build_properties(DB(tables))
    lots = {(l["property_id"], l["agenda_item_id"]) for l in tables["property_links"] if l["agenda_item_id"]}
    assert lots == {(10, 1), (10, 2)}
    assert any(p["id"] == 11 for p in tables["properties"])  # the alias stays, so its page redirects
