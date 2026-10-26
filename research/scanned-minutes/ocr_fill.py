"""Fill documents.full_text for scanned Minutes via Marker OCR (issue #62).
Run from apps/pipeline:  uv run python ../../research/scanned-minutes/ocr_fill.py dry|apply
dry:   OCR each doc, write dry-run.json (+ ocr-texts.json), no DB writes.
apply: back up the 13 rows to backup.json, then update passing docs in one transaction.
Mirrors ingester: full_text = scrub_emails(text.strip())."""
import json, os, re, sys, datetime
from pathlib import Path
import psycopg2
from pipeline.parser import get_pdf_text_ocr
from pipeline.ingestion.letter_privacy import scrub_emails

ROOT = Path("/Users/owen/Projects/viewroyal")
OUT = ROOT / "research/scanned-minutes"
SQL = """select d.id,m.meeting_date,m.archive_path,d.file_path,
 (select coalesce(sum(length(section_text)),0) from document_sections s where s.document_id=d.id)
 from documents d join meetings m on m.id=d.meeting_id
 where d.category='Minutes' and length(coalesce(d.full_text,''))<200 order by d.id"""

def env_url():
    for l in (ROOT / ".env").read_text().splitlines():
        if l.startswith("DATABASE_URL="):
            return l.split("=", 1)[1].strip().strip('"').strip("'")

def date_found(text, d):
    flat = re.sub(r"\s+", " ", text)
    pat = rf"{d.strftime('%B')}\s*0?{d.day}\s*(st|nd|rd|th)?\s*,?\s*{d.year}"
    return bool(re.search(pat, flat, re.I))

def main():
    mode = sys.argv[1]
    conn = psycopg2.connect(env_url())
    cur = conn.cursor()
    cur.execute(SQL)
    rows = cur.fetchall()
    ids = [r[0] for r in rows]
    print("docs:", ids)
    if mode == "dry":
        res, texts = [], {}
        for did, d, ap, fp, st in rows:
            pdf = ROOT / ap / fp
            print(f"OCR {did} {pdf.name}", flush=True)
            raw = get_pdf_text_ocr(str(pdf)) or ""
            text = scrub_emails(raw.strip())
            df = date_found(text, d)
            ok_len = len(text) >= 0.6 * st
            reason = [] if df and ok_len else ([] if df else ["date not found"]) + ([] if ok_len else ["too short vs sections"])
            res.append(dict(id=did, meeting_date=str(d), ocr_len=len(text), section_len=int(st),
                            ratio=round(len(text) / st, 2) if st else None, date_found=df,
                            passed=not reason, hold_reason="; ".join(reason), head=text[:300]))
            texts[did] = text
            print(res[-1]["id"], res[-1]["ocr_len"], st, df, res[-1]["passed"], flush=True)
            (OUT / "dry-run.json").write_text(json.dumps(res, indent=2))
            (OUT / "ocr-texts.json").write_text(json.dumps(texts))
    else:
        res = json.loads((OUT / "dry-run.json").read_text())
        texts = json.loads((OUT / "ocr-texts.json").read_text())
        cur.execute("select id, full_text from documents where id = any(%s) order by id", (ids,))
        (OUT / "backup.json").write_text(json.dumps([{"id": i, "full_text": t} for i, t in cur.fetchall()], indent=2))
        todo = [r["id"] for r in res if r["passed"] and r["id"] in ids]
        with conn:
            with conn.cursor() as c:
                for i in todo:
                    c.execute("update documents set full_text=%s where id=%s and length(coalesce(full_text,''))<200", (texts[str(i)], i))
                    assert c.rowcount == 1, i
        print("updated", todo)

main()
