from collections import Counter
import glob
import hashlib
import json
import os
import re
import time

import requests as http_requests
from bs4 import BeautifulSoup
from supabase import Client
from pipeline.supabase_client import create_client

import pipeline.parser as parser
from pipeline import utils
from pipeline.alignment import align_meeting_items
from pipeline.names import CANONICAL_NAMES
from pipeline.speaker_evidence import label_key
from pipeline.ingestion.ai_refiner import refine_meeting_data
from pipeline.ingestion.roster_attendance import find_original_minutes_pdf, minutes_source_url, roster_attendance
from pipeline.ingestion.summary_format import normalize_meeting_summary
from pipeline.ingestion.key_statement_evidence import format_refinement_transcript, load_statement_context, bind_key_statement, publish_key_statement
from pipeline.ingestion.vote_evidence import match_motion_record, named_votes, outcome_family
from pipeline.ingestion.vote_evidence import normalize_text
from pipeline.ingestion.meeting_ballots import prepare_ballot_context, merge_ballot_evidence, index_prior_ballots
from pipeline.ingestion.canonical_motions import canonical_motion_plan, existing_agenda_item, source_receipt_current, write_source_receipt, source_candidate_inventory, source_validation_inputs
from pipeline.ingestion.source_claims import build_claim_inventory, intended_claim_transition, intended_inventory, record_intended_claim_write, valid_inventory
from pipeline.paths import BASE_DIR
# document_chunker kept as fallback — imported dynamically in document_extractor.py
from pipeline.ingestion.matter_matching import (
    MatterMatcher,
    detect_entity_cluster,
    is_matter_eligible,
    is_valid_matter_identifier,
    matter_aliases_for_cluster,
)
from pipeline.video.vimeo import VimeoClient


def to_seconds(val):
    if isinstance(val, (int, float)):
        return float(val)
    if isinstance(val, str) and ":" in val:
        try:
            parts = val.split(":")
            if len(parts) == 3:  # HH:MM:SS
                return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
            if len(parts) == 2:  # MM:SS
                return float(parts[0]) * 60 + float(parts[1])
        except:
            pass
    return None


def motion_hold_applies(is_planned_meeting, classification, ballot_context):
    """True when a non-Council body's ballot rules are unvalidated, so AI motions are held as unverified."""
    return (not is_planned_meeting and classification not in ("Council", "Committee of the Whole")
            and (ballot_context or {}).get("status") == "committee_membership_rules_need_validation")


