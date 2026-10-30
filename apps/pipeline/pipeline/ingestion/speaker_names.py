"""The ``speaker-names`` stage: name diarized transcript labels from evidence.

Reads a meeting's transcript rows, minutes roster (attendance), motions,
chair and voice centroids; asks ``speaker_identity.identify_meeting`` who each
label is; writes the names onto still-anonymous rows; and grows the voice
fingerprints from what it named.

Writes, per meeting:
- ``transcript_segments``: ``person_id``, ``speaker_name`` (the person's name) and
  ``attribution_source = 'SPEAKER_EVIDENCE'``, only on rows that have no person,
  are not verified and come from diarization (``UNNAMED_SOURCES``).
- ``meetings.meta.speaker_identity``: version, every decision with its evidence,
  held labels with the reason, and the row ids changed (so a re-run or a
  correction can revert exactly those rows).
- ``voice_exemplars``: one embedding per (meeting, label) for officials named here,
  subject to the drift guards; then each touched person's ``voice_fingerprints``
  row is recomputed as the mean of their exemplars.

Fingerprint design (self-reinforcing, guarded):
- Exemplars, not one blended vector: a person's voice is the set of per-meeting
  label centroids that evidence named, so different rooms/mics are covered and a
  bad exemplar can be removed without unwinding a running average.
- Only strong sources add exemplars: text evidence (calls, minutes motions,
  introductions, chair), a manual /speaker-alias mapping, or a voice-only match
  at >= ``VOICE_EXEMPLAR_MIN_SIMILARITY``/``VOICE_EXEMPLAR_MIN_MARGIN``. Only
  minutes-roster officials get exemplars; residents' voices are never stored.
- Drift check: once a person has ``DRIFT_MIN_EXEMPLARS`` evidenced exemplars, a new
  one must be >= ``DRIFT_MIN_SIMILARITY`` to their evidenced mean and beat every
  other person's mean by ``DRIFT_MIN_LEAD``, else it is rejected (and recorded).
- Manual mappings are the strongest anchor: a manual ``voice_fingerprints`` row
  (``source = 'manual'``) is copied in as a ``manual`` exemplar, is never
  overwritten, and is preferred as the drift reference.
- Confidence grows with evidence: ``voice_fingerprints.exemplar_count`` /
  ``meeting_count`` and ``confidence = n / (n + 2)``.
- Rebuild: ``--stage voice-fingerprints --target PERSON_ID`` (or no target for
  everyone) drops a person's non-manual exemplars and re-derives them from the
  meetings whose stored decisions name them with text evidence only.
"""

from __future__ import annotations

import json
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from pipeline.ingestion import speaker_identity as si
from pipeline.paths import BASE_DIR

ARCHIVE_BASE = Path(os.environ.get("ARCHIVE_BASE_DIR") or BASE_DIR)
TRANSCRIPT_EXCLUDED = ("_raw_transcript", "_segments", "_benchmark", "_gemini_speakers")
TEXT_KINDS = {"called", "introduced", "chair", "moved", "seconded"}


def _pages(build, size: int = 1000) -> list[dict]:
    rows, start = [], 0
    while True:
        chunk = build().range(start, start + size - 1).execute().data or []
        rows.extend(chunk)
        if len(chunk) < size:
            return rows
        start += size


# ── inputs ───────────────────────────────────────────────────────────────


def archive_transcript(archive_path: str | None) -> dict | None:
    if not archive_path:
        return None
    folder = ARCHIVE_BASE / archive_path
    if (folder / "shared_media.json").exists():
        return None
    files = sorted(p for p in (folder / "Audio").glob("*.json") if not any(x in p.name for x in TRANSCRIPT_EXCLUDED))
    if len(files) != 1:
        return None
    try:
        data = json.loads(files[0].read_text())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def minutes_text(archive_path: str | None) -> str:
    if not archive_path:
        return ""
    path = ARCHIVE_BASE / archive_path / "minutes.md"
    try:
        return path.read_text()
    except OSError:
        return ""


