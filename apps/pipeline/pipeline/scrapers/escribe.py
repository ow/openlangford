"""eSCRIBE published meetings scraper."""

from __future__ import annotations

import os
import hashlib
import re
import time
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from pipeline import config, utils
from pipeline.scrapers.base import BaseScraper, MunicipalityConfig, ScrapedDocument, ScrapedMeeting


# eSCRIBE's `Start` epoch is NOT a real UTC instant: the portal serialises the
# Pacific wall-clock start time as if it were US Eastern (verified on all 258
# Langford meetings: epoch - wall clock = +4h in PDT, +5h in PST). Reading the
# epoch as UTC therefore rolls any meeting starting at/after 19:00 PST onto the
# next calendar day. Reading it back in Eastern recovers the wall clock exactly.
ESCRIBE_EPOCH_TZ = ZoneInfo("America/Toronto")


class EscribeScraper(BaseScraper):
    """Scraper for eSCRIBE public meeting portals.

    Expected source_config:
        {
            "type": "escribe",
            "base_url": "https://pub-langford.escribemeetings.com",
            "verify_ssl": false,
            "meeting_types": ["Council Meeting", "Special Council Meeting"],
            "video_source": {"type": "isilive", "client_id": "langford"}
        }
    """

    def __init__(self, municipality: MunicipalityConfig):
        super().__init__(municipality)
        self.base_url = self.source_config["base_url"].rstrip("/")
        self.meeting_types = self.source_config.get("meeting_types") or ["Council Meeting"]
        self.verify_ssl = self.source_config.get("verify_ssl", True)
        self.session = requests.Session()
        self.session.verify = self.verify_ssl
        self.session.headers.update(
            {
                "User-Agent": config.USER_AGENT,
                "Accept": "application/json, text/html;q=0.9,*/*;q=0.8",
            }
        )

    def discover_meetings(self, since_date: date | None = None) -> list[ScrapedMeeting]:
        meetings: list[ScrapedMeeting] = []
        seen: set[str] = set()

        for meeting_type in self.meeting_types:
            for raw in self._fetch_meetings_for_type(meeting_type):
                meeting_id = raw.get("Id")
                if not meeting_id or meeting_id in seen:
                    continue
                seen.add(meeting_id)

                meeting_date = self._parse_meeting_date(raw)
                if not meeting_date:
                    continue
                if since_date and meeting_date < since_date:
                    continue

                links = raw.get("MeetingLinks") or []
                documents: list[ScrapedDocument] = []
                agenda_url = None
                minutes_url = None

                for link in links:
                    link_url = link.get("Url")
                    if not link_url or (link.get("Format") or "").lower() != ".pdf":
                        continue

                    category = self._document_category(link)
                    title = self._clean_title(link.get("Title") or category or "Document")
                    full_url = urljoin(f"{self.base_url}/", link_url)

                    if category == "Agenda" and not agenda_url and link.get("Type") == "Agenda":
                        agenda_url = full_url
                    if category == "Minutes" and not minutes_url:
                        minutes_url = full_url

                    documents.append(
                        ScrapedDocument(
                            title=title,
                            url=full_url,
                            category=category,
                            file_format="pdf",
                        )
                    )

                title = raw.get("MeetingType") or meeting_type
                video_url = raw.get("VideoUrl")
                if video_url:
                    video_url = urljoin(f"{self.base_url}/", video_url)

                meetings.append(
                    ScrapedMeeting(
                        date=meeting_date,
                        title=title,
                        meeting_type=utils.infer_meeting_type(title),
                        organization_name=self.municipality.name,
                        agenda_url=agenda_url,
                        minutes_url=minutes_url,
                        video_url=video_url,
                        source_id=meeting_id,
                        documents=documents,
                        meta={"escribe_meeting": raw},
                    )
                )

        meetings.sort(key=lambda m: m.date, reverse=True)
        print(f"  [eSCRIBE] Discovered {len(meetings)} meeting(s)")
        return meetings

    def download_documents(self, meeting: ScrapedMeeting, target_dir: str) -> list[str]:
        os.makedirs(target_dir, exist_ok=True)
        downloaded: list[str] = []

        if meeting.video_url:
            video_dir = os.path.join(target_dir, "Video")
            os.makedirs(video_dir, exist_ok=True)
            with open(os.path.join(video_dir, "player.url"), "w", encoding="utf-8") as f:
                f.write(meeting.video_url)

        for doc in meeting.documents:
            if not doc.url:
                continue
            if doc.category == "Agenda" and "cover" in doc.title.lower():
                # A cover sheet cannot substitute for the full official agenda.
                continue

            category = doc.category or "Other Documents"
            subfolder = os.path.join(target_dir, category)
            os.makedirs(subfolder, exist_ok=True)

            filename = self._filename_for_document(doc)
            file_path = os.path.join(subfolder, filename)

            if os.path.exists(file_path):
                valid_pdf = self._valid_pdf(file_path)
                if valid_pdf:
                    downloaded.append(file_path)
                    continue
                else:
                    with open(file_path, "rb") as handle:
                        digest = hashlib.sha256(handle.read()).hexdigest()[:12]
                    quarantine = f"{file_path}.invalid-{digest}"
                    os.replace(file_path, quarantine)
                    if os.path.exists(f"{file_path}.url"):
                        os.replace(f"{file_path}.url", f"{quarantine}.url")
                    print(f"  [!] Invalid existing PDF quarantined: {quarantine}")

            partial_path = f"{file_path}.part"
            try:
                with self.session.get(doc.url, stream=True, timeout=config.REQUEST_TIMEOUT) as resp:
                    resp.raise_for_status()
                    with open(partial_path, "wb") as f:
                        for chunk in resp.iter_content(chunk_size=8192):
                            f.write(chunk)
                if not self._valid_pdf(partial_path):
                    raise ValueError(f"Expected readable PDF response from {doc.url}")
                os.replace(partial_path, file_path)
                with open(f"{file_path}.url", "w", encoding="utf-8") as f:
                    f.write(doc.url)
                print(f"  [+] Downloaded: {filename}")
                downloaded.append(file_path)
                time.sleep(config.DELAY_BETWEEN_REQUESTS)
            except (requests.RequestException, ValueError) as e:
                print(f"  [!] Failed to download {doc.title}: {e}")
            finally:
                if os.path.exists(partial_path):
                    os.remove(partial_path)

        # Public PDFs can be protected by eSCRIBE's browser-verification page
        # while the equivalent official HTML agenda/minutes remain accessible.
        # Preserve the source record instead of ingesting a transcript alone.
        present = {os.path.basename(os.path.dirname(path)) for path in downloaded}
        raw_meeting = meeting.meta.get("escribe_meeting") or {}
        for link in raw_meeting.get("MeetingLinks") or []:
            category = self._document_category(link)
            if category not in {"Agenda", "Minutes"} or category in present:
                continue
            if (link.get("Format") or "").lower() != "html" or not link.get("Url"):
                continue
            url = urljoin(f"{self.base_url}/", link["Url"])
            folder = os.path.join(target_dir, category)
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, f"{category}.html")
            try:
                if os.path.exists(path):
                    html = utils.read_text_file(path)
                else:
                    response = self.session.get(url, timeout=config.REQUEST_TIMEOUT)
                    response.raise_for_status()
                    html = response.text
                soup = BeautifulSoup(html, "html.parser")
                if not soup.select_one("#AgendaHeaderTitle") or not soup.select_one('[id^="AgendaItem"]'):
                    raise ValueError(f"No official meeting content in HTML response: {url}")
                if not os.path.exists(path):
                    with open(f"{path}.part", "w", encoding="utf-8") as handle:
                        handle.write(html)
                    os.replace(f"{path}.part", path)
                    with open(f"{path}.url", "w", encoding="utf-8") as handle:
                        handle.write(url)
                downloaded.append(path)
                with open(f"{path}.sha256", "w", encoding="utf-8") as handle:
                    handle.write(hashlib.sha256(html.encode("utf-8")).hexdigest() + "\n")
                present.add(category)
                print(f"  [+] Official HTML fallback: {category}")
            except (requests.RequestException, ValueError) as exc:
                print(f"  [!] Failed official HTML fallback: {exc}")
        return downloaded

    @staticmethod
    def _valid_pdf(path: str) -> bool:
        import fitz

        try:
            with open(path, "rb") as handle:
                if not handle.read(1024).lstrip().startswith(b"%PDF-"):
                    return False
            with fitz.open(path, filetype="pdf") as document:
                return document.page_count > 0
        except (ValueError, RuntimeError, OSError):
            return False

    def _fetch_meetings_for_type(self, meeting_type: str) -> list[dict]:
        endpoint = f"{self.base_url}/MeetingsCalendarView.aspx/PastMeetings"
        meetings: list[dict] = []
        page = 1

        # Prime ASP.NET session/cookies. The JSON endpoint is public, but this
        # mirrors browser behavior and avoids brittle anti-CSRF assumptions.
        try:
            self.session.get(
                f"{self.base_url}/meetingscalendarview.aspx",
                params={"Expanded": meeting_type, "fillWidth": "1"},
                timeout=config.REQUEST_TIMEOUT,
            )
        except requests.RequestException:
            pass

        while True:
            resp = self.session.post(
                endpoint,
                params={"Expanded": meeting_type, "fillWidth": "1"},
                json={"type": meeting_type, "pageNumber": page},
                headers={
                    "Content-Type": "application/json; charset=UTF-8",
                    "X-Requested-With": "XMLHttpRequest",
                },
                timeout=config.REQUEST_TIMEOUT,
            )
            resp.raise_for_status()
            payload = resp.json().get("d") or {}
            batch = payload.get("Meetings") or []
            meetings.extend(batch)

            total = int(payload.get("TotalCount") or len(meetings))
            if len(meetings) >= total or not batch:
                break
            page += 1
            time.sleep(config.DELAY_BETWEEN_REQUESTS)

        return meetings

    @staticmethod
    def _parse_meeting_date(raw: dict) -> date | None:
        # The portal's epoch can fall on a different UTC day from its official
        # calendar date. Require every supplied display date to agree.
        official_date = None
        for key in ("MeetingDate", "DateMedium", "DateShort"):
            value = raw.get(key)
            if value is None or value == "":
                continue
            if not isinstance(value, str):
                return None
            for fmt in ("%B %d, %Y", "%b %d, %Y"):
                try:
                    parsed = datetime.strptime(value, fmt).date()
                    break
                except ValueError:
                    continue
            else:
                return None
            if official_date is not None and parsed != official_date:
                return None
            official_date = parsed
        if official_date is not None:
            return official_date

        # Epoch fallback only when display dates are absent. See ESCRIBE_EPOCH_TZ:
        # the epoch is Pacific wall-clock mislabelled as Eastern, not UTC.
        start = raw.get("Start") or ""
        match = re.search(r"/Date\((-?\d+)\)/", start)
        if match:
            return datetime.fromtimestamp(int(match.group(1)) / 1000, tz=ESCRIBE_EPOCH_TZ).date()
        return None

    @staticmethod
    def _document_category(link: dict) -> str:
        link_type = link.get("Type") or ""
        title = (link.get("Title") or "").lower()
        if link_type in {"Agenda", "AgendaCover"} or "agenda" in title:
            return "Agenda"
        if link_type == "PostMinutes" or "minutes" in title:
            return "Minutes"
        return "Other Documents"

    @staticmethod
    def _clean_title(title: str) -> str:
        return re.sub(r"\s*\((PDF|HTML)\)\s*$", "", title, flags=re.IGNORECASE).strip()

    @staticmethod
    def _filename_for_document(doc: ScrapedDocument) -> str:
        parsed_name = os.path.basename(urlparse(doc.url).path)
        if parsed_name and parsed_name.lower().endswith(".pdf"):
            return utils.sanitize_filename(parsed_name)
        return f"{utils.sanitize_filename(doc.title)}.pdf"