class MeetingIngester:
    def __init__(self, supabase_url, supabase_key, municipality_id=None):
        if not supabase_url or not supabase_key:
            raise ValueError("Supabase credentials required")

        self.supabase: Client = create_client(supabase_url, supabase_key)
        self.municipality_id = municipality_id or 1  # Default to View Royal

        self.matcher = MatterMatcher(self.supabase, municipality_id=self.municipality_id)
        self._canonical_names = None  # Lazy-loaded per municipality
        self._municipality_source_config = None

    def _get_canonical_names(self):
        """Load canonical names for this municipality from the DB.

        Fetches all known people associated with this municipality's organizations.
        Falls back to hardcoded CANONICAL_NAMES for View Royal (municipality_id=1).
        """
        if self._canonical_names is not None:
            return self._canonical_names

        try:
            # Get all people linked to this municipality's organizations via memberships
            orgs = (
                self.supabase.table("organizations")
                .select("id")
                .eq("municipality_id", self.municipality_id)
                .execute()
            )
            if orgs.data:
                org_ids = [o["id"] for o in orgs.data]
                res = (
                    self.supabase.table("memberships")
                    .select("person:people(name)")
                    .in_("organization_id", org_ids)
                    .execute()
                )
                names = list({
                    m["person"]["name"]
                    for m in res.data
                    if m.get("person") and m["person"].get("name")
                })
                if names:
                    self._canonical_names = names
                    return self._canonical_names
        except Exception as e:
            print(f"  [!] Failed to load canonical names from DB: {e}")

        # Fallback to hardcoded list for View Royal
        self._canonical_names = CANONICAL_NAMES
        return self._canonical_names

    def _get_municipality_source_config(self) -> dict:
        if self._municipality_source_config is not None:
            return self._municipality_source_config

        try:
            result = (
                self.supabase.table("municipalities")
                .select("source_config")
                .eq("id", self.municipality_id)
                .maybe_single()
                .execute()
            )
            self._municipality_source_config = (result.data or {}).get("source_config") or {}
        except Exception as e:
            print(f"  [!] Could not load municipality source config: {e}")
            self._municipality_source_config = {}
        return self._municipality_source_config

    def _should_search_vimeo(self) -> bool:
        source_config = self._get_municipality_source_config()
        video_config = source_config.get("video_source") or {}
        return video_config.get("type", "vimeo") == "vimeo"

    @staticmethod
    def _read_archived_player_url(folder_path: str) -> str | None:
        player_url_path = os.path.join(folder_path, "Video", "player.url")
        if not os.path.exists(player_url_path):
            return None
        try:
            with open(player_url_path, "r", encoding="utf-8") as f:
                return f.read().strip() or None
        except OSError as e:
            print(f"  [!] Error reading archived video URL: {e}")
            return None

    def _get_active_council_members(self, meeting_date):
        """Fetch names of council members active on the given date."""
        try:
            # 1. Get Council Org ID
            orgs = (
                self.supabase.table("organizations")
                .select("id")
                .eq("classification", "Council")
                .eq("municipality_id", self.municipality_id)
                .execute()
            )
            if not orgs.data:
                return []
            org_ids = [o["id"] for o in orgs.data]

            # 2. Get Memberships active on date
            res = (
                self.supabase.table("memberships")
                .select("person:people(name)")
                .in_("organization_id", org_ids)
                .lte("start_date", meeting_date)
                .or_(f"end_date.is.null,end_date.gte.{meeting_date}")
                .execute()
            )

            names = [
                m["person"]["name"]
                for m in res.data
                if m.get("person") and m["person"].get("name")
            ]
            # Deduplicate names by converting to a set and back to a list
            return list(set(names))
        except Exception as e:
            print(f"  [!] Failed to fetch active council members: {e}")
            return []

    def _write_roster_attendance(self, meeting_id, org_id, meeting_date, folder_path, dry_run=False):
        """Upsert evidence-backed attendance for sitting council members from the original minutes.

        Returns the person_ids written (empty when the roster cannot be read or resolved)."""
        pdf = find_original_minutes_pdf(folder_path)
        if not pdf or not meeting_id or not org_id:
            return set()
        try:
            res = (
                self.supabase.table("memberships")
                .select("person_id,person:people(name)")
                .eq("organization_id", org_id)
                .lte("start_date", meeting_date)
                .or_(f"end_date.is.null,end_date.gte.{meeting_date}")
                .execute()
            )
            members = {m["person_id"]: {"person_id": m["person_id"], "name": (m.get("person") or {}).get("name")}
                       for m in res.data if m.get("person_id")}
            minutes_url = (self.supabase.table("meetings").select("minutes_url").eq("id", meeting_id).single().execute().data or {}).get("minutes_url")
            result = roster_attendance(list(members.values()), meeting_id, str(meeting_date), pdf,
                                       minutes_source_url(pdf, minutes_url))
        except Exception as e:
            print(f"  [!] Roster attendance skipped: {e}")
            return set()
        if result["status"] != "ok":
            print(f"  [Attendance] Minutes roster not used ({result['status']}); keeping AI attendee list.")
            return set()
        for rec in result["records"]:
            if not dry_run:
                self.supabase.table("attendance").upsert(
                    {"meeting_id": meeting_id, **rec}, on_conflict="meeting_id,person_id"
                ).execute()
        print(f"  [Attendance] {len(result['records'])} council members from minutes roster; {len(result['unresolved'])} unresolved.")
        return {r["person_id"] for r in result["records"]}

    def get_or_create_organization(self, name, classification, dry_run=False):
        if dry_run:
            return 999
        res = (
            self.supabase.table("organizations")
            .select("id")
            .eq("name", name)
            .eq("municipality_id", self.municipality_id)
            .execute()
        )
        if res.data:
            return res.data[0]["id"]

        print(f"Creating Organization: {name}")
        data = {
            "name": name,
            "classification": classification,
            "municipality_id": self.municipality_id,
        }
        res = self.supabase.table("organizations").insert(data).execute()
        return res.data[0]["id"]

    def get_or_create_person(self, name, dry_run=False):
        if not name:
            return None

        # 1. Basic Junk Filter
        if "Speaker_" in name or "Unknown" in name or name.lower().strip() == "speaker":
            return None

        # 2. Extract roles before cleaning
        roles = utils.extract_roles_from_name(name)

        # 3. Clean and Canonicalize
        clean_name = utils.normalize_person_name(name)

        # 4. Final Validation against Junk/Blocklist
        from pipeline.names import is_valid_name

        if not is_valid_name(clean_name):
            return None

        if dry_run:
            return 888

        # 5. Get or Create Person
        res = (
            self.supabase.table("people").select("id").eq("name", clean_name).execute()
        )
        is_new_person = False
        if res.data:
            person_id = res.data[0]["id"]
        else:
            # Match existing
            all_people = self.supabase.table("people").select("id, name").execute().data
            existing_id = utils.match_person(clean_name, all_people)

            if existing_id:
                person_id = existing_id
            else:
                # Strict Rule: Do not create new Council members from meeting ingestion.
                # They must exist in the DB via election seeding.
                is_council_related = any(org_type == "Council" for _, org_type in roles)
                if is_council_related:
                    print(
                        f"  [!] Skipping creation of potential Council member: {clean_name} (Not found in election DB)"
                    )
                    return None

                print(f"Creating Person: {clean_name}")
                p_res = (
                    self.supabase.table("people").insert({"name": clean_name}).execute()
                )
                person_id = p_res.data[0]["id"]
                is_new_person = True

        # 6. Record Memberships/Roles
        for role, org_type in roles:
            if not is_new_person and org_type != "Staff":
                continue

            org_id = self.get_or_create_organization(org_type, org_type, dry_run)

            m_exists = (
                self.supabase.table("memberships")
                .select("id")
                .eq("person_id", person_id)
                .eq("organization_id", org_id)
                .eq("role", role)
                .execute()
            )

            if not m_exists.data:
                print(f"  [+] Recording Role: {clean_name} as {role} ({org_type})")
                self.supabase.table("memberships").insert(
                    {"person_id": person_id, "organization_id": org_id, "role": role}
                ).execute()

        return person_id

    def get_or_create_matter(
        self, identifier, title, date=None, dry_run=False, related_addresses=None
    ):
        # Use new matcher logic
        matter_id, reason, confidence = self.matcher.find_match(
            identifier, title, related_addresses, meeting_date=str(date) if date else None
        )
        if reason == "policy_review":
            print(f"  [!] Matter identity requires review: {title}")
            return None
        weak = bool(matter_id) and str(reason).startswith(("title_similarity", "address"))
        if (weak or not matter_id) and not str(reason).startswith("policy_") and (identifier or title) and not dry_run:
            # Exact signals failed; let the resolver judge plausible candidates.
            from pipeline.ingestion.matter_matching import extract_addresses, normalize_address
            from pipeline.ingestion.matter_resolver import resolve_incoming

            addrs = {normalize_address(a) for a in (related_addresses or []) if a}
            addrs.update(extract_addresses(title or ""))
            weak_id = matter_id
            matter_id, reason = resolve_incoming(self.matcher, identifier, title, addrs, date=str(date) if date else None)
            if weak_id and reason == "decision_error":
                matter_id = weak_id  # API unavailable: keep the heuristic match rather than fork a new matter
            elif weak_id and matter_id != weak_id:
                print(f"  [~] Resolver overruled weak match {weak_id} for '{title}' -> {matter_id or 'new'}")
            if matter_id:
                print(f"  [~] Resolver linked '{title}' -> matter {matter_id} ({reason})")

        if matter_id:
            # Update existing matter dates if provided
            if date and not dry_run:
                res = (
                    self.supabase.table("matters")
                    .select("first_seen, last_seen")
                    .eq("id", matter_id)
                    .execute()
                )
                if res.data:
                    first = res.data[0].get("first_seen")
                    last = res.data[0].get("last_seen")
                    updates = {}
                    if not first or str(date) < str(first):
                        updates["first_seen"] = date
                    if not last or str(date) > str(last):
                        updates["last_seen"] = date

                    if updates:
                        self.supabase.table("matters").update(updates).eq(
                            "id", matter_id
                        ).execute()
            return matter_id

        if not identifier and not title:
            return None

        # No match found. Create new matter.
        final_identifier = identifier
        if identifier and ";" in identifier:
            # Use first valid identifier part if compound
            final_identifier = identifier.split(";")[0].strip()

        display_id = final_identifier or "(title-only)"
        print(f"  [+] New Matter Identified: {display_id} - {title}")
        if dry_run:
            return 777

        # Guess category from identifier or title
        source_text = identifier or title or ""
        category = "General"
        if "Bylaw" in source_text:
            category = "Bylaw"
        elif any(kw in source_text for kw in ("Permit", "DVP", "DP", "Rezoning", "REZ")):
            category = "Development"

        data = {
            "title": title,
            "category": category,
            "status": "Active",
            "first_seen": date,
            "last_seen": date,
            "municipality_id": self.municipality_id,
        }
        cluster_id = detect_entity_cluster(title)
        if cluster_id:
            data["meta"] = {
                "entity_cluster": cluster_id,
                "aliases": matter_aliases_for_cluster(cluster_id),
                "matter_quality": "canonical",
                "alias_sources": ["rule"],
            }
        if identifier:
            data["identifier"] = identifier

        try:
            res = self.supabase.table("matters").insert(data).execute()
        except Exception as error:
            # The identifier is unique: the matcher missed an existing matter (or a parallel ingest
            # created it a moment ago). Link to that matter, following a merge to its canonical row.
            if not identifier or "matters_identifier_key" not in str(error):
                raise
            existing = (self.supabase.table("matters").select("*").eq("identifier", identifier)
                        .limit(1).execute().data)
            if not existing:
                raise
            row = existing[0]
            canonical = (row.get("meta") or {}).get("canonical_matter_id")
            print(f"  [~] {identifier} already exists as matter {row['id']}; linking to it")
            self.matcher._add_matter_to_indices(row)
            return int(canonical) if canonical else row["id"]
        new_record = res.data[0]
        # Update matcher cache to avoid duplicates in the same run
        self.matcher._add_matter_to_indices(new_record)
        return new_record["id"]

    def find_transcript(self, base_folder):
        folder = os.path.join(base_folder, "Audio")
        if not os.path.exists(folder):
            return None
        files = glob.glob(os.path.join(glob.escape(folder), "*.json"))
        for f in files:
            if any(
                x in f
                for x in [
                    "_raw_transcript.json",
                    "_segments.json",
                    "shared_media.json",
                    "refinement.json",
                    "attendance.json",
                    "_benchmark.json",
                    "_gemini_speakers.json",
                ]
            ):
                continue
            return f
        return None

    def get_raw_texts(self, folder_path, skip_cache=False):
        # Support for shared media pointers
        source_folder = folder_path
        shared_path = os.path.join(folder_path, "shared_media.json")
        if os.path.exists(shared_path):
            try:
                with open(shared_path, "r", encoding="utf-8") as f:
                    shared_data = json.load(f)
                    # Resolve relative path
                    source_folder = os.path.abspath(
                        os.path.join(folder_path, shared_data["canonical_folder"])
                    )
                    print(
                        f"  [Shared Media] Using transcript from: {os.path.basename(source_folder)}"
                    )
            except Exception as e:
                print(f"  [!] Error reading shared_media.json: {e}")

        # Agenda
        agenda_text = ""
        cached_agenda_path = os.path.join(folder_path, "agenda.md")
        if not skip_cache and os.path.exists(cached_agenda_path):
            with open(cached_agenda_path, "r", encoding="utf-8") as f:
                agenda_text = f.read()
        else:
            # Fall back to PDF extraction
            agenda_folder = os.path.join(source_folder, "Agenda")
            pdf_files = sorted(glob.glob(os.path.join(glob.escape(agenda_folder), "*.pdf")))
            if pdf_files:
                all_texts = []
                for pdf_file in pdf_files:
                    text = parser.get_pdf_text(pdf_file)
                    if len(text.strip()) < 100:
                        text = parser.get_pdf_text_ocr(pdf_file)
                    if text.strip():
                        all_texts.append(text)
                agenda_text = "\n\n---\n\n".join(all_texts)

            if not agenda_text or len(agenda_text.strip()) < 100:
                print(f"  [Fallback] Trying HTML for Agenda...")
                html_files = glob.glob(os.path.join(glob.escape(agenda_folder), "*.html"))
                if html_files:
                    try:
                        html_content = utils.read_text_file(html_files[0])
                        agenda_text = BeautifulSoup(
                            html_content, "html.parser"
                        ).get_text("\n", strip=True)
                    except Exception as e:
                        print(f"  [!] HTML fallback failed: {e}")

        # Minutes - check for cached Marker markdown first (2700x faster)
        minutes_text = ""
        cached_minutes_path = os.path.join(folder_path, "minutes.md")
        if not skip_cache and os.path.exists(cached_minutes_path):
            with open(cached_minutes_path, "r", encoding="utf-8") as f:
                minutes_text = f.read()
        else:
            # Fall back to PDF extraction
            minutes_folder = os.path.join(folder_path, "Minutes")
            pdf_files = sorted(glob.glob(os.path.join(glob.escape(minutes_folder), "*.pdf")))
            if pdf_files:
                all_texts = []
                for pdf_file in pdf_files:
                    text = parser.get_pdf_text(pdf_file)
                    if len(text.strip()) < 100:
                        text = parser.get_pdf_text_ocr(pdf_file)
                    if text.strip():
                        all_texts.append(text)
                minutes_text = "\n\n---\n\n".join(all_texts)

            if not minutes_text or len(minutes_text.strip()) < 100:
                print(f"  [Fallback] Trying HTML for Minutes...")
                html_files = glob.glob(os.path.join(glob.escape(minutes_folder), "*.html"))
                if html_files:
                    try:
                        html_content = utils.read_text_file(html_files[0])
                        minutes_text = BeautifulSoup(
                            html_content, "html.parser"
                        ).get_text("\n", strip=True)
                    except Exception as e:
                        print(f"  [!] HTML fallback failed: {e}")

        # Transcript
        transcript_text = ""

        transcript_path = self.find_transcript(source_folder)
        # print(f"  [DEBUG] Selected transcript path: {transcript_path}")

        # Check for raw transcript if diarized one is missing
        raw_transcript_path = None
        if not transcript_path:
            raw_path_audio = os.path.join(source_folder, "Audio", "raw_transcript.json")
            if os.path.exists(raw_path_audio):
                raw_transcript_path = raw_path_audio

        if transcript_path and os.path.exists(transcript_path):
            with open(transcript_path, "rb") as f:
                raw = f.read()
            data = json.loads(raw)
            transcript_text = format_refinement_transcript(data, hashlib.sha256(raw).hexdigest())
        elif raw_transcript_path:
            try:
                with open(raw_transcript_path, "rb") as f:
                    raw = f.read()
                data = json.loads(raw)
                if isinstance(data, list) or isinstance(data, dict) and "segments" in data:
                    transcript_text = format_refinement_transcript(data, hashlib.sha256(raw).hexdigest())
                elif isinstance(data, dict) and "text" in data:
                    transcript_text = data["text"]
            except Exception as e:
                print(f"  [!] Error reading raw transcript: {e}")

        # print(f"  [DEBUG] Final transcript text length: {len(transcript_text)}")

        return agenda_text, minutes_text, transcript_text

    def _slugify(self, text):
        if not text:
            return ""
        s = str(text).lower().strip()
        s = re.sub(r'[^\w\s-]', '', s)
        return re.sub(r'[-\s]+', '-', s).strip('-_')

    def extract_identifier_from_text(self, text):
        if not text:
            return None

        # 1. Prioritize Amendment Bylaws (e.g. "Amendment Bylaw No. 1101")
        # This prevents aggregating all amendments into the base "Bylaw 900"
        amendment_pattern = r"(?:Amendment\s+)?Bylaw\s+(?:No\.?\s*)?(\d+)"
        if "amendment" in text.lower():
            amend_idx = text.lower().find("amendment")
            matches = list(re.finditer(amendment_pattern, text, re.IGNORECASE))
            for match in matches:
                if match.start() >= amend_idx:
                    return f"Bylaw {match.group(1)}"

        # 2. General patterns
        patterns = [
            r"(Bylaw\s+(?:No\.?\s*)?\d+(?:-\d+)?)",
            r"((?:Rezoning|REZ)\s+(?:Application\s+)?(?:No\.?\s*)?\d{4}[\-\/]\d{2})",
            r"((?:Temporary\s+Use\s+Permit|TUP)\s+(?:No\.?\s*)?\d{4}[\-\/]\d{2})",
            r"(Development\s+Variance\s+Permit\s+(?:No\.?\s*)?\d{4}[\-\/]\d{2})",
            r"(DVP\s+(?:No\.?\s*)?\d{4}[\-\/]\d{2})",
            r"(Development\s+Permit\s+(?:No\.?\s*)?\d{4}[\-\/]\d{2})",
            r"(DP\s+(?:No\.?\s*)?\d{4}[\-\/]\d{2})",
        ]
        for pat in patterns:
            match = re.search(pat, text, re.IGNORECASE)
            if match:
                # Normalize "Bylaw No. 123" to "Bylaw 123" for consistency
                val = match.group(1).strip()
                if val.lower().startswith("bylaw"):
                    num_match = re.search(r"\d+", val)
                    if num_match:
                        return f"Bylaw {num_match.group(0)}"
                return val
        return None

    def map_type_to_org(self, m_type, title=None):
        """Maps a meeting_type enum value to the official Organization name."""
        if m_type == "Standing Committee":
            # Each standing committee is its own organization, named in the meeting title.
            return utils.committee_name(title) or "Standing Committee", "Committee"

        if m_type in [
            "Inauguration",
            "Regular Council",
            "Special Council",
            "Committee of the Whole",
            "Public Hearing",
        ]:
            return "Council", "Council"

        if m_type == "Board of Variance":
            return "Board of Variance", "Board"

        # Advisory committees often have the type in their name
        if m_type == "Advisory Committee":
            # This is a fallback; usually the title has the specific committee name
            return "Advisory Committee", "Advisory Committee"

        return m_type, "Committee"

    def normalize_address_list(self, address_input):
        if not address_input:
            return []
        if isinstance(address_input, list):
            return [a.strip() for a in address_input if a and str(a).strip()]

        if not isinstance(address_input, str):
            return []

        # Logic from fix_related_addresses.py
        address_str = address_input.strip()

        # 1. Handle "105, 106, 107 and 108 Glentana Road" pattern
        multi_num_pattern = r"^((?:\d+,\s*)*)(\d+)\s+(?:and|&)\s+(\d+)\s+(.*)$"
        match = re.match(multi_num_pattern, address_str, re.IGNORECASE)
        if match:
            prev_nums = match.group(1).replace(",", " ").split()
            num1 = match.group(2)
            num2 = match.group(3)
            street = match.group(4)
            all_nums = prev_nums + [num1, num2]
            return [f"{n.strip()} {street.strip()}" for n in all_nums]

        # 2. Handle simple "Street A and Street B" or "Street A, Street B"
        parts = re.split(r",\s*|\s+and\s+", address_str, flags=re.IGNORECASE)
        if len(parts) > 1:
            return [p.strip() for p in parts if p.strip()]

        return [address_str]

    # ── Geocoding ──

    NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
    NOMINATIM_USER_AGENT = "civic-meeting-intelligence/1.0 (municipal records site)"
    # Patterns that indicate a non-geocodable address value
    NON_ADDRESS_PREFIXES = ("various", "n/a", "tbd", "none", "multiple", "all", "general")

    def _geocode_context(self) -> dict:
        """Town name, province and a viewbox around the municipality's map centre."""
        if getattr(self, "_geo_ctx", None) is not None:
            return self._geo_ctx
        ctx = {"name": "Langford", "province": "BC", "viewbox": "-123.62,48.39,-123.45,48.50"}
        try:
            row = (
                self.supabase.table("municipalities")
                .select("short_name, province, map_center_lat, map_center_lng")
                .eq("id", self.municipality_id)
                .maybe_single()
                .execute()
            ).data or {}
            ctx["name"] = row.get("short_name") or ctx["name"]
            ctx["province"] = row.get("province") or ctx["province"]
            lat, lng = row.get("map_center_lat"), row.get("map_center_lng")
            if lat is not None and lng is not None:
                ctx["viewbox"] = f"{lng - 0.12},{lat - 0.07},{lng + 0.12},{lat + 0.07}"
        except Exception as e:
            print(f"  [!] Could not load municipality geocode context: {e}")
        self._geo_ctx = ctx
        return ctx

    @staticmethod
    def _strip_unit(address: str) -> str:
        """'#101 - 693 Hoffman Ave' / '107-2317 Millstream Rd' -> street address."""
        addr = re.sub(r"^\s*(?:#|unit\s+|suite\s+)?[\w]+\s*[-–]\s*(?=\d)", "", address, flags=re.I)
        addr = re.sub(r"^\s*#\s*\w+\s+(?=\d)", "", addr)
        return addr.strip()

    def geocode_address(self, address):
        """Geocode one address with Nominatim, restricted to the municipality's area.
        Returns (lat, lng) or None. Callers rate-limit (1 req/s)."""
        if not address or not address.strip():
            return None
        addr = address.strip()
        if addr.lower().startswith(self.NON_ADDRESS_PREFIXES):
            return None
        ctx = self._geocode_context()
        street = self._strip_unit(addr)
        if ctx["name"].lower() not in street.lower():
            street = f"{street}, {ctx['name']}, {ctx['province']}, Canada"
        try:
            resp = http_requests.get(
                self.NOMINATIM_URL,
                params={
                    "q": street,
                    "format": "json",
                    "limit": 1,
                    "viewbox": ctx["viewbox"],
                    "bounded": 1,  # only accept results inside the municipality's area
                    "countrycodes": "ca",
                },
                headers={"User-Agent": self.NOMINATIM_USER_AGENT},
                timeout=10,
            )
            resp.raise_for_status()
            results = resp.json()
            if results:
                return (float(results[0]["lat"]), float(results[0]["lon"]))
        except Exception as e:
            print(f"    [!] Geocoding error for '{address}': {e}")
        return None

    def _geocode_agenda_items(self, meeting_id, items_data, dry_run=False):
        """Geocode agenda items that have related_address but no geo_location.
        Writes agenda_items.geo_location as {lat, lng, address} (read by the web map)."""
        geocoded_count = 0
        geocode_cache = {}

        for item in items_data:
            addresses = item.get("related_address", [])
            if not addresses or not isinstance(addresses, list):
                continue

            item_id = item.get("_db_id")
            if not item_id:
                continue

            # Only geocode items that don't already have geo data
            try:
                existing = (
                    self.supabase.table("agenda_items")
                    .select("geo_location")
                    .eq("id", item_id)
                    .single()
                    .execute()
                )
                if existing.data and existing.data.get("geo_location"):
                    continue
            except Exception:
                continue

            # Try to geocode the first valid address
            for addr in addresses:
                if not addr or not addr.strip():
                    continue
                addr = addr.strip()
                if addr.lower().startswith(self.NON_ADDRESS_PREFIXES):
                    continue

                if addr in geocode_cache:
                    result = geocode_cache[addr]
                else:
                    result = self.geocode_address(addr)
                    geocode_cache[addr] = result
                    # Nominatim rate limit: 1 request per second
                    time.sleep(1.1)

                if result and not dry_run:
                    lat, lng = result
                    try:
                        self.supabase.table("agenda_items").update(
                            {"geo_location": {"lat": lat, "lng": lng, "address": addr}}
                        ).eq("id", item_id).execute()
                        geocoded_count += 1
                        print(f"    [Geo] {addr} -> ({lat:.6f}, {lng:.6f})")
                    except Exception as e:
                        print(f"    [!] Failed to update geo for item {item_id}: {e}")
                    break  # Only need one successful geocode per item

        if geocoded_count > 0:
            print(f"  [+] Geocoded {geocoded_count} agenda items")

        return geocoded_count

    def _normalize_archive_path(self, folder_path):
        """Normalize archive path to always be relative (viewroyal_archive/... or archive/slug/...)."""
        # Convert to absolute first for consistent handling
        abs_path = os.path.abspath(folder_path)

        # Try municipality archive path first (archive/slug/...)
        archive_marker = "/archive/"
        if archive_marker in abs_path:
            idx = abs_path.find(archive_marker) + 1  # Skip leading /
            return abs_path[idx:]  # Returns "archive/slug/..."

        # Legacy: viewroyal_archive/...
        marker = "viewroyal_archive"
        if marker in abs_path:
            idx = abs_path.find(marker)
            return abs_path[idx:]  # Returns "viewroyal_archive/..."

        # Fallback: return as-is if marker not found
        return folder_path

    def _classify_document(self, filename, subfolder=None):
        """Classify a document by filename keywords (and the folder it was filed in)."""
        lower = filename.lower()
        # Langford files signed minutes as e.g. "20200203-SIGNED.pdf" inside Minutes/.
        if subfolder == "Minutes" and re.search(r"minute|mins|sign", lower):
            return "Minutes"
        if "addend" in lower:
            return "Addendum"
        if "late" in lower and "item" in lower:
            return "Late Items"
        if "supplementa" in lower or "supplement" in lower:
            return "Supplementary"
        if "report" in lower:
            return "Report"
        if "agenda" in lower:
            return "Agenda"
        if "minute" in lower:
            return "Minutes"
        return "Other"

    def _ingest_documents(self, meeting_id, folder_path, dry_run=False):
        """Ingest official PDF/HTML agenda and minutes with source provenance."""
        import fitz  # PyMuPDF

        doc_count = 0

        for subfolder_name in ["Agenda", "Minutes"]:
            subfolder = os.path.join(folder_path, subfolder_name)
            if not os.path.isdir(subfolder):
                continue

            pdf_files = sorted(glob.glob(os.path.join(glob.escape(subfolder), "*.pdf")))
            if not pdf_files:
                pdf_files = sorted(glob.glob(os.path.join(glob.escape(subfolder), "*.html")))
            for pdf_path in pdf_files:
                filename = os.path.basename(pdf_path)
                rel_path = os.path.relpath(pdf_path, folder_path)

                # Extract text (with OCR fallback)
                is_html = pdf_path.lower().endswith(".html")
                if is_html:
                    with open(pdf_path, encoding="utf-8") as handle:
                        soup = BeautifulSoup(handle.read(), "html.parser")
                    if not soup.select_one("#AgendaHeaderTitle") or not soup.select_one('[id^="AgendaItem"]'):
                        print(f"  [!] Ignoring unvalidated official HTML: {pdf_path}")
                        continue
                    full_text = soup.get_text("\n", strip=True)
                else:
                    full_text = parser.get_pdf_text(pdf_path)
                    if len(full_text.strip()) < 100:
                        full_text = parser.get_pdf_text_ocr(pdf_path)

                # Page count via PyMuPDF
                try:
                    if is_html:
                        page_count = None
                    else:
                        doc = fitz.open(pdf_path)
                        page_count = len(doc)
                        doc.close()
                except Exception:
                    page_count = None

                # SHA256 hash
                sha256 = hashlib.sha256()
                with open(pdf_path, "rb") as f:
                    for chunk in iter(lambda: f.read(8192), b""):
                        sha256.update(chunk)
                file_hash = sha256.hexdigest()

                # Source URL from companion .url file
                source_url = None
                url_file = f"{pdf_path}.url"
                if os.path.exists(url_file):
                    try:
                        with open(url_file, "r", encoding="utf-8") as f:
                            source_url = f.read().strip() or None
                    except Exception:
                        pass

                # Classify
                category = self._classify_document(filename, subfolder_name)

                # Title from filename (strip extension)
                title = os.path.splitext(filename)[0]
                from pipeline.ingestion.letter_privacy import scrub_emails

                doc_data = {
                    "meeting_id": meeting_id,
                    "title": title,
                    "category": category,
                    "source_url": source_url,
                    "file_path": rel_path,
                    "file_hash": file_hash,
                    "full_text": scrub_emails(full_text.strip()) if full_text else None,
                    "page_count": page_count,
                    "municipality_id": self.municipality_id,
                }

                if dry_run:
                    print(f"  [Dry Run] Document: {rel_path} ({category}, {page_count} pages)")
                else:
                    try:
                        self.supabase.table("documents").upsert(
                            doc_data, on_conflict="meeting_id,file_path"
                        ).execute()
                        doc_count += 1
                    except Exception as e:
                        print(f"  [!] Error ingesting document {rel_path}: {e}")

        if doc_count > 0:
            print(f"  [+] Ingested {doc_count} documents")

        return doc_count

    def _ingest_document_sections(self, meeting_id, folder_path):
        """Extract documents from PDFs using the AI + PyMuPDF pipeline.

        For each document with a file_path (agenda PDFs), runs:
        1. AI boundary detection (document boundaries, types, agenda links)
        2. AI content extraction (markdown per document)
        3. PyMuPDF image extraction + R2 upload
        4. Section splitting and insertion

        Falls back to PyMuPDF font-analysis chunker if AI extraction fails.
        Skips documents that already have extracted_documents (idempotency).
        """
        from pipeline.ingestion.document_extractor import extract_and_store_documents

        # Fetch documents for this meeting
        try:
            docs_result = (
                self.supabase.table("documents")
                .select("id, title, file_path")
                .eq("meeting_id", meeting_id)
                .execute()
            )
        except Exception as e:
            print(f"  [!] Error fetching documents for extraction: {e}")
            return

        if not docs_result.data:
            return

        for doc in docs_result.data:
            if not doc.get("file_path"):
                continue
            if not doc["file_path"].lower().endswith(".pdf"):
                # HTML is an official decision source, not a PDF attachment packet.
                continue

            doc_id = doc["id"]
            doc_title = doc.get("title") or "Untitled"

            # Check idempotency: skip if extracted_documents already exist
            try:
                existing = (
                    self.supabase.table("extracted_documents")
                    .select("id", count="exact")
                    .eq("document_id", doc_id)
                    .execute()
                )
                if existing.count and existing.count > 0:
                    continue
            except Exception:
                pass  # Table might not exist yet; proceed anyway

            # Resolve full PDF path
            pdf_path = os.path.join(folder_path, doc["file_path"])
            if not os.path.exists(pdf_path):
                continue

            # Extract documents using the AI pipeline (with fallback)
            try:
                stats = extract_and_store_documents(
                    pdf_path, doc_id, meeting_id, self.supabase, self.municipality_id
                )
                print(
                    f"  [+] Extracted {doc_title}: {stats['boundaries_found']} boundaries, "
                    f"{stats['sections_created']} sections, {stats['images_extracted']} images"
                )
            except Exception as e:
                print(f"  [!] Error extracting {doc_title}: {e}")

    def _speaker_alias_candidate_inventory(self, meeting_id, proposals):
        """Collect every spelling/candidate; no alias grants a named identity."""
        existing = self.supabase.table("meeting_speaker_aliases").select(
            "speaker_label,person_id,people(name)"
        ).eq("meeting_id", meeting_id).execute().data
        people = []
        while True:
            page = self.supabase.table("people").select("id,name").order("id").range(
                len(people), len(people)+999
            ).execute().data
            people.extend(page)
            if len(page) < 1000:
                break
        names = {}
        for person in people:
            if person.get("name"):
                names.setdefault(" ".join(person["name"].casefold().split()), set()).add(person["id"])
        groups, unrecognized = {}, []
        for source, aliases in (("refinement", proposals), ("database", existing)):
            for alias in aliases:
                raw_label = alias.get("label") or alias.get("speaker_label") or ""
                key = label_key(raw_label.strip())
                if not key:
                    unrecognized.append(raw_label)
                    continue
                name = alias.get("name") or (alias.get("people") or {}).get("name")
                ids = {alias["person_id"]} if alias.get("person_id") else names.get(" ".join((name or "").casefold().split()), set())
                group = groups.setdefault(key, {"person_ids": set(), "candidates": []})
                group["person_ids"].update(ids)
                group["candidates"].append({"source": source, "raw_label": raw_label,
                                            "person_ids": sorted(ids), "name": name})
        for group in groups.values():
            group["person_ids"] = sorted(group["person_ids"])
            group["status"] = "normalized_alias_conflict" if len(group["person_ids"]) > 1 else "independent_identity_evidence_required"
        return {"groups": groups, "unrecognized_labels": unrecognized}

    def persist_participant_role_observations(self, context, dry_run=False):
        """Meeting-local official roles; never infer employment term intervals."""
        from pipeline.ingestion.participant_roles import participant_role_observations, METHOD
        if context.get("status") != "available":
            return {"status": "source_held"}
        meeting = context["meeting"]
        parsed = participant_role_observations(context["source"], meeting=meeting, people=context["people"])
        if parsed["status"] != "parsed" or dry_run:
            return {"status": parsed["status"], "dry_run": dry_run}
        current_rows = self.supabase.table("meetings").select(
            "meta,updated_at,meeting_date,archive_path,minutes_url"
        ).eq(
            "id", meeting["id"]
        ).eq("municipality_id", self.municipality_id).execute().data
        if len(current_rows) != 1:
            raise RuntimeError("Participant role metadata identity unavailable")
        current = current_rows[0]
        meta = current.get("meta") or {}
        if not isinstance(meta, dict):
            return {"status": "existing_role_metadata_format_held"}
        old_roles = meta.get("participant_roles") or {}
        if not isinstance(old_roles, dict):
            return {"status": "existing_role_metadata_format_held"}
        preserved = {key: value for key, value in old_roles.items()
                     if not isinstance(value, dict) or value.get("method") != METHOD}
        roles = {**parsed["observations"], **preserved}
        if roles == old_roles:
            return {"status": "unchanged", "observations": len(roles)}
        if any(current.get(key) != meeting.get(key) for key in ("meeting_date", "archive_path", "minutes_url")):
            raise RuntimeError("Participant role catalog identity changed during source validation; retry")
        updated = {**meta, "participant_roles": roles}
        query = self.supabase.table("meetings").update({"meta": updated}).eq(
            "id", meeting["id"]
        ).eq("municipality_id", self.municipality_id)
        query = query.eq("updated_at", current["updated_at"])
        query = (query.is_("meta", "null") if current.get("meta") is None
                 else query.eq("meta", json.dumps(current["meta"], ensure_ascii=False)))
        if not query.execute().data:
            raise RuntimeError("Participant role metadata compare-and-swap conflict; retry")
        return {"status": "updated", "observations": len(roles)}

    def reconcile_transcript_identities(self, folder_path, meeting_id, dry_run=False):
        """Reconcile source-proven links in place without refinement or row replacement."""
        from pathlib import Path
        from urllib.parse import urlparse, parse_qs
        from pipeline.ingestion.official_ballots import load_official_minutes
        from pipeline.ingestion.transcript_identity_producer import DirectIntroductionProducer
        from pipeline.ingestion import transcript_links as verifier

        def held(reason):
            return {"status": "held", "reason": reason, "meeting_id": meeting_id,
                    "pending": 0, "applied": 0, "identity_only": True}

        meeting_rows = self.supabase.table("meetings").select(
            "id,archive_path,meeting_date,title,type,video_url,minutes_url,municipality_id"
        ).eq("id", meeting_id).eq("municipality_id", self.municipality_id).execute().data
        if len(meeting_rows) != 1:
            return held("canonical_meeting_missing_or_ambiguous")
        meeting = meeting_rows[0]
        folder = Path(folder_path).resolve()
        if self._normalize_archive_path(folder) != meeting.get("archive_path"):
            return held("canonical_archive_path_mismatch")
        if (folder / "shared_media.json").exists():
            return held("shared_recording_meeting_boundaries_not_validated")
        transcript_path = self.find_transcript(str(folder))
        if not transcript_path:
            return held("original_transcript_missing")
        transcript = Path(transcript_path)
        audio = [transcript.with_suffix(suffix) for suffix in (".m4a", ".mp3", ".wav", ".mp4")
                 if transcript.with_suffix(suffix).is_file()]
        if len(audio) != 1:
            return held("original_recording_missing_or_ambiguous")
        people, rows = [], []
        for table, columns, target in (("people", "id,name", people), ("transcript_segments", "*", rows)):
            for offset in range(0, 1000000, 1000):
                query = self.supabase.table(table).select(columns)
                if table == "transcript_segments":
                    query = query.eq("meeting_id", meeting_id)
                page = query.order("id").range(offset, offset+999).execute().data
                target.extend(page)
                if len(page) < 1000:
                    break
        if not rows:
            return held("existing_transcript_rows_required")
        source = load_official_minutes(meeting, root=BASE_DIR, people=people,
                                       cache_dir=folder / ".speaker_identity_source")
        if source.get("error") or source.get("local_date") is None:
            return held("official_source_" + source.get("error", "date_unknown"))
        source_url = urlparse(source.get("source_url") or "")
        source_host = source_url.hostname
        if source_url.scheme != "https" or source_host not in {"pub-langford.escribemeetings.com", "langford.ca", "www.langford.ca",
                               "viewroyalbc.civicweb.net", "www.viewroyal.ca", "viewroyal.ca"}:
            return held("official_source_url_not_validated")
        expected_municipality = (r"\bLangford\b" if "/langford/" in meeting["archive_path"]
                                 else r"\bView\s+Royal\b" if "view" in meeting["archive_path"].casefold() else None)
        if not expected_municipality or not re.search(expected_municipality, source.get("source_header") or "", re.I):
            return held("official_source_municipality_not_bound")
        from datetime import date
        if abs((date.fromisoformat(str(source["local_date"])) - date.fromisoformat(str(meeting["meeting_date"])[:10])).days) > 1:
            return held("official_source_catalog_date_mismatch")
        parsed = urlparse(meeting.get("video_url") or "")
        if parsed.scheme != "https":
            return held("canonical_recording_https_required")
        if parsed.hostname in ("vimeo.com", "www.vimeo.com", "player.vimeo.com"):
            ids = re.findall(r"(?:^|/)([0-9]+)(?:/|$)", parsed.path)
            recording_id = "vimeo:"+ids[0] if len(ids) == 1 else None
        elif parsed.hostname == "pub-langford.escribemeetings.com":
            ids = parse_qs(parsed.query).get("Id", [])
            recording_id = "escribe:langford:"+ids[0].lower() if len(ids) == 1 else None
        else:
            recording_id = None
        if not recording_id:
            return held("canonical_recording_identity_unavailable")
        if dry_run:
            return held("dry_run_no_paid_evidence_production")
        production = DirectIntroductionProducer().produce(
            folder=folder, meeting=meeting, people=people, transcript=transcript, recording=audio[0],
            recording_id=recording_id,
            official_source={"path": Path(BASE_DIR) / source["source_file"],
                             "format": "pdf" if source["source_format"] == "original_pdf_layout" else "html",
                             "identity": {key: source.get(key) for key in
                                          ("source_sha256", "source_url", "local_date", "source_header")}})
        if production.get("status") == "held":
            return held(production.get("reason", "evidence_production_held"))
        raw_original = json.loads(transcript.read_text())
        original_segments = raw_original.get("segments", []) if isinstance(raw_original, dict) else raw_original
        originals = {}
        for segment in original_segments:
            key = (segment.get("start"), segment.get("end"), segment.get("text"))
            originals.setdefault(key, []).append(segment)
        applied, retained, holds, considered = 0, 0, 0, 0
        for request in production.get("requests", []):
            admission = verifier.admit_identity(request, people)
            if admission.get("status") != "identity_admitted":
                holds += 1
                continue
            raw = json.loads(Path(request["diarization"]["path"]).read_text())["result"]["raw_segments"]
            turns = [{**turn, "start": turn["start"]+request["clip_start"],
                      "end": turn["end"]+request["clip_start"]} for turn in raw]
            for row in rows:
                if not request["clip_start"] <= row["start_time"] < row["end_time"] <= request["clip_end"]:
                    continue
                matched = originals.get((row["start_time"], row["end_time"], row["text_content"]), [])
                if len(matched) != 1:
                    holds += 1
                    continue
                candidate = verifier.verify_transcript_link(row, matched[0], admission, turns,
                                                            source_run=request["source_run"])
                considered += 1
                if candidate["status"] != "link_candidate":
                    holds += 1
                    continue
                response = self.supabase.rpc("apply_transcript_identity_evidence", {
                    "p_segment_id": candidate["segment_id"], "p_expected": candidate["expected_row"],
                    "p_person_id": candidate["person_id"], "p_speaker_name": candidate["speaker_name"],
                    "p_validator_version": candidate["validator_version"],
                    "p_validator_sha256": candidate["validator_sha256"],
                    "p_input_sha256": candidate["input_sha256"], "p_source_run": request["source_run"],
                    "p_evidence": {"admission": admission, "link": candidate},
                    "p_input_canonical_json": candidate["input_canonical_json"],
                }).execute()
                if not response.data:
                    raise RuntimeError("Identity evidence RPC did not return an acknowledged receipt")
                receipt = response.data
                if receipt.get("status") == "applied":
                    applied += 1
                elif receipt.get("status") == "already_applied":
                    retained += 1
                else:
                    raise RuntimeError("Unexpected identity evidence acknowledgement")
        if production.get("pending"):
            continuation_args = {"meeting_id": meeting_id, "identity_only": True,
                                 "skip_diarization": True, "identity_input_key": production["input_key"]}
            queued = self.supabase.table("pipeline_jobs").select("id").eq(
                "municipality_id", self.municipality_id
            ).eq("job_type", "ingest_meeting").eq("status", "queued").contains(
                "args", continuation_args
            ).limit(1).execute().data
            if not queued:
                self.supabase.table("pipeline_jobs").insert({
                    "municipality_id": self.municipality_id, "job_type": "ingest_meeting",
                    "status": "queued", "args": continuation_args,
                }).execute()
        return {"status": production["status"], "meeting_id": meeting_id, "identity_only": True,
                "pending": production.get("pending", 0), "input_key": production.get("input_key"),
                "applied": applied, "retained": retained, "held": holds+production.get("held", 0), "considered": considered,
                "clips_processed": production.get("clips_processed", 0)}

    def process_meeting(
        self,
        folder_path,
        dry_run=False,
        precomputed_refinement=None,
        force_update=False,
        force_refine=False,
        replace_transcript=False,
        identity_only=False,
    ):
        if identity_only:
            matches = self.supabase.table("meetings").select("id").eq(
                "archive_path", self._normalize_archive_path(folder_path)
            ).eq("municipality_id", self.municipality_id).execute().data
            if len(matches) != 1:
                raise RuntimeError("Identity-only ingestion requires one existing canonical meeting")
            return self.reconcile_transcript_identities(folder_path, matches[0]["id"], dry_run=dry_run)
        canonical_cached_refresh = False
        cached_ballot_context = None
        validation_inputs = None
        cached_catalog = None
        catalog_columns = "id,meeting_date,title,type,organization_id,archive_path,minutes_url,organization:organizations(classification)"

        def catalog_identity(row):
            organization = row.get("organization") or {}
            if not row.get("meeting_date") or not row.get("archive_path") or not organization.get("classification"):
                raise RuntimeError("Stored meeting identity unavailable; refusing folder-derived source refresh")
            return {**{key: row.get(key) for key in ("id", "meeting_date", "title", "type", "organization_id", "archive_path", "minutes_url")},
                    "classification": organization["classification"]}

        def load_source_context(meeting):
            nonlocal validation_inputs
            inventory = source_candidate_inventory(BASE_DIR, normalized_path)
            context = prepare_ballot_context(self.supabase, municipality_id=self.municipality_id,
                                             meeting=meeting, root=BASE_DIR)
            if inventory != source_candidate_inventory(BASE_DIR, normalized_path):
                raise RuntimeError("Official source candidates changed during validation; retry")
            validation_inputs = source_validation_inputs(context, inventory)
            self.persist_participant_role_observations(context, dry_run=dry_run)
            return context
        # Normalize path to prevent duplicates from absolute vs relative paths
        normalized_path = self._normalize_archive_path(folder_path)
        print(
            f"Processing: {normalized_path} (Dry Run: {dry_run})"
        )

        # Evidence-ledger FKs deliberately protect stable segment IDs. Refuse
        # destructive replacement before ANY meeting/attendance/content writes;
        # identity refresh changes links in place and never marks rows human-verified.
        if replace_transcript and not dry_run:
            prior_meetings = self.supabase.table("meetings").select("id").eq(
                "archive_path", normalized_path
            ).eq("municipality_id", self.municipality_id).execute().data
            if len(prior_meetings) > 1:
                raise RuntimeError("Ambiguous meeting identity; refusing transcript replacement")
            if prior_meetings:
                prior_id = prior_meetings[0]["id"]
                protected = self.supabase.table("transcript_identity_evidence").select(
                    "segment_id"
                ).eq("meeting_id", prior_id).limit(1).execute().data
                if protected:
                    raise RuntimeError(
                        "Replacement would delete source-validated transcript IDs; "
                        "use non-destructive speaker identity reconciliation"
                    )
                verified = self.supabase.table("transcript_segments").select("id").eq(
                    "meeting_id", prior_id
                ).eq("is_verified", True).limit(1).execute().data
                if verified:
                    raise RuntimeError("Verified transcript rows must be preserved; refusing replacement")

        # 0. Check if already exists (use normalized path for DB lookup)
        if not dry_run and not force_update and not precomputed_refinement and not replace_transcript:
            res = (
                self.supabase.table("meetings")
                .select(catalog_columns + ",has_agenda,has_minutes,meta,status")
                .eq("archive_path", normalized_path)
                .execute()
            )
            if res.data:
                meeting_row = res.data[0]
                # Self-healing: if meeting claims has_agenda but has 0 agenda items,
                # it was half-ingested (e.g. the AI API key was missing). Re-process it.
                new_minutes = not meeting_row.get("has_minutes") and any(
                    glob.glob(os.path.join(glob.escape(os.path.join(folder_path, "Minutes")), pattern))
                    for pattern in ("*.pdf", "*.html")
                )
                if new_minutes:
                    print(f"  [i] Meeting {meeting_row['id']} has newly recovered minutes. Refreshing official decisions.")
                    force_update = True
                    force_refine = True
                elif "archive/langford/" in normalized_path.replace("\\", "/") and meeting_row.get("status") in ("Occurred", "Completed"):
                    cached_catalog = meeting_row
                    cached_ballot_context = load_source_context(catalog_identity(meeting_row))
                    if source_receipt_current(BASE_DIR, meeting_row.get("meta"), validation_inputs):
                        items = self.supabase.table("agenda_items").select("id", count="exact").eq("meeting_id", meeting_row["id"]).execute()
                        if meeting_row.get("has_agenda") and items.count:
                            print("  [->] Official source and validation inputs unchanged. Skipping.")
                            self.reconcile_transcript_identities(folder_path, meeting_row["id"])
                            return None
                    print("  [i] Changed, legacy or interrupted source validation; refreshing facts from cached refinement.")
                    force_update = True
                    canonical_cached_refresh = True
                elif meeting_row.get("has_agenda"):
                    items_res = (
                        self.supabase.table("agenda_items")
                        .select("id", count="exact")
                        .eq("meeting_id", meeting_row["id"])
                        .execute()
                    )
                    if items_res.count == 0:
                        print(f"  [!] Meeting {meeting_row['id']} has has_agenda=true but 0 agenda items. Re-processing (self-healing).")
                        force_update = True
                        force_refine = True
                        # Fall through to re-process instead of returning
                    else:
                        print("  [->] Meeting already ingested. Skipping.")
                        self.reconcile_transcript_identities(folder_path, meeting_row["id"])
                        return None
                elif any(
                    glob.glob(os.path.join(glob.escape(os.path.join(folder_path, "Agenda")), pattern))
                    for pattern in ("*.pdf", "*.html")
                ):
                    print(f"  [i] Meeting {meeting_row['id']} has newly recovered agenda documents. Re-processing.")
                    force_update = True
                    force_refine = True
                else:
                    print("  [->] Meeting already ingested. Skipping.")
                    self.reconcile_transcript_identities(folder_path, meeting_row["id"])
                    return None

        meta = ({"meeting_date": cached_catalog["meeting_date"], "title": cached_catalog["title"],
                 "meeting_type": cached_catalog.get("type") or ""} if canonical_cached_refresh
                else parser.extract_meeting_metadata(folder_path))
        if not meta:
            print("  Skipping: Could not parse date/type.")
            return None

        # 1. Organization & Meeting Upsert
        # Initial guess from filename metadata
        m_type_guess = utils.infer_meeting_type(meta["meeting_type"] or meta["title"])
        org_name, classification = self.map_type_to_org(m_type_guess or "Council", meta["title"])

        if canonical_cached_refresh:
            # Corrected live catalog facts are authoritative over legacy folder names.
            meta = {**meta, "meeting_date": cached_catalog["meeting_date"], "title": cached_catalog["title"]}
            m_type_guess = cached_catalog.get("type")
            classification = cached_catalog["organization"]["classification"]
            org_id = cached_catalog["organization_id"]
        else:
            org_id = self.get_or_create_organization(org_name, classification, dry_run)

        meeting_data = {
            "title": meta["title"],
            "meeting_date": meta["meeting_date"],
            "organization_id": org_id,
            "archive_path": normalized_path,  # Always store normalized path
            "type": m_type_guess,
            "municipality_id": self.municipality_id,
        }
        if m_type_guess == "Standing Committee" and utils.committee_name(meta["title"]):
            # The default slug is "<date>-<type>"; name the committee instead.
            meeting_data["slug"] = f"{meta['meeting_date']}-{self._slugify(utils.committee_name(meta['title']))}"

        # Look for agenda_url from companion .url file
        agenda_folder = os.path.join(folder_path, "Agenda")
        pdf_files = glob.glob(os.path.join(glob.escape(agenda_folder), "*.pdf"))
        if not pdf_files:
            pdf_files = glob.glob(os.path.join(glob.escape(agenda_folder), "*.html"))
        if pdf_files:
            # Assuming there's only one PDF agenda per folder
            agenda_pdf_path = pdf_files[0]
            agenda_url_file = f"{agenda_pdf_path}.url"
            if os.path.exists(agenda_url_file):
                try:
                    with open(agenda_url_file, "r", encoding="utf-8") as f:
                        agenda_civicweb_url = f.read().strip()
                        if agenda_civicweb_url:
                            meeting_data["agenda_url"] = agenda_civicweb_url
                            print(f"  [+] Found agenda_url: {agenda_civicweb_url}")
                except Exception as e:
                    print(f"  [!] Error reading agenda .url file: {e}")
            else:
                print(f"  [i] No .url file found for agenda: {agenda_pdf_path}")
        # Resolve verified calendar identities before legacy placeholders.
        calendar_organization_id = None
        calendar_meeting_type = None
        scheduled_meeting_id = cached_catalog["id"] if canonical_cached_refresh else None
        if not dry_run and not canonical_cached_refresh:
            from pipeline.ingestion.calendar_identity import find_scheduled_meeting
            scheduled = find_scheduled_meeting(
                self.supabase, self.municipality_id, normalized_path,
                meta["meeting_date"], m_type_guess,
            )
            if scheduled:
                scheduled_meeting_id = scheduled["id"]
                if scheduled.get("video_url"):
                    meeting_data["video_url"] = scheduled["video_url"]
                if scheduled.get("calendar_source_id"):
                    # Preserve verified schedule provenance and organization when attaching documents.
                    meeting_data["meta"] = {**(scheduled.get("meta") or {}), **(meeting_data.get("meta") or {})}
                    calendar_organization_id = scheduled["organization_id"]
                    calendar_meeting_type = scheduled.get("type") or m_type_guess
                    meeting_data["organization_id"] = calendar_organization_id
                    meeting_data["type"] = calendar_meeting_type
                    meeting_data["title"] = scheduled.get("title") or meeting_data["title"]

        if not dry_run:
            # Only search Vimeo for municipalities whose configured video source is Vimeo.
            archived_player_url = self._read_archived_player_url(folder_path)
            if archived_player_url and not meeting_data.get("video_url"):
                meeting_data["video_url"] = archived_player_url
                print(f"  [+] Found archived video_url: {archived_player_url}")
            elif not self._should_search_vimeo():
                print("  [Video] Skipping Vimeo lookup; configured video source is not Vimeo.")
            elif not meeting_data.get("video_url"):
                existing_meeting = (
                    self.supabase.table("meetings")
                    .select("video_url")
                    .eq("archive_path", normalized_path)
                    .execute()
                )
                if not existing_meeting.data or not existing_meeting.data[0].get(
                    "video_url"
                ):
                    print("  Searching Vimeo for matching video...")
                    v_client = VimeoClient()
                    v_match = v_client.search_video(meta["meeting_date"], m_type_guess or meta["title"])
                    if v_match:
                        print(f"  [+] Found Vimeo match: {v_match['url']}")
                        meeting_data["video_url"] = v_match["url"]

        if precomputed_refinement and precomputed_refinement.get("chair_person_name"):
            chair_id = self.get_or_create_person(
                precomputed_refinement["chair_person_name"], dry_run
            )
            meeting_data["chair_person_id"] = chair_id

        meeting_id = 100

        # 2. Extract Raw Texts & Refine
        agenda_text, minutes_text, transcript_text = self.get_raw_texts(
            folder_path, skip_cache=force_refine
        )

        # Generate Markdown versions for local reference
        def clean_text(t):
            return t.replace("\u0000", "").replace("\x00", "") if t else t

        # If input looks like raw text (no H1), use the block-generated markdown.
        # If it already looks like our improved markdown (starts with #), use it as-is.
        minutes_md = (
            minutes_text
            if minutes_text.strip().startswith("#")
            else parser.blocks_to_markdown(
                parser.parse_minutes_into_blocks(minutes_text)
            )
        )
        agenda_md = (
            agenda_text
            if agenda_text.strip().startswith("#")
            else parser.blocks_to_markdown(
                parser.parse_minutes_into_blocks(agenda_text)
            )
        )

        # Calculate Ingestion Flags (before saving md files, so we can gate on them)
        has_agenda = len(agenda_text.strip()) > 100
        has_minutes = len(minutes_text.strip()) > 100

        if not dry_run:
            # Save local Markdown versions (keep local copies for reference)
            # Gate on has_minutes/has_agenda (raw text > 100 chars) to avoid creating
            # files from garbage PDF extraction that then get read back as "real" cache
            try:
                saved_files = []
                if has_minutes and minutes_md and len(minutes_md.strip()) > 100:
                    with open(
                        os.path.join(folder_path, "minutes.md"), "w", encoding="utf-8"
                    ) as f:
                        f.write(minutes_md)
                    saved_files.append("minutes.md")

                if has_agenda and agenda_md and len(agenda_md.strip()) > 100:
                    with open(
                        os.path.join(folder_path, "agenda.md"), "w", encoding="utf-8"
                    ) as f:
                        f.write(agenda_md)
                    saved_files.append("agenda.md")

                if saved_files:
                    print(
                        f"  [+] Saved Markdown source files: {', '.join(saved_files)}"
                    )
            except Exception as e:
                print(f"  [!] Warning: Failed to save local source files: {e}")

        # Check for transcript files on disk (in case text load failed or was skipped)
        has_transcript_file = (
            os.path.exists(os.path.join(folder_path, "transcript.json"))
            or os.path.exists(os.path.join(folder_path, "transcript.txt"))
            or os.path.exists(os.path.join(folder_path, "transcript_clean.md"))
            or (
                os.path.exists(os.path.join(folder_path, "Audio"))
                and len(glob.glob(os.path.join(glob.escape(os.path.join(folder_path, "Audio")), "*Meeting*.json")))
                > 0
            )
        )
        has_transcript = len(transcript_text.strip()) > 100 or has_transcript_file

        # Determine Status
        from datetime import datetime

        meeting_status = "Planned"
        m_date = datetime.strptime(meta["meeting_date"], "%Y-%m-%d").date()
        if m_date < datetime.now().date():
            if has_minutes and has_transcript:
                meeting_status = "Completed"
            elif has_transcript:
                meeting_status = "Occurred"  # Transcript available (motions allowed)
            else:
                meeting_status = "Occurred"  # Meeting happened but data is partial

        meeting_data["has_agenda"] = has_agenda
        meeting_data["has_minutes"] = has_minutes
        meeting_data["has_transcript"] = has_transcript
        meeting_data["status"] = meeting_status

        # Flag for preventing hallucinated data on planned meetings
        is_planned_meeting = meeting_status == "Planned"

        # If we have precomputed refinement, inject its main summary into meeting_data
        if precomputed_refinement and precomputed_refinement.get("summary"):
            meeting_data["summary"] = normalize_meeting_summary(precomputed_refinement["summary"])

        has_public_content = (
            has_agenda
            or has_minutes
            or has_transcript
            or bool(meeting_data.get("summary"))
        )

        if not has_public_content:
            print(
                "  [i] No agenda, minutes, transcript, or summary found. "
                "Leaving this source in admin inventory instead of creating a public meeting."
            )
            return None

        persisted_meeting = self.supabase.table("meetings").select("id,status,has_minutes,has_transcript,has_agenda").eq("archive_path", normalized_path).execute().data
        persisted_meeting = persisted_meeting[0] if persisted_meeting else None
        if is_planned_meeting and persisted_meeting and persisted_meeting.get("status") in ("Occurred", "Completed"):
            raise RuntimeError("Refusing planned-source refresh of an already occurred meeting")
        if dry_run and persisted_meeting:
            meeting_id = persisted_meeting["id"]
        if canonical_cached_refresh and persisted_meeting:
            for flag in ("has_agenda", "has_minutes", "has_transcript"):
                if persisted_meeting.get(flag):
                    meeting_data[flag] = True
            rank = {"Planned": 0, "Occurred": 1, "Completed": 2}
            if rank.get(persisted_meeting.get("status"), 0) > rank.get(meeting_data["status"], 0):
                meeting_data["status"] = persisted_meeting["status"]
        # A cancellation (or postponement) is a recorded fact, not a gap in the sources: a past date
        # without minutes must never reopen it as "Occurred", or it counts toward attendance.
        target_meeting_id = scheduled_meeting_id or (persisted_meeting or {}).get("id")
        cancelled_meeting = bool(target_meeting_id) and any(
            row.get("status") == "Cancelled"
            for row in self.supabase.table("meetings").select("status").eq("id", target_meeting_id).execute().data
        )
        if cancelled_meeting:
            meeting_data["status"] = "Cancelled"

        if not dry_run:
            try:
                if scheduled_meeting_id:
                    # Update the pre-scheduled meeting instead of creating new
                    payload = meeting_data
                    if canonical_cached_refresh:
                        # Do not overwrite catalog corrections made concurrently.
                        payload = {key: value for key, value in meeting_data.items() if key not in
                            ("title", "meeting_date", "organization_id", "archive_path", "type", "municipality_id")}
                    self.supabase.table("meetings").update(payload).eq(
                        "id", scheduled_meeting_id
                    ).execute()
                    meeting_id = scheduled_meeting_id
                    print(f"  [+] Updated pre-scheduled meeting id={meeting_id}")
                else:
                    # Normal upsert by archive_path
                    res = (
                        self.supabase.table("meetings")
                        .upsert(meeting_data, on_conflict="archive_path")
                        .execute()
                    )
                    meeting_id = res.data[0]["id"]
                    print(f"  [+] Upserted public meeting id={meeting_id}")
            except Exception as e:
                raise RuntimeError(f"Error persisting meeting {normalized_path}: {e}") from e
        else:
            print(f"  [Dry Run] Meeting Data: {meeting_data}")

        # 2b. Ingest PDF documents into documents table after the meeting is public-ready.
        self._ingest_documents(meeting_id, folder_path, dry_run)

        # 2c. Chunk documents into sections (after documents are ingested)
        if not dry_run:
            self._ingest_document_sections(meeting_id, folder_path)

        # Initialize attendance modes
        self.local_attendance_modes = {}
        attendees_context = ""
        attendance_path = os.path.join(folder_path, "attendance.json")
        if os.path.exists(attendance_path):
            try:
                with open(attendance_path, "r", encoding="utf-8") as f:
                    att_data = json.load(f)

                lines = []
                for category in ["present", "regrets", "staff"]:
                    if category in att_data:
                        for p in att_data[category]:
                            name = p.get("name")
                            if name:
                                roles = p.get("roles", [])
                                role_str = f" ({', '.join(roles)})" if roles else ""
                                lines.append(
                                    f"{category.capitalize()}: {name}{role_str}"
                                )
                                self.local_attendance_modes[name] = p.get(
                                    "mode", "In Person"
                                )

                attendees_context = "\n".join(lines)
            except Exception as e:
                print(f"  [!] Error loading attendance.json: {e}")

        if not dry_run:
            print(
                f"  [+] Meeting flags set in DB (Status: {meeting_status}, Transcript: {has_transcript})"
            )

        refined = precomputed_refinement

        if not refined:
            refinement_path = os.path.join(folder_path, "refinement.json")
            if os.path.exists(refinement_path):
                if not force_refine:
                    print(f"  [+] Found local refinement.json at {refinement_path}")
                    try:
                        with open(refinement_path, "r", encoding="utf-8") as f:
                            refined = json.load(f)
                    except Exception as e:
                        print(f"  [!] Error reading local refinement.json: {e}")
                else:
                    print(f"  [i] Ignoring local refinement.json (force_refine=True)")

        if canonical_cached_refresh and not refined:
            # Native source identities need no paid transcript/model rerun.
            # Existing agenda, statements, aliases and summaries are retained.
            refined = {"items": [], "attendees": [], "speaker_aliases": []}

        # Parse Scratchpad for Speaker Aliases if explicit aliases are missing
        if (
            refined
            and refined.get("scratchpad_speaker_map")
            and not refined.get("speaker_aliases")
        ):
            print("  [i] Parsing speaker aliases from scratchpad...")
            scratchpad = refined["scratchpad_speaker_map"]

            # More flexible regex to find mappings like "Speaker_01: John Doe", "Speaker_01 is John Doe", etc.
            # Looks for Speaker_XX followed by some separator and then a capitalized name
            matches = re.findall(
                r"(Speaker_\d+|Chair)\s*[:\-=is\s>]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)",
                scratchpad,
            )

            aliases = []
            seen_labels = set()
            for label, name in matches:
                if label in seen_labels:
                    continue
                # Clean up name (remove roles like "(Mayor)")
                clean_name = re.sub(r"\s*\(.*?\)", "", name).strip()
                # Remove leading titles that might have been caught
                clean_name = re.sub(
                    r"^(Mayor|Councillor|Cclr|Ccl|Mr|Ms|Mrs|Dr)\s+",
                    "",
                    clean_name,
                    flags=re.IGNORECASE,
                ).strip()

                if clean_name:
                    aliases.append({"label": label, "name": clean_name})
                    seen_labels.add(label)

            if aliases:
                print(
                    f"  [+] Extracted {len(aliases)} aliases from scratchpad: {aliases}"
                )
                refined["speaker_aliases"] = aliases

        # Parse Scratchpad for Timestamps (MM:SS or HH:MM:SS -> Seconds)
        if refined and refined.get("scratchpad_timeline") and refined.get("items"):
            print("  [i] Parsing timeline timestamps from scratchpad...")
            timeline_text = refined["scratchpad_timeline"]

            # Look for patterns like "7.a (1:23:45-1:25:00)" or "7.a Variance (17:59-29:32)"
            # This regex looks for an item-like number, then some text, then (text? TIME-TIME)
            time_matches = re.findall(
                r"(\d+(?:\.[a-z\d]+)*)\.?\s+.*?\(.*?([\d:]+)-([\d:]+)", timeline_text
            )

            timeline_map = {}
            for item_num, start_str, end_str in time_matches:
                start_sec = to_seconds(start_str)
                end_sec = to_seconds(end_str)
                if start_sec is not None:
                    timeline_map[item_num] = (start_sec, end_sec)

            if timeline_map:
                print(
                    f"  [+] Extracted {len(timeline_map)} timestamp ranges from scratchpad."
                )
                for item in refined["items"]:
                    # Try to match "7.a)" or "7.a" to "7.a"
                    clean_order = item.get("item_order", "").strip(".)")
                    if clean_order in timeline_map:
                        s, e = timeline_map[clean_order]
                        # Only override if the current value looks like a "hallucinated float"
                        # (e.g. 1.058 for 1:05:46) or if it's missing.
                        # Rule: If the difference is huge, trust the scratchpad.
                        item["discussion_start_time"] = s
                        if e:
                            item["discussion_end_time"] = e

        if not refined and (has_minutes or has_agenda):
            print("  Running AI Refinement...")
            canonical_str = ", ".join(self._get_canonical_names())

            # Extract fingerprint aliases from transcript (if diarizer matched known speakers)
            fingerprint_aliases = []
            source_folder_for_fp = folder_path
            shared_path_fp = os.path.join(folder_path, "shared_media.json")
            if os.path.exists(shared_path_fp):
                try:
                    with open(shared_path_fp, "r", encoding="utf-8") as f:
                        shared_data_fp = json.load(f)
                        source_folder_for_fp = os.path.abspath(
                            os.path.join(
                                folder_path, shared_data_fp["canonical_folder"]
                            )
                        )
                except:
                    pass
            transcript_path_for_fp = self.find_transcript(source_folder_for_fp)
            if transcript_path_for_fp:
                fingerprint_aliases = parser.extract_fingerprint_aliases(
                    transcript_path_for_fp
                )
                if fingerprint_aliases:
                    print(
                        f"  [Fingerprints] Found {len(fingerprint_aliases)} pre-identified speakers from voice matching."
                    )

            # Fetch active council members for AI validation
            active_council_members = self._get_active_council_members(
                meta["meeting_date"]
            )
            if active_council_members:
                print(
                    f"  [Context] Active Council Members: {', '.join(active_council_members)}"
                )

            refined_obj = refine_meeting_data(
                agenda_text,
                minutes_text,
                transcript_text,
                attendees_context=attendees_context,
                canonical_names_context=canonical_str,
                meeting_date=meta.get("meeting_date"),
                fingerprint_aliases=fingerprint_aliases
                if fingerprint_aliases
                else None,
                active_council_members=active_council_members,
            )
            if refined_obj:
                refined = refined_obj.model_dump()
                print("  [+] AI Refinement Success!")

                # Update meeting type and organization based on AI
                # A standing committee's folder is authoritative: the model tends to call them advisory.
                ai_type = (calendar_meeting_type or ("Standing Committee" if m_type_guess == "Standing Committee" else None)
                           or refined.get("meeting_type"))
                ai_status = refined.get("status")
                ai_summary = normalize_meeting_summary(refined["summary"]) if refined.get("summary") else None

                update_fields = {}
                if ai_type:
                    # Map the AI-identified type to a canonical Organization
                    target_org_name, target_org_class = self.map_type_to_org(ai_type, meeting_data["title"])

                    if ai_type == "Advisory Committee":
                        for candidate_org in [
                            "Official Community Plan Review Advisory Committee",
                            "Capital West Accessibility Advisory Committee",
                        ]:
                            if candidate_org.lower() in meeting_data["title"].lower():
                                target_org_name = candidate_org
                                target_org_class = "Advisory Committee"
                                break

                    org_id = calendar_organization_id or self.get_or_create_organization(
                        target_org_name, target_org_class, dry_run
                    )
                    update_fields["organization_id"] = org_id
                    update_fields["type"] = ai_type

                # Only accept AI status if it doesn't downgrade a past meeting.
                # The ingester's date-based status (Occurred/Completed) is authoritative
                # over the AI's content-based guess (which may say "Planned" for
                # agenda-only meetings that already happened).
                status_rank = {"Planned": 0, "Occurred": 1, "Completed": 2}
                if ai_status and not cancelled_meeting and status_rank.get(ai_status, 0) >= status_rank.get(meeting_status, 0):
                    update_fields["status"] = ai_status

                if ai_summary:
                    update_fields["summary"] = ai_summary

                if update_fields and not dry_run:
                    self.supabase.table("meetings").update(update_fields).eq(
                        "id", meeting_id
                    ).execute()

                if refined.get("chair_person_name") and not dry_run:
                    chair_id = self.get_or_create_person(
                        refined["chair_person_name"], dry_run
                    )
                    self.supabase.table("meetings").update(
                        {"chair_person_id": chair_id}
                    ).eq("id", meeting_id).execute()
            else:
                raise RuntimeError(f"AI refinement failed for meeting {meeting_id}; content ingestion incomplete")
        elif refined and refined.get("summary") and not dry_run and not canonical_cached_refresh:
            # If we already have refinement but it wasn't in the initial meeting_data upsert
            self.supabase.table("meetings").update({"summary": normalize_meeting_summary(refined["summary"])}).eq(
                "id", meeting_id
            ).execute()
        if not refined:
            raise RuntimeError(f"No refined data available for meeting {meeting_id}; content ingestion incomplete")

        # Parse Scratchpad for Timestamps (MM:SS or HH:MM:SS -> Seconds) - Run on FRESH or CACHED data
        if refined and refined.get("scratchpad_timeline") and refined.get("items"):
            # Only parse if we haven't already populated timestamps (or if we want to overwrite?)
            # Usually the AI puts timestamps in items directly, but scratchpad is a backup.
            # We'll run this if items are missing start times.
            has_times = any(i.get("discussion_start_time") for i in refined["items"])
            if not has_times:
                print("  [i] Parsing timeline timestamps from scratchpad...")
                timeline_text = refined["scratchpad_timeline"]
                time_matches = re.findall(
                    r"(\d+(?:\.[a-z\d]+)*)\.?\s+.*?\(.*?([\d:]+)-([\d:]+)",
                    timeline_text,
                )
                timeline_map = {}
                for item_num, start_str, end_str in time_matches:
                    start_sec = to_seconds(start_str)
                    end_sec = to_seconds(end_str)
                    if start_sec is not None:
                        timeline_map[item_num] = (start_sec, end_sec)

                if timeline_map:
                    print(
                        f"  [+] Extracted {len(timeline_map)} timestamp ranges from scratchpad."
                    )
                    for item in refined["items"]:
                        clean_order = item.get("item_order", "").strip(".)")
                        if clean_order in timeline_map:
                            s, e = timeline_map[clean_order]
                            item["discussion_start_time"] = s
                            if e:
                                item["discussion_end_time"] = e

        # Final Alignment using Transcript Markers (if available) - Run on FRESH or CACHED data
        if refined and refined.get("items") and has_transcript:
            print("  [i] Aligning items with transcript markers...")
            # We need the segments in a list of dicts for the aligner
            try:
                source_folder_for_align = folder_path
                shared_path_align = os.path.join(folder_path, "shared_media.json")
                if os.path.exists(shared_path_align):
                    try:
                        with open(shared_path_align, "r", encoding="utf-8") as f:
                            shared_data_align = json.load(f)
                            source_folder_for_align = os.path.abspath(
                                os.path.join(
                                    folder_path, shared_data_align["canonical_folder"]
                                )
                            )
                    except:
                        pass

                transcript_path_align = self.find_transcript(source_folder_for_align)
                if transcript_path_align:
                    segments_for_align = parser.extract_transcript_segments(
                        transcript_path_align
                    )
                    if segments_for_align:
                        # Map internal 'start_time' to 'start' for aligner
                        for sa in segments_for_align:
                            sa["start"] = sa["start_time"]
                            sa["end"] = sa["end_time"]

                        refined["items"] = align_meeting_items(
                            refined["items"], segments_for_align
                        )
                        print(
                            f"  [+] Successfully aligned {len(refined['items'])} items."
                        )
            except Exception as e:
                print(f"  [!] Alignment failed: {e}")

        refinement_path = os.path.join(folder_path, "refinement.json")
        if not dry_run and refined:
            # Save if it doesn't exist yet, OR if we just got it from an AI call (not from local disk)
            if not os.path.exists(refinement_path) or not precomputed_refinement:
                try:
                    with open(refinement_path, "w", encoding="utf-8") as f:
                        json.dump(refined, f, indent=2)
                    print(f"  [+] Saved refinement to {refinement_path}")
                except Exception as e:
                    print(f"  [!] Error saving refinement.json: {e}")

        # 3. Attendance (skip for planned meetings to prevent hallucinations)
        # Council / Committee of the Whole members come from the original minutes roster (with
        # evidence); only members it cannot resolve fall back to the AI attendee list below.
        roster_resolved = set()
        if classification == "Council" and not is_planned_meeting and not canonical_cached_refresh:
            roster_resolved = self._write_roster_attendance(meeting_id, org_id, meta["meeting_date"], folder_path, dry_run)
        if refined.get("attendees") and not is_planned_meeting and not canonical_cached_refresh:
            print(f"  Found {len(refined['attendees'])} attendees.")
            for name in refined["attendees"]:
                person_id = self.get_or_create_person(name, dry_run)
                if person_id in roster_resolved:
                    continue
                if person_id and not dry_run:
                    mode = self.local_attendance_modes.get(name, "In Person")
                    att_data = {
                        "meeting_id": meeting_id,
                        "person_id": person_id,
                        "attendance_mode": mode,
                    }
                    self.supabase.table("attendance").upsert(
                        att_data, on_conflict="meeting_id,person_id"
                    ).execute()

        # Aliases from AI, fingerprints and legacy DB rows are proposals only.
        # No model name or spelling precedence may create a person link or alias.
        alias_candidates = {"groups": {}, "unrecognized_labels": []}
        if not is_planned_meeting and not canonical_cached_refresh:
            alias_candidates = self._speaker_alias_candidate_inventory(
                meeting_id, refined.get("speaker_aliases") or []
            )
            conflicts = sum(group["status"] == "normalized_alias_conflict"
                            for group in alias_candidates["groups"].values())
            print(f"  [Identity] Alias candidates held pending independent proof ({conflicts} normalized conflicts).")

        # 5. Transcript
        source_folder = folder_path
        shared_path = os.path.join(folder_path, "shared_media.json")
        if os.path.exists(shared_path):
            try:
                with open(shared_path, "r", encoding="utf-8") as f:
                    shared_data = json.load(f)
                    source_folder = os.path.abspath(
                        os.path.join(folder_path, shared_data["canonical_folder"])
                    )
            except:
                pass

        transcript_path = self.find_transcript(source_folder)
        is_shared = os.path.exists(shared_path)

        if transcript_path and os.path.exists(transcript_path) and not canonical_cached_refresh:
            segments = parser.extract_transcript_segments(transcript_path)

            # Extract and save speaker centroids (voice fingerprints) to meeting meta
            speaker_centroids = parser.extract_speaker_centroids(transcript_path)
            speaker_samples = parser.extract_speaker_samples(transcript_path)
            if speaker_centroids and not dry_run:
                try:
                    # Get existing meta
                    existing = (
                        self.supabase.table("meetings")
                        .select("meta")
                        .eq("id", meeting_id)
                        .single()
                        .execute()
                    )
                    current_meta = (
                        existing.data.get("meta") or {} if existing.data else {}
                    )

                    # Update meta with centroids, samples, and fingerprint matches
                    current_meta["speaker_centroids"] = speaker_centroids
                    if speaker_samples:
                        current_meta["speaker_samples"] = speaker_samples

                    # Acoustic centroids are not named identities. Unvalidated
                    # fingerprint names must not replace speaker_mapping/matches.

                    self.supabase.table("meetings").update({"meta": current_meta}).eq(
                        "id", meeting_id
                    ).execute()
                    print(
                        f"  [Fingerprints] Saved {len(speaker_centroids)} speaker centroids to meeting meta."
                    )
                except Exception as e:
                    print(f"  [!] Failed to save speaker centroids: {e}")

            if segments:
                # Normal imports must populate missing transcripts too. Re-imports
                # preserve existing segments unless an explicit update was requested.
                should_insert_segments = replace_transcript or dry_run
                if not should_insert_segments:
                    existing_segments = (
                        self.supabase.table("transcript_segments")
                        .select("id").eq("meeting_id", meeting_id).limit(1).execute()
                    )
                    should_insert_segments = not bool(existing_segments.data)
                m_start = 0
                m_end = 999999
                if is_shared and refined.get("items"):
                    starts = [
                        i.get("discussion_start_time")
                        for i in refined["items"]
                        if i.get("discussion_start_time") is not None
                    ]
                    ends = [
                        i.get("discussion_end_time")
                        for i in refined["items"]
                        if i.get("discussion_end_time") is not None
                    ]
                    if starts:
                        m_start = min(starts) - 10
                    if ends:
                        m_end = max(ends) + 10
                    print(
                        f"  [Shared Media] Filtering segments to meeting range {m_start}s - {m_end}s."
                    )
                else:
                    print(f"  Found {len(segments)} transcript segments.")

                if not dry_run:
                    # Only delete and re-insert segments if we are forcing a full update
                    if replace_transcript:
                        print(
                            "  [!] replace_transcript=True: Deleting unverified segments for re-insertion."
                        )
                        self.supabase.table("transcript_segments").delete().eq(
                            "meeting_id", meeting_id
                        ).eq("is_verified", False).execute()
                    else:
                        print(
                            "  [i] Preserving existing segments; empty transcripts will be populated."
                        )
                        pass

                # Named identities are reconciled separately with pinned
                # source/recording/run evidence and private atomic receipts.
                rows = []
                # Only prepare rows if we are going to insert them
                if should_insert_segments:
                    for seg in segments:
                        if is_shared:
                            if seg["start_time"] < m_start or seg["start_time"] > m_end:
                                continue

                        label = seg["speaker"]
                        p_id = None
                        s_name = label

                        rows.append(
                            {
                                "meeting_id": meeting_id,
                                "speaker_name": s_name,
                                "person_id": p_id,
                                "start_time": seg["start_time"],
                                "end_time": seg["end_time"],
                                "text_content": seg["text"],
                                "attribution_source": "UNIDENTIFIED_DIARIZATION",
                            }
                        )

                    # Apply AI Corrections
                    corrections = refined.get("transcript_corrections", [])
                    if corrections:
                        print(
                            f"  Applying {len(corrections)} transcript corrections..."
                        )
                        for row in rows:
                            current_text = row["text_content"]
                            for corr in corrections:
                                orig = corr.get("original_text")
                                fix = corr.get("corrected_text")
                                if orig and fix and orig in current_text:
                                    current_text = current_text.replace(orig, fix)
                            row["text_content"] = current_text

                    # Consolidate consecutive same-speaker segments
                    if len(rows) > 1:
                        consolidated = [rows[0]]
                        for row in rows[1:]:
                            prev = consolidated[-1]
                            if (
                                row["speaker_name"] == prev["speaker_name"]
                                and row["person_id"] == prev["person_id"]
                                # Do not turn silence between ASR statements into
                                # recorded speech when computing profile totals.
                                and row["start_time"] == prev["end_time"]
                            ):
                                prev["text_content"] = prev["text_content"] + " " + row["text_content"]
                                prev["end_time"] = row["end_time"]
                            else:
                                consolidated.append(row)
                        if len(consolidated) < len(rows):
                            print(
                                f"  Consolidated {len(rows)} segments → {len(consolidated)} "
                                f"({len(rows) - len(consolidated)} merged)"
                            )
                            rows = consolidated

                    batch_size = 100  # Smaller batches to avoid statement timeout
                    if not dry_run and rows:
                        total_batches = (len(rows) + batch_size - 1) // batch_size
                        for i in range(0, len(rows), batch_size):
                            batch = rows[i : i + batch_size]
                            batch_num = i // batch_size + 1
                            self.supabase.table("transcript_segments").insert(
                                batch
                            ).execute()
                            if total_batches > 5:
                                print(f"    Inserted batch {batch_num}/{total_batches}")

                        # Set video_duration_seconds from max segment end_time
                        max_end = max(
                            (r.get("end_time", 0) for r in rows), default=0
                        )
                        if max_end > 0:
                            self.supabase.table("meetings").update(
                                {"video_duration_seconds": int(max_end)}
                            ).eq("id", meeting_id).execute()
                            print(
                                f"  Set video_duration_seconds = {int(max_end)}s "
                                f"({int(max_end) // 60}m)"
                            )

        # 6. Items, Motions, Votes
        prior_ballots = {}
        ballot_context = {"status": "planned_meeting"}
        if not is_planned_meeting:
            ballot_meeting = catalog_identity(cached_catalog) if canonical_cached_refresh else {
                "id": meeting_id, "meeting_date": meta["meeting_date"], "archive_path": normalized_path,
                "classification": classification, "title": meta.get("title", ""), "type": m_type_guess,
                "organization_id": org_id, "minutes_url": meeting_data.get("minutes_url")}
            ballot_context = cached_ballot_context if cached_ballot_context is not None else load_source_context(ballot_meeting)
        # SAFEGUARD: Don't process motions/votes for Planned meetings (prevent hallucinations)
        if is_planned_meeting:
            print(
                "  [!] Planned meeting - skipping motions/votes to prevent hallucinations"
            )

        existing_items = []
        existing_motions = []
        old_votes = []
        if self.supabase:
            existing_items = list(self.supabase.table("agenda_items").select("id,item_order,title,meta,updated_at").eq("meeting_id", meeting_id).execute().data)
            existing_motions_result = self.supabase.table("motions").select("id,meeting_id,mover_id,seconder_id,agenda_item_id,text_content,result,meta,updated_at,plain_english_summary,disposition,time_offset_seconds,financial_cost,funding_source", count="exact").eq("meeting_id", meeting_id).execute()
            existing_motions = existing_motions_result.data
            if existing_motions_result.count and existing_motions_result.count > len(existing_motions):
                raise RuntimeError("Existing motion inventory incomplete; refusing identity refresh")
            if existing_motions:
                motion_ids = [motion["id"] for motion in existing_motions]
                while True:
                    page = self.supabase.table("votes").select("id,motion_id,person_id,vote,recusal_reason").in_("motion_id", motion_ids).order("id").range(len(old_votes), len(old_votes)+999).execute().data
                    old_votes.extend(page)
                    if len(page) < 1000:
                        break
            prior_ballots = index_prior_ballots(existing_motions, old_votes)
        claim_writes = []
        initial_claim_inventory = ballot_context.get("meeting_claim_inventory")
        ballot_outcomes = Counter()
        canonical_report = {"status": "not_enabled_for_source"}
        # Any non-Council body whose ballot rules are not validated (standing committees backfilled from
        # Glyphdex, advisory committees such as SDAC, boards such as Board of Variance) has no validated
        # membership or minutes rules yet. Keyed on the ballot context status, not on body names: bodies
        # with validated rules (Community Advisory Committee) get status "available" and stay canonical.
        # Ingest items and documents and hold every AI motion reading as unverified.
        committee_hold = motion_hold_applies(is_planned_meeting, classification, ballot_context)
        canonical_enabled = not is_planned_meeting and not committee_hold and (
            ballot_context.get("status") == "available" or "archive/langford/" in normalized_path.replace("\\", "/")
        )
        if committee_hold:
            for item in refined.get("items", []):
                item["_unverified_motion_proposals"] = item.pop("motions", None) or []
                item["motions"] = []
            print(f"  [i] {classification}: motions held as unverified proposals (no validated ballot rules for this body yet)")
        if canonical_enabled:
            if not valid_inventory(initial_claim_inventory, meeting_id):
                raise RuntimeError("Complete current motion claims required before source writes")
            refined["items"], canonical_report = canonical_motion_plan(refined.get("items", []), ballot_context, existing_motions)
            if canonical_report["status"] != "source_authoritative":
                # A worker must retry missing/invalid official documents rather
                # than report an AI-only motion ingestion as complete.
                raise RuntimeError("Canonical official motions unavailable: " + str(canonical_report["status"]))

            canonical_report["validation_inputs"] = validation_inputs
            if not dry_run:
                write_source_receipt(self.supabase, meeting_id, {**canonical_report, "status": "in_progress"}, ballot_context["source"])
                for old_motion in existing_motions:
                    if old_motion["id"] not in canonical_report.get("unmapped_legacy_ids", []):
                        continue
                    old_meta = old_motion.get("meta") or {}
                    if old_meta.get("individual_vote_coverage") != "reconstructed_complete":
                        continue
                    has_choices = any(vote["motion_id"] == old_motion["id"] for vote in old_votes)
                    held_meta = {**old_meta, "individual_vote_coverage": "named_only",
                                 "vote_record": {**old_meta.get("vote_record", {}), "coverage": "partial" if has_choices else "not_recorded"},
                                 "source_binding_hold": {"status": "legacy_motion_not_bound_to_current_official_source", "source_sha256": ballot_context["source"]["source_sha256"]}}
                    if old_meta.get("ballot_reconstruction"):
                        held_meta["prior_ballot_proof"] = old_meta["ballot_reconstruction"]
                    if old_meta.get("vote_record"):
                        held_meta["prior_vote_record"] = old_meta["vote_record"]
                    query = self.supabase.table("motions").update({"meta": held_meta}).eq("id", old_motion["id"])
                    if old_motion.get("updated_at"):
                        query = query.eq("updated_at", old_motion["updated_at"])
                    held_result = query.execute().data
                    if not held_result:
                        raise RuntimeError("Held legacy motion changed concurrently; retry source refresh")
                    record_intended_claim_write(initial_claim_inventory, claim_writes, {"id": old_motion["id"], "meta": held_meta}, held_result)

        # Categories that should not create matters
        PROCEDURAL_CATEGORIES = {
            "procedural", "call to order", "adjournment", "termination",
        }

        key_statement_context = None
        key_statement_validation = Counter()
        key_statement_evidence = []
        # Rows already bound to an earlier refined item of this run.
        claimed_item_ids = set()
        for item in refined["items"]:
            retained_item = None
            if canonical_cached_refresh:
                if not item.get("motions"):
                    continue
                retained_item = existing_agenda_item(item, existing_items, claimed_item_ids)
                old_parents = [motion["_existing_motion"]["agenda_item_id"] for motion in item["motions"] if motion.get("_existing_motion")]
                if not retained_item and len(old_parents) == len(item["motions"]):
                    # Each old motion retains its own original parent below;
                    # no cached agenda rewrite is needed to process its proof.
                    retained_item = next((old for old in existing_items if old["id"] == old_parents[0]), None)
                if not retained_item:
                    # A genuinely new source motion needs a parent, but a
                    # cached AI agenda title is not proof of a new agenda item.
                    item = {"item_order": "official-recorded-motions", "title": "Official recorded motions", "category": "procedural", "motions": item["motions"]}
                    retained_item = existing_agenda_item(item, existing_items, claimed_item_ids)
            if retained_item:
                matter_id = None  # Existing item enrichment is not written.
                related_address = None
            else:
                # Matter Linking Strategy:
                # 1. Prefer a valid AI extracted identifier (e.g. "Bylaw 45")
                # 2. Fall back to regex from title
                # 3. Match against existing identifiers, addresses, entity clusters, titles
                # 4. Create new matter only when the item passes eligibility gates
                raw_matter_identifier = item.get("matter_identifier")
                title_identifier = self.extract_identifier_from_text(item.get("title"))
                if is_valid_matter_identifier(raw_matter_identifier):
                    matter_identifier = raw_matter_identifier
                else:
                    matter_identifier = title_identifier
                matter_title = item.get("matter_title") or item.get("title")
                related_address = self.normalize_address_list(item.get("related_address"))

                # Skip matter linking for procedural items (unless they have an explicit identifier)
                item_category = (item.get("category") or "").lower()
                item_title_lower = (item.get("title") or "").lower()
                is_procedural = (
                    item_category in PROCEDURAL_CATEGORIES
                    or item_title_lower in PROCEDURAL_CATEGORIES
                )

                eligible, eligibility_reason = is_matter_eligible(
                    identifier=matter_identifier,
                    title=matter_title,
                    category=item.get("category"),
                    related_addresses=related_address,
                    summary=item.get("plain_english_summary"),
                )

                if (is_procedural and not matter_identifier) or not eligible:
                    if matter_title:
                        print(
                            f"  [i] Skipping matter link for '{matter_title}' "
                            f"({eligibility_reason})"
                        )
                    matter_id = None
                else:
                    matter_id = self.get_or_create_matter(
                        matter_identifier,
                        matter_title,
                        meta["meeting_date"],
                        dry_run,
                        related_addresses=related_address,
                    )

            tags = self.normalize_address_list(item.get("tags"))

            base_slug = self._slugify(item.get("title") or "untitled")
            slug = f"{meeting_id}-{self._slugify(item.get('item_order') or '0')}-{base_slug}"
            if len(slug) > 200:
                slug = slug[:200]

            item_data = {
                "meeting_id": meeting_id,
                "matter_id": matter_id,
                "slug": slug,
                "item_order": item.get("item_order"),
                "title": item.get("title"),
                "description": item.get("description"),
                "category": item.get("category"),
                "plain_english_summary": item.get("plain_english_summary"),
                "related_address": related_address,
                "debate_summary": item.get("debate_summary"),
                "is_controversial": item.get("is_controversial"),
                "discussion_start_time": to_seconds(item.get("discussion_start_time")),
                "discussion_end_time": to_seconds(item.get("discussion_end_time")),
                "financial_cost": item.get("financial_cost"),
                "funding_source": item.get("funding_source"),
                "keywords": tags,
                "meta": {"key_quotes": item.get("key_quotes"), **({"unverified_motion_proposals": item.get("_unverified_motion_proposals", [])} if canonical_enabled or committee_hold else {})},
            }

            agenda_item_id = 200  # Placeholder for dry run
            if not dry_run:
                old_item = retained_item or existing_agenda_item(item, existing_items, claimed_item_ids)
                if retained_item:
                    agenda_item_id = retained_item["id"]
                elif old_item:
                    # A missing enrichment value is not a request to erase a
                    # previously populated agenda field during refresh.
                    item_data = {key: value for key, value in item_data.items() if value is not None}
                    # A re-run may render the same item as "4(a)" vs "4a" or with a
                    # retyped title; the persisted identity (and its unique slug) stays.
                    for identity_key in ("slug", "item_order", "title"):
                        item_data.pop(identity_key, None)
                    item_data["meta"] = {**(old_item.get("meta") or {}), **{key: value for key, value in item_data["meta"].items() if value is not None}}
                    query = self.supabase.table("agenda_items").update(item_data).eq("id", old_item["id"])
                    if old_item.get("updated_at"):
                        query = query.eq("updated_at", old_item["updated_at"])
                    res = query.execute()
                    if not res.data:
                        raise RuntimeError("Agenda changed concurrently; retry source refresh")
                    agenda_item_id = old_item["id"]
                else:
                    res = self.supabase.table("agenda_items").insert(item_data).execute()
                    agenda_item_id = res.data[0]["id"]
                    existing_items.append({**item_data, "id": agenda_item_id})
                claimed_item_ids.add(agenda_item_id)
                # Track for geocoding pass
                item["_db_id"] = agenda_item_id

            # Spoken statements must bind original source content to actual
            # persisted rows. AI names and recorded votes cannot create people.
            for ks in ([] if canonical_cached_refresh else item.get("key_statements", [])):
                if ks.get("evidence_kind") == "transcript" and key_statement_context is None:
                    key_statement_context = load_statement_context(self.supabase, meeting_id, transcript_path)
                supported = bind_key_statement(ks, key_statement_context or {})
                if supported["status"] != "source_supported":
                    key_statement_validation[supported["reason"]] += 1
                    continue
                if not dry_run:
                    published = publish_key_statement(self.supabase, meeting_id, agenda_item_id, supported, key_statement_context)
                    key_statement_evidence.append({"statement_id": published["statement_id"],
                                                   "proof_digest": published["proof_digest"], **supported["evidence"]})
                key_statement_validation[supported["evidence"]["identity_status"]] += 1

            # Validation for Motion Timestamps
            item_start = item_data.get("discussion_start_time")

            # Skip motions for planned meetings
            if is_planned_meeting:
                continue

            for mot in item.get("motions", []):
                raw_ts = to_seconds(mot.get("timestamp"))

                # Logic: If motion timestamp looks like a "hallucinated float" (e.g. 1.05)
                # while the item starts much later (e.g. 3600s), it's better to have NO timestamp
                # than a wrong one at the beginning of the meeting.
                final_ts = raw_ts
                if (
                    item_start
                    and item_start > 100
                    and raw_ts is not None
                    and raw_ts < 100
                ):
                    # print(f"  [!] Dropping suspicious motion timestamp: {raw_ts} (Item starts at {item_start})")
                    final_ts = None

                mover_name = mot.get("mover")
                seconder_name = mot.get("seconder")

                if mot.get("_canonical_actor_ids") is not None:
                    # A source surname is not permission to create a new person
                    # or pick another same-surname resident. Only its unique
                    # documentary roster identity can supply an actor ID.
                    mover_id = mot["_canonical_actor_ids"]["mover"]
                    seconder_id = mot["_canonical_actor_ids"]["seconder"]
                else:
                    mover_id = self.get_or_create_person(mover_name, dry_run) if mover_name else None
                    seconder_id = self.get_or_create_person(seconder_name, dry_run) if seconder_name else None

                # Every newly persisted choice/outcome must have a bounded
                # official source. Model/cache choices alone are not evidence.
                source_motion = mot.get("_source_motion") or (match_motion_record(mot, minutes_md) if minutes_md else None)
                proposed_result = mot.get("result")
                result_conflict = bool(source_motion and proposed_result and outcome_family(proposed_result) != outcome_family(source_motion["result"]))
                verified_result = source_motion["result"] if source_motion and not result_conflict else None
                vote_records = named_votes(source_motion, self._get_canonical_names()) if not result_conflict else []
                vote_meta = {
                    "coverage": "partial" if vote_records else "not_recorded",
                    "source": "bounded_official_minutes" if source_motion else "unverified_extraction",
                    "source_text_sha256": hashlib.sha256(minutes_md.encode("utf-8")).hexdigest() if minutes_md else None,
                    "individual_vote_evidence": vote_records,
                    "extracted_vote_proposals": mot.get("votes") or [],
                    "vote_validation": "source_only",
                    "extracted_result": proposed_result,
                    "outcome_status": "conflicting" if result_conflict else "verified" if verified_result else "not_verified",
                    "outcome_source_quote": source_motion.get("outcome_quote") if source_motion else None,
                    "source_motion_text": source_motion.get("motion_text") if source_motion else None,
                    "match_score": source_motion.get("match_score") if source_motion else None,
                    "anchor_method": source_motion.get("anchor_method") if source_motion else None,
                    "extracted_motion_text": mot.get("motion_text"),
                }
                motion_data = {
                    "meeting_id": meeting_id,
                    "agenda_item_id": agenda_item_id,
                    "mover": mover_name,
                    "seconder": seconder_name,
                    "mover_id": mover_id,
                    "seconder_id": seconder_id,
                    "text_content": mot.get("_operative_motion_text") or (source_motion["motion_text"] if source_motion and source_motion.get("anchor_method") in ("verbatim_quote_exact_identity", "canonical_native_formal_motion") else mot.get("motion_text")),
                    "plain_english_summary": mot.get("plain_english_summary"),
                    "disposition": mot.get("disposition"),
                    "result": verified_result,
                    "meta": {"individual_vote_coverage": "named_only" if vote_records else "not_recorded", "vote_record": vote_meta},
                    "time_offset_seconds": final_ts,
                    "financial_cost": mot.get("financial_cost"),
                    "funding_source": mot.get("funding_source"),
                }
                # Documentary reconstruction uses the original source/roster and
                # automatically refreshed policy, never the AI attendance list.
                for choice in vote_records:
                    choice["person_id"] = self.get_or_create_person(choice["person_name"], dry_run)
                old_motion = mot.get("_existing_motion")
                if not canonical_enabled:
                    matches = [old for old in existing_motions if normalize_text(old.get("text_content")) == normalize_text(motion_data["text_content"])]
                    if len(matches) > 1:
                        raise RuntimeError("Existing ballot cannot be mapped uniquely; retaining meeting motion history")
                    old_motion = matches[0] if matches else None
                prior = {"motion": old_motion, "votes": [vote for vote in old_votes if vote["motion_id"] == old_motion["id"]]} if old_motion else None
                motion_data["meta"] = {**((old_motion or {}).get("meta") or {}), **motion_data["meta"]}
                if mot.get("_full_transcription_validation"):
                    motion_data["text_content"] = old_motion["text_content"]
                    motion_data["meta"]["full_transcription_validation"] = mot["_full_transcription_validation"]
                if mot.get("_operative_motion_body"):
                    motion_data["meta"]["operative_motion_body"] = mot["_operative_motion_body"]
                if mot.get("_canonical_source_motion"):
                    motion_data["meta"].pop("source_binding_hold", None)
                    motion_data["meta"]["canonical_source_motion"] = mot["_canonical_source_motion"]
                    if old_motion:
                        motion_data["meta"].setdefault("source_legacy_binding", {"motion_id": old_motion["id"], "original_motion_text": old_motion["text_content"], "original_result": old_motion.get("result")})
                if old_motion:
                    # Equal operative words do not require replacing readable
                    # stored spacing with joined PDF extraction glyphs. Native
                    # wording remains verbatim in the source identity/proof.
                    if normalize_text(old_motion['text_content']) == normalize_text(motion_data['text_content']):
                        motion_data['text_content'] = old_motion['text_content']
                    for field in ("plain_english_summary", "disposition", "time_offset_seconds", "financial_cost", "funding_source"):
                        if motion_data.get(field) is None:
                            motion_data[field] = old_motion.get(field)
                evaluation_context = ballot_context
                if mot.get("_full_transcription_validation"):
                    pending = {**motion_data, "id": old_motion["id"]}
                    current_intended = intended_inventory(initial_claim_inventory, claim_writes)
                    rows = [pending if row["id"] == pending["id"] else row for row in current_intended["claims"]]
                    evaluation_context = {**ballot_context, "meeting_claim_inventory": build_claim_inventory(rows, meeting_id=meeting_id, expected_count=len(rows))}
                vote_records, motion_data["meta"] = merge_ballot_evidence(
                    {**motion_data, "id": (old_motion or {}).get("id")}, vote_records, evaluation_context, prior,
                )

                ballot_status = motion_data["meta"].get("ballot_reconstruction", {}).get("status", "not_recorded")
                ballot_outcomes["complete" if motion_data["meta"].get("individual_vote_coverage") == "reconstructed_complete" else ballot_status] += 1
                motion_id = 300
                if not dry_run:
                    final_meta = motion_data["meta"]
                    publish_complete = final_meta.get("individual_vote_coverage") == "reconstructed_complete"
                    if publish_complete:
                        motion_data["meta"] = {**final_meta, "individual_vote_coverage": "named_only",
                            "ballot_reconstruction": {"status": "vote_persistence_pending"},
                            "vote_record": {**final_meta.get("vote_record", {}), "coverage": "pending"},
                            "pending_ballot_proof": final_meta["ballot_reconstruction"]}
                    if old_motion:
                        # Preserve both the primary key and its original agenda
                        # association; a model renumbering is not source proof.
                        motion_data["agenda_item_id"] = old_motion["agenda_item_id"]
                        query = self.supabase.table("motions").update(motion_data).eq("id", old_motion["id"])
                        if old_motion.get("updated_at"):
                            query = query.eq("updated_at", old_motion["updated_at"])
                        m_res = query.execute()
                        if not m_res.data:
                            raise RuntimeError("Motion changed concurrently; retry source refresh")
                        motion_id = old_motion["id"]
                    else:
                        try:
                            m_res = self.supabase.table("motions").insert(motion_data).execute()
                        except Exception as error:
                            if getattr(error, "code", None) == "23505" and mot.get("_canonical_source_motion"):
                                collision = self.supabase.table("motions").select("id,text_content").eq("meeting_id", meeting_id).contains("meta", {"canonical_source_motion": {"key": mot["_canonical_source_motion"]["key"]}}).execute().data
                                if len(collision) == 1 and normalize_text(collision[0]["text_content"]) == normalize_text(motion_data["text_content"]):
                                    raise RuntimeError("Concurrent canonical insert recovered; retry with fresh motion and vote snapshots") from error
                            raise
                        motion_id = m_res.data[0]["id"]
                    if canonical_enabled:
                        record_intended_claim_write(initial_claim_inventory, claim_writes, {**motion_data, "id": motion_id}, m_res.data)
                    # Existing ballot rows are immutable during a document
                    # refresh. The evidence merge holds disagreements and only
                    # missing, source-validated choices may be appended.
                    existing_people = {vote["person_id"] for vote in (prior or {}).get("votes", [])}
                    for v in vote_records:
                        v_person_id = v.get("person_id") or self.get_or_create_person(v["person_name"], dry_run)
                        if v_person_id and v_person_id not in existing_people:
                            self.supabase.table("votes").insert({
                                "motion_id": motion_id, "person_id": v_person_id,
                                "vote": v["vote"], "recusal_reason": v.get("reason"),
                            }).execute()
                            existing_people.add(v_person_id)
                    if publish_complete:
                        persisted_choices = self.supabase.table("votes").select("id,person_id,vote").eq("motion_id", motion_id).execute().data
                        expected = {choice["person_id"]: choice["vote"] for choice in vote_records}
                        actual = {choice["person_id"]: choice["vote"] for choice in persisted_choices}
                        old_ids = {choice["id"] for choice in (prior or {}).get("votes", [])}
                        if len(persisted_choices) != len(expected) or actual != expected or not old_ids <= {choice["id"] for choice in persisted_choices}:
                            raise RuntimeError("Persisted choices differ from complete source ballot; coverage remains pending")
                        final_meta.pop("pending_ballot_proof", None)
                        query = self.supabase.table("motions").update({"meta": final_meta}).eq("id", motion_id)
                        persisted = m_res.data[0]
                        if persisted.get("updated_at"):
                            query = query.eq("updated_at", persisted["updated_at"])
                        completed_rows = query.execute().data
                        if not completed_rows:
                            raise RuntimeError("Motion changed while persisting choices; coverage remains pending")
                        if canonical_enabled:
                            record_intended_claim_write(initial_claim_inventory, claim_writes, {"id": motion_id, "meta": final_meta}, completed_rows)

        if canonical_enabled and not dry_run:
            expected_inputs = validation_inputs
            final_meeting = ballot_meeting
            if canonical_cached_refresh:
                current_catalog = self.supabase.table("meetings").select(catalog_columns).eq("id", meeting_id).single().execute().data
                if isinstance(current_catalog, list):
                    current_catalog = current_catalog[0]
                final_meeting = catalog_identity(current_catalog)
            final_context = load_source_context(final_meeting)
            if ({key: value for key, value in validation_inputs.items() if key != "claim_inventory_sha256"}
                    != {key: value for key, value in expected_inputs.items() if key != "claim_inventory_sha256"}):
                raise RuntimeError("Validation inputs changed before receipt publication; retry source facts")
            if not intended_claim_transition(initial_claim_inventory, final_context.get("meeting_claim_inventory") or {}, claim_writes):
                raise RuntimeError("Unexpected semantic claim change before receipt publication; retry source facts")
            canonical_report["validation_inputs"] = validation_inputs
            canonical_report["ballot_validation"] = {"complete": ballot_outcomes.get("complete", 0),
                "held": sum(count for status, count in ballot_outcomes.items() if status != "complete"),
                "hold_reasons": {status: count for status, count in ballot_outcomes.items() if status != "complete"}}
            write_source_receipt(self.supabase, meeting_id, canonical_report, ballot_context["source"])

        if not dry_run and not is_planned_meeting:
            from .matter_lifecycle import refresh_meeting_matter_lifecycles
            refresh_meeting_matter_lifecycles(self.supabase, meeting_id)

        # 7. Geocode agenda items with related_address but no geo data
        if refined.get("items") and not dry_run and not canonical_cached_refresh:
            self._geocode_agenda_items(meeting_id, refined["items"], dry_run)

        return {
            "meeting_id": meeting_id,
            "meeting": meeting_data,
            "attendance": refined.get("attendees", []) if refined else [],
            "items": refined.get("items", []) if refined else [],
            "canonical_motion_ingestion": canonical_report,
            "key_statement_validation": {"counts": dict(key_statement_validation), "evidence": key_statement_evidence},
            "identity_links": (self.reconcile_transcript_identities(folder_path, meeting_id) if not dry_run else None),
            "source_only_refresh": canonical_cached_refresh,
            "speaker_alias_candidates": {
                "status": "proposals_only",
                "normalized_groups": len(alias_candidates["groups"]),
                "conflicting_labels": [key for key, group in alias_candidates["groups"].items()
                                       if group["status"] == "normalized_alias_conflict"],
                "unrecognized_labels": len(alias_candidates["unrecognized_labels"]),
            },
        }

    def process_legistar_meeting(self, scraped_meeting, target_dir, force_update=False):
        """Fast-path ingestion for Legistar meetings using structured API data.

        Skips AI refinement since Legistar provides structured meeting data directly.
        """
        from pipeline.scrapers.base import ScrapedMeeting

        meeting_date = str(scraped_meeting.date)
        title = scraped_meeting.title
        source_id = scraped_meeting.source_id

        # Check if already ingested (by source_id in meta)
        if not force_update and source_id:
            res = (
                self.supabase.table("meetings")
                .select("id")
                .eq("municipality_id", self.municipality_id)
                .contains("meta", {"legistar_event_id": source_id})
                .execute()
            )
            if res.data:
                print(f"  [->] Legistar meeting {source_id} already ingested. Skipping.")
                return None

        print(f"  [Legistar] Ingesting: {meeting_date} - {title}")

        # Organization
        meeting_type = scraped_meeting.meeting_type or "Council"
        org_name, classification = self.map_type_to_org(meeting_type)
        org_id = self.get_or_create_organization(org_name, classification)

        # The date and meeting type are not unique: councils can hold two
        # Special Council meetings on the same day. Use a stable source key.
        source_key = source_id or "|".join(
            [meeting_date, title, scraped_meeting.agenda_url or ""]
        )
        legistar_path = (
            f"legistar/{self.municipality_id}/"
            f"{hashlib.sha256(str(source_key).encode('utf-8')).hexdigest()[:24]}"
        )
        existing_meeting_id = None
        if source_id:
            existing = (
                self.supabase.table("meetings")
                .select("id")
                .eq("municipality_id", self.municipality_id)
                .contains("meta", {"legistar_event_id": source_id})
                .maybe_single()
                .execute()
            )
            existing_meeting_id = (existing.data or {}).get("id")

        # Meeting upsert
        meeting_data = {
            "title": title,
            "meeting_date": meeting_date,
            "organization_id": org_id,
            "type": utils.infer_meeting_type(meeting_type),
            "municipality_id": self.municipality_id,
            "archive_path": legistar_path,
            "agenda_url": scraped_meeting.agenda_url,
            "minutes_url": scraped_meeting.minutes_url,
            "video_url": scraped_meeting.video_url,
            "has_agenda": bool(scraped_meeting.agenda_url),
            "has_minutes": bool(scraped_meeting.minutes_url),
            "meta": {"legistar_event_id": source_id} if source_id else {},
        }

        if existing_meeting_id:
            res = (
                self.supabase.table("meetings")
                .update(meeting_data)
                .eq("id", existing_meeting_id)
                .execute()
            )
        else:
            res = (
                self.supabase.table("meetings")
                .upsert(meeting_data, on_conflict="archive_path")
                .execute()
            )

        if not res.data:
            print(f"  [!] Failed to upsert Legistar meeting: {title}")
            return None

        meeting_id = res.data[0]["id"]
        print(f"  [+] Meeting ID: {meeting_id}")

        # Process agenda items from Legistar meta (if available)
        legistar_event = scraped_meeting.meta.get("legistar_event", {})
        event_items = legistar_event.get("EventItems") if legistar_event else None

        if event_items:
            for i, item in enumerate(event_items):
                item_title = item.get("EventItemTitle", "")
                if not item_title:
                    continue

                item_data = {
                    "meeting_id": meeting_id,
                    "title": item_title,
                    "item_order": str(i + 1),
                    "category": "Substantive",
                }

                # Try to link a matter
                matter_identifier = item.get("EventItemMatterFile")
                if matter_identifier:
                    matter_id = self.get_or_create_matter(
                        matter_identifier,
                        item_title,
                        date=meeting_date,
                    )
                    if matter_id:
                        item_data["matter_id"] = matter_id

                self.supabase.table("agenda_items").insert(item_data).execute()

        return {"meeting": meeting_data, "meeting_id": meeting_id}