def recover_labels(rows: list[dict], transcript: dict | None) -> dict[int, str]:
    """Raw diarization label for rows whose speaker_name was replaced by a legacy name."""
    if not transcript:
        return {}
    by_time = defaultdict(set)
    for seg in transcript.get("segments") or []:
        if isinstance(seg, dict) and seg.get("start") is not None and seg.get("end") is not None:
            by_time[(round(float(seg["start"]), 2), round(float(seg["end"]), 2))].add(seg.get("speaker") or "")
    out = {}
    for r in rows:
        if si.is_diarized_label(r.get("speaker_name")):
            continue
        labels = by_time.get((round(r["start_time"] or 0, 2), round(r["end_time"] or 0, 2)), set())
        if len(labels) == 1:
            out[r["id"]] = next(iter(labels))
    return out


def meeting_inputs(sb, meeting_id: int) -> dict:
    meeting = (
        sb.table("meetings").select("id, meeting_date, archive_path, chair_person_id, meta")
        .eq("id", meeting_id).execute().data
    )
    if not meeting:
        raise ValueError(f"meeting {meeting_id} not found")
    meeting = meeting[0]
    rows = _pages(lambda: sb.table("transcript_segments").select(
        "id, speaker_name, person_id, start_time, end_time, text_content, attribution_source, is_verified"
    ).eq("meeting_id", meeting_id).order("start_time").order("id"))
    attendees = [
        {"id": a["person_id"], "name": (a.get("people") or {}).get("name")}
        for a in sb.table("attendance").select("person_id, people(name)").eq("meeting_id", meeting_id).execute().data or []
    ]
    motions = []
    for mo in sb.table("motions").select(
        "id, mover_id, seconder_id, text_content, time_offset_seconds, agenda_items(discussion_start_time)"
    ).eq("meeting_id", meeting_id).execute().data or []:
        t = mo.get("time_offset_seconds")
        if t is None:
            t = (mo.get("agenda_items") or {}).get("discussion_start_time")
        motions.append({**mo, "time": t})
    meta = meeting.get("meta") or {}
    centroids = meta.get("speaker_centroids") or {}
    need_json = not centroids or any(r["person_id"] and not si.is_diarized_label(r["speaker_name"]) for r in rows)
    transcript = archive_transcript(meeting.get("archive_path")) if need_json else None
    if not centroids and transcript:
        centroids = transcript.get("speaker_centroids") or {}
    return {
        "meeting": meeting, "rows": rows, "attendees": attendees, "motions": motions,
        "minutes": minutes_text(meeting.get("archive_path")), "centroids": centroids,
        "recovered": recover_labels(rows, transcript),
    }


def known_people(sb) -> list[dict]:
    """Everyone the minutes have ever listed as attending (officials), plus councillors."""
    ids = {r["person_id"] for r in _pages(lambda: sb.table("attendance").select("person_id").order("id"))}
    people = _pages(lambda: sb.table("people").select("id, name, is_councillor").order("id"))
    return [p for p in people if p["id"] in ids or p.get("is_councillor")]


# ── exemplars / fingerprints ─────────────────────────────────────────────


class VoiceBank:
    """All exemplars in memory; updated as meetings are processed."""

    def __init__(self, rows: list[dict]):
        self.rows = []
        for r in rows:
            u = si._unit(r.get("embedding"))
            if u is not None:
                self.rows.append({**r, "_unit": u, "source_meeting_id": r["meeting_id"]})

    @classmethod
    def load(cls, sb, *, required: bool = True) -> "VoiceBank":
        try:
            return cls(_pages(lambda: sb.table("voice_exemplars").select(
                "id, person_id, meeting_id, speaker_label, embedding, source, speech_seconds"
            ).order("id")))
        except Exception as e:  # table not migrated yet: only a dry run may continue
            if required:
                raise
            print(f"  [!] voice_exemplars unavailable ({e}); dry run without voice matching")
            return cls([])

    def reference_means(self) -> dict[int, list[float]]:
        """Per person: mean of manual exemplars if any, else of evidenced ones (never voice-only)."""
        groups: dict[int, dict[str, list]] = defaultdict(lambda: defaultdict(list))
        for r in self.rows:
            groups[r["person_id"]][r["source"]].append(r["_unit"])
        out = {}
        for pid, by_source in groups.items():
            vecs = by_source.get("manual") or (by_source.get("evidence") if len(by_source.get("evidence", [])) >= si.DRIFT_MIN_EXEMPLARS else None)
            if vecs:
                out[pid] = si._unit([sum(col) / len(vecs) for col in zip(*vecs)])
        return out

    def drift_check(self, person_id: int, vec) -> tuple[bool, dict]:
        u = si._unit(vec)
        if u is None:
            return False, {"reason": "bad_vector"}
        means = self.reference_means()
        own = means.get(person_id)
        if own is None:
            return True, {"reason": "no_reference_yet"}
        sim = si._dot(u, own)
        rival = max((si._dot(u, m) for p, m in means.items() if p != person_id), default=0.0)
        info = {"similarity": round(sim, 4), "best_other": round(rival, 4)}
        if sim < si.DRIFT_MIN_SIMILARITY or sim - rival < si.DRIFT_MIN_LEAD:
            return False, {**info, "reason": "drift"}
        return True, info

    def add(self, row: dict):
        self.rows = [r for r in self.rows if not (r["meeting_id"] == row["meeting_id"] and r["speaker_label"] == row["speaker_label"])]
        u = si._unit(row["embedding"])
        if u is not None:
            self.rows.append({**row, "_unit": u, "source_meeting_id": row["meeting_id"]})

    def drop_meeting(self, meeting_id: int, keep_manual: bool = True):
        self.rows = [r for r in self.rows if r["meeting_id"] != meeting_id or (keep_manual and r["source"] == "manual")]


def import_manual_fingerprints(sb, bank: VoiceBank, dry_run: bool) -> int:
    """Copy manual /speaker-alias fingerprints into the bank as manual exemplars."""
    try:
        rows = sb.table("voice_fingerprints").select("id, person_id, embedding, source_meeting_id, source").execute().data or []
    except Exception as e:
        if not dry_run:
            raise
        print(f"  [!] voice_fingerprints.source unavailable ({e}); dry run skips manual fingerprints")
        return 0
    added = 0
    for r in rows:
        if r.get("source") != "manual" or r.get("source_meeting_id") is None or si._unit(r.get("embedding")) is None:
            continue
        label = f"manual:{r['id']}"
        if any(x["speaker_label"] == label for x in bank.rows):
            continue
        ex = {"person_id": r["person_id"], "meeting_id": r["source_meeting_id"], "speaker_label": label,
              "embedding": r["embedding"], "source": "manual", "confidence": 1.0, "speech_seconds": None,
              "evidence": {"voice_fingerprint_id": r["id"]}}
        if not dry_run:
            sb.table("voice_exemplars").upsert(ex, on_conflict="meeting_id,speaker_label").execute()
        bank.add(ex)
        added += 1
    return added


def refresh_fingerprints(sb, bank: VoiceBank, person_ids, dry_run: bool) -> int:
    """Recompute each person's aggregate voice_fingerprints row from their exemplars."""
    if dry_run or not person_ids:
        return 0
    existing = {r["person_id"]: r for r in sb.table("voice_fingerprints").select("id, person_id, source")
                .in_("person_id", sorted(person_ids)).execute().data or []}
    done = 0
    for pid in sorted(person_ids):
        if (existing.get(pid) or {}).get("source") == "manual":
            continue  # a manual mapping stays the person's fingerprint
        mine = [r for r in bank.rows if r["person_id"] == pid and r["source"] in ("evidence", "voice", "manual")]
        if not mine:
            if pid in existing:
                sb.table("voice_fingerprints").delete().eq("person_id", pid).eq("source", "aggregate").execute()
            continue
        mean = si._unit([sum(col) / len(mine) for col in zip(*(r["_unit"] for r in mine))])
        meetings = {r["meeting_id"] for r in mine}
        n = len(meetings)
        row = {"person_id": pid, "embedding": mean, "source": "aggregate",
               "source_meeting_id": max(meetings), "exemplar_count": len(mine), "meeting_count": n,
               "confidence": round(n / (n + 2), 4)}
        sb.table("voice_fingerprints").upsert(row, on_conflict="person_id").execute()
        done += 1
    return done


# ── per meeting ──────────────────────────────────────────────────────────


def _revert(sb, meeting_id: int, previous: dict, dry_run: bool) -> int:
    """Put rows this stage named back to their diarization label."""
    n = 0
    for label, entry in (previous.get("labels") or {}).items():
        ids = entry.get("segment_ids") or []
        if not ids or not entry.get("person_id"):
            continue
        n += len(ids)
        if dry_run:
            continue
        for i in range(0, len(ids), 200):
            sb.table("transcript_segments").update({
                "person_id": None, "speaker_name": label,
                "attribution_source": entry.get("previous_source") or "UNIDENTIFIED_DIARIZATION",
            }).in_("id", ids[i:i + 200]).eq("meeting_id", meeting_id).eq(
                "attribution_source", si.ATTRIBUTION_SOURCE).eq("person_id", entry["person_id"]).execute()
    return n


def name_meeting(sb, meeting_id: int, bank: VoiceBank, people: list[dict], *, dry_run: bool = False,
                 force: bool = False) -> dict:
    data = meeting_inputs(sb, meeting_id)
    meeting, rows = data["meeting"], data["rows"]
    meta = meeting.get("meta") or {}
    previous = meta.get("speaker_identity") or {}
    if previous.get("version") == si.IDENTITY_VERSION and not force:
        return {"meeting_id": meeting_id, "status": "current"}
    if not rows:
        return {"meeting_id": meeting_id, "status": "no_transcript"}

    # Evidence sees rows with their raw label, including rows named before (legacy or by us).
    ours = {i for e in (previous.get("labels") or {}).values() for i in (e.get("segment_ids") or [])}
    prev_label = {i: label for label, e in (previous.get("labels") or {}).items() for i in (e.get("segment_ids") or [])}
    evidence_rows = []
    legacy = defaultdict(Counter)  # label -> person ids already named by an older method
    for r in rows:
        label = prev_label.get(r["id"]) or data["recovered"].get(r["id"]) or r["speaker_name"]
        evidence_rows.append({**r, "speaker_name": label})
        if r["person_id"] and r["id"] not in ours and si.is_diarized_label(label):
            legacy[label][r["person_id"]] += 1

    voice_rows = [x for x in bank.rows if x["meeting_id"] != meeting_id]
    result = si.identify_meeting(
        evidence_rows, data["attendees"], known_people=people, minutes=data["minutes"],
        chair_person_id=meeting.get("chair_person_id"), centroids=data["centroids"],
        fingerprints=voice_rows, meeting_id=meeting_id, motions=data["motions"],
        person_means=VoiceBank(voice_rows).reference_means() if voice_rows else None,
    )
    labels = result["labels"]
    for label, entry in labels.items():
        prior = legacy.get(label)
        if entry.get("person_id") and prior:
            top, _ = prior.most_common(1)[0]
            if top != entry["person_id"]:
                entry["held"] = "older_name_disagrees"
                entry.pop("person_id")

    # Rows to write: still anonymous diarization rows (or ours, when re-running).
    by_label = defaultdict(list)
    for r, er in zip(rows, evidence_rows):
        mine = r["id"] in ours
        if r.get("is_verified") or (r["person_id"] and not mine):
            continue
        if not mine and r.get("attribution_source") not in si.UNNAMED_SOURCES:
            continue
        by_label[er["speaker_name"]].append(r)

    reverted = _revert(sb, meeting_id, previous, dry_run) if previous.get("labels") else 0
    written, named_labels = 0, {}
    for label, entry in labels.items():
        pid = entry.get("person_id")
        if not pid:
            continue
        targets = by_label.get(label, [])
        ids = [r["id"] for r in targets]
        sources = Counter("UNIDENTIFIED_DIARIZATION" if r["id"] in ours else r["attribution_source"] for r in targets)
        named_labels[label] = {
            **{k: entry[k] for k in ("person_id", "name", "score", "share", "kinds", "on_roster", "voice", "seconds")
               if k in entry},
            "evidence": entry["evidence"][:6], "segment_ids": ids,
            "previous_source": sources.most_common(1)[0][0] if sources else "UNIDENTIFIED_DIARIZATION",
        }
        written += len(ids)
        if dry_run or not ids:
            continue
        for i in range(0, len(ids), 200):
            sb.table("transcript_segments").update({
                "person_id": pid, "speaker_name": entry["name"], "attribution_source": si.ATTRIBUTION_SOURCE,
            }).in_("id", ids[i:i + 200]).eq("meeting_id", meeting_id).is_("person_id", "null").execute()

    # Grow fingerprints from officials named here.
    exemplar_log, touched = {}, set()
    roster = {a["id"] for a in data["attendees"]}
    keyed = {si.label_number(k): v for k, v in (data["centroids"] or {}).items() if si.label_number(k) is not None}
    bank.drop_meeting(meeting_id)
    if not dry_run:
        sb.table("voice_exemplars").delete().eq("meeting_id", meeting_id).neq("source", "manual").execute()
    for label, entry in labels.items():
        pid, vec = entry.get("person_id"), keyed.get(si.label_number(label))
        if not pid or vec is None or pid not in roster or entry["seconds"] < si.FINGERPRINT_MIN_SECONDS:
            continue
        kinds = set(entry.get("kinds") or {})
        if kinds & TEXT_KINDS:
            source = "evidence"
        else:
            v = entry.get("voice") or {}
            if v.get("similarity", 0) < si.VOICE_EXEMPLAR_MIN_SIMILARITY or v.get("margin", 0) < si.VOICE_EXEMPLAR_MIN_MARGIN:
                exemplar_log[label] = {"added": False, "reason": "voice_match_not_strong_enough"}
                continue
            source = "voice"
        ok, info = bank.drift_check(pid, vec)
        exemplar_log[label] = {"added": ok, **info}
        if not ok:
            continue
        ex = {"person_id": pid, "meeting_id": meeting_id, "speaker_label": label, "embedding": [float(x) for x in vec],
              "source": source, "speech_seconds": entry["seconds"],
              "confidence": round(min(1.0, entry.get("score", 0) / 6), 3),
              "evidence": {"kinds": entry.get("kinds"), "voice": entry.get("voice")}}
        if not dry_run:
            sb.table("voice_exemplars").upsert(ex, on_conflict="meeting_id,speaker_label").execute()
        bank.add(ex)
        touched.add(pid)

    held = {label: e["held"] for label, e in labels.items() if e.get("held")}
    record = {
        "version": si.IDENTITY_VERSION, "run_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "chair": result.get("chair"), "labels": named_labels, "held": held, "exemplars": exemplar_log,
        "unnamed_labels": sorted(l for l, e in labels.items() if not e.get("person_id")),
    }
    if not dry_run:
        fresh = sb.table("meetings").select("meta").eq("id", meeting_id).execute().data[0].get("meta") or {}
        fresh["speaker_identity"] = record
        sb.table("meetings").update({"meta": fresh}).eq("id", meeting_id).execute()
    total = sum(max(0.0, (r["end_time"] or 0) - (r["start_time"] or 0)) for r in rows)
    named_secs = sum(e.get("seconds", 0) for e in named_labels.values())
    return {"meeting_id": meeting_id, "status": "dry_run" if dry_run else "named", "labels_named": len(named_labels),
            "labels": len(labels), "rows_named": written, "rows_reverted": reverted, "held": held,
            "named_seconds_share": round(named_secs / total, 3) if total else 0.0, "touched_people": sorted(touched),
            "decisions": {l: (e["name"], e.get("kinds")) for l, e in named_labels.items()}}


# ── stage entry points ───────────────────────────────────────────────────


def stale_meetings(sb) -> list[int]:
    rows = _pages(lambda: sb.table("meetings").select("id, version:meta->speaker_identity->>version, has_transcript").order("id"))
    return [r["id"] for r in rows if r.get("has_transcript") and r.get("version") != si.IDENTITY_VERSION]


def name_meetings(sb, meeting_ids: list[int], *, dry_run: bool = False, force: bool = False, log=print) -> dict:
    bank = VoiceBank.load(sb, required=not dry_run)
    import_manual_fingerprints(sb, bank, dry_run)
    people = known_people(sb)
    results, touched = [], set()
    for mid in meeting_ids:
        try:
            res = name_meeting(sb, mid, bank, people, dry_run=dry_run, force=force)
        except Exception as e:  # one meeting failing shouldn't stop the rest
            log(f"  [!] speaker-names failed for meeting {mid}: {e}")
            results.append({"meeting_id": mid, "status": "error", "error": str(e)})
            continue
        results.append(res)
        touched.update(res.get("touched_people") or [])
        if res["status"] in ("named", "dry_run"):
            log(f"  [Speakers] meeting {mid}: {res['labels_named']}/{res['labels']} labels, {res['rows_named']} rows, "
                f"{res['named_seconds_share']:.0%} of speech" + (f", held {res['held']}" if res["held"] else ""))
    refreshed = refresh_fingerprints(sb, bank, touched, dry_run)
    return {"meetings": len(meeting_ids), "results": results, "fingerprints_refreshed": refreshed}


def rebuild_exemplars(sb, person_ids: list[int] | None, *, dry_run: bool = False, log=print) -> dict:
    """Drop non-manual exemplars (for ``person_ids`` or everyone) and re-derive them from the
    stored decisions that name the person with text evidence (never from voice-only names)."""
    bank = VoiceBank.load(sb)
    targets = set(person_ids) if person_ids else {r["person_id"] for r in bank.rows}
    meetings = _pages(lambda: sb.table("meetings").select("id, archive_path, meta->speaker_identity, meta->speaker_centroids").order("meeting_date").order("id"))
    if not dry_run:
        for pid in sorted(targets):
            sb.table("voice_exemplars").delete().eq("person_id", pid).neq("source", "manual").execute()
    bank.rows = [r for r in bank.rows if r["person_id"] not in targets or r["source"] == "manual"]
    added = rejected = 0
    for m in meetings:
        ident = m.get("speaker_identity") or {}
        cents = m.get("speaker_centroids") or (archive_transcript(m.get("archive_path")) or {}).get("speaker_centroids") or {}
        keyed = {si.label_number(k): v for k, v in cents.items() if si.label_number(k) is not None}
        for label, e in (ident.get("labels") or {}).items():
            pid = e.get("person_id")
            if (person_ids and pid not in targets) or not e.get("on_roster") or not (set(e.get("kinds") or {}) & TEXT_KINDS):
                continue
            vec = keyed.get(si.label_number(label))
            if vec is None or (e.get("seconds") or 0) < si.FINGERPRINT_MIN_SECONDS:
                continue
            ok, _ = bank.drift_check(pid, vec)
            if not ok:
                rejected += 1
                continue
            ex = {"person_id": pid, "meeting_id": m["id"], "speaker_label": label, "embedding": [float(x) for x in vec],
                  "source": "evidence", "speech_seconds": e.get("seconds"),
                  "confidence": round(min(1.0, (e.get("score") or 0) / 6), 3), "evidence": {"kinds": e.get("kinds"), "rebuilt": True}}
            if not dry_run:
                sb.table("voice_exemplars").upsert(ex, on_conflict="meeting_id,speaker_label").execute()
            bank.add(ex)
            added += 1
    refreshed = refresh_fingerprints(sb, bank, targets | {r["person_id"] for r in bank.rows}, dry_run)
    log(f"  [Voice] {'would add' if dry_run else 'added'} {added} exemplar(s), rejected {rejected} by drift check, "
        f"refreshed {refreshed} fingerprint(s)")
    return {"added": added, "rejected": rejected, "refreshed": refreshed}
