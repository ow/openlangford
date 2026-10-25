"""ISI Live video client used by eSCRIBE portals."""

from __future__ import annotations

import os
import re
import subprocess
import time
from urllib.parse import quote, urljoin

import requests
import yt_dlp

from pipeline import config, utils


class ISILiveClient:
    """Fetch and download recordings from ISI Live/eSCRIBE player links."""

    def __init__(
        self,
        base_url: str,
        client_id: str,
        meeting_types: list[str] | None = None,
        verify_ssl: bool = True,
    ):
        self.base_url = base_url.rstrip("/")
        self.client_id = client_id
        self.meeting_types = meeting_types or ["Council Meeting"]
        self.session = requests.Session()
        self.session.verify = verify_ssl
        self.session.headers.update({"User-Agent": config.USER_AGENT})

    def get_video_map(self, limit=None):
        print("\n--- Fetching Video Metadata (ISI Live/eSCRIBE) ---")
        video_map: dict[str, list[dict]] = {}
        count = 0

        for meeting_type in self.meeting_types:
            for meeting in self._fetch_meetings_for_type(meeting_type):
                if limit and count >= limit:
                    break

                video_url = meeting.get("VideoUrl")
                if not video_url:
                    continue

                date_key = self._meeting_date_key(meeting)
                if not date_key:
                    continue

                player_url = urljoin(f"{self.base_url}/", video_url)
                title = f"{date_key} {meeting.get('MeetingType') or meeting_type}"
                video_map.setdefault(date_key, []).append(
                    {
                        "url": player_url,
                        "title": title,
                        "uri": meeting.get("Id"),
                        "duration": 0,
                        "client_id": self.client_id,
                    }
                )
                count += 1

            if limit and count >= limit:
                break

        print(f"[*] Found {len(video_map)} video date(s).")
        return video_map

    def search_video(self, date_str, title_hint=None):
        videos = self.get_video_map()
        matches = videos.get(date_str) or []
        if not matches:
            return None
        if len(matches) == 1 or not title_hint:
            return matches[0]

        hint = title_hint.lower()
        return next((v for v in matches if self._matches_hint(v["title"], hint)), None)

    def download_video(
        self,
        video_data,
        output_folder,
        include_video=False,
        download_audio=False,
    ):
        os.makedirs(output_folder, exist_ok=True)

        if include_video and self._find_files(output_folder, {".mp4"}):
            include_video = False
        if download_audio and self._find_files(output_folder, {".mp3", ".m4a", ".wav"}):
            download_audio = False

        media_url = self._resolve_media_url(video_data)
        if not media_url:
            print(f"  [!] Could not resolve ISI media URL for {video_data.get('title')}")
            return None

        safe_title = self._safe_title(media_url, video_data)
        video_path = None
        if include_video:
            video_path = self._download_media_file(media_url, output_folder, safe_title)

        if download_audio and not include_video:
            try:
                return self._extract_audio_from_url_ffmpeg(
                    media_url,
                    output_folder,
                    safe_title,
                )
            except (subprocess.CalledProcessError, RuntimeError) as e:
                print(f"  [!] Direct ISI audio extraction failed; falling back to full media download: {e}")

        if download_audio:
            video_path = self._download_media_file(media_url, output_folder, safe_title)
            self._extract_audio_ffmpeg(video_path, output_folder, safe_title)
            files = self._find_files(output_folder, {".mp3", ".m4a", ".wav"})
            if files:
                return max(files, key=os.path.getctime)

        return None

    def _resolve_media_url(self, video_data: dict) -> str | None:
        player_url = video_data.get("url")
        if not player_url:
            return None

        try:
            resp = self.session.get(player_url, timeout=config.REQUEST_TIMEOUT)
            resp.raise_for_status()
        except requests.RequestException as e:
            print(f"  [!] Failed to fetch ISI player: {e}")
            return None

        client_id = self._extract_attr(resp.text, "data-client_id") or video_data.get("client_id") or self.client_id
        file_name = self._extract_attr(resp.text, "data-file_name")
        if not file_name:
            return None

        return f"https://video.isilive.ca/{quote(client_id)}/{quote(file_name)}"

    def _download_media_file(
        self,
        media_url: str,
        output_folder: str,
        safe_title: str,
    ) -> str:
        existing_video = self._find_media_files(output_folder, safe_title, {".mp4", ".mov", ".m4v"})
        if existing_video:
            return max(existing_video, key=os.path.getctime)

        print(f"  [ISI] Downloading full media before audio extraction: {safe_title}")
        opts = {
            "outtmpl": os.path.join(output_folder, f"{safe_title}.%(ext)s"),
            "format": "bestvideo+bestaudio/best",
            "quiet": False,
            "no_warnings": True,
        }

        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([media_url])

        video_files = self._find_media_files(output_folder, safe_title, {".mp4", ".mov", ".m4v"})
        if not video_files:
            raise RuntimeError(f"ISI media download did not produce a video file for {safe_title}")
        return max(video_files, key=os.path.getctime)

    @staticmethod
    def _find_files(output_folder: str, extensions: set[str]) -> list[str]:
        if not os.path.isdir(output_folder):
            return []
        return [
            os.path.join(output_folder, name)
            for name in os.listdir(output_folder)
            if os.path.isfile(os.path.join(output_folder, name))
            and os.path.splitext(name)[1].lower() in extensions
        ]

    @classmethod
    def _find_media_files(
        cls,
        output_folder: str,
        safe_title: str,
        extensions: set[str],
    ) -> list[str]:
        return [
            path
            for path in cls._find_files(output_folder, extensions)
            if os.path.splitext(os.path.basename(path))[0] == safe_title
        ]

    @staticmethod
    def _safe_title(media_url: str, video_data: dict) -> str:
        return utils.sanitize_filename(
            video_data.get("title")
            or os.path.splitext(os.path.basename(media_url))[0]
            or "meeting_audio"
        )

    @staticmethod
    def _extract_audio_ffmpeg(
        video_path: str,
        output_folder: str,
        safe_title: str,
    ) -> str:
        output_path = os.path.join(output_folder, f"{safe_title}.m4a")
        if os.path.exists(output_path):
            return output_path

        cmd = [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-i",
            video_path,
            "-vn",
            "-map",
            "a:0",
            "-codec:a",
            "copy",
            output_path,
        ]
        try:
            subprocess.run(cmd, check=True)
        except subprocess.CalledProcessError:
            if os.path.exists(output_path):
                os.remove(output_path)
            raise
        return output_path

    @staticmethod
    def _extract_audio_from_url_ffmpeg(
        media_url: str,
        output_folder: str,
        safe_title: str,
    ) -> str:
        output_path = os.path.join(output_folder, f"{safe_title}.m4a")
        if os.path.exists(output_path):
            return output_path

        print(f"  [ISI] Extracting audio directly from media URL: {safe_title}")
        cmd = [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-reconnect",
            "1",
            "-reconnect_streamed",
            "1",
            "-reconnect_delay_max",
            "5",
            "-i",
            media_url,
            "-vn",
            "-map",
            "a:0",
            "-codec:a",
            "copy",
            output_path,
        ]
        try:
            subprocess.run(cmd, check=True)
        except subprocess.CalledProcessError:
            if os.path.exists(output_path):
                os.remove(output_path)
            raise
        if not os.path.exists(output_path):
            raise RuntimeError(f"ISI audio extraction did not produce an audio file for {safe_title}")
        return output_path

    def _fetch_meetings_for_type(self, meeting_type: str) -> list[dict]:
        endpoint = f"{self.base_url}/MeetingsCalendarView.aspx/PastMeetings"
        meetings: list[dict] = []
        page = 1

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
    def _meeting_date_key(raw: dict) -> str | None:
        # Must agree with the folder date chosen by the eSCRIBE scraper, which
        # prefers the official display dates (the epoch is not real UTC).
        from pipeline.scrapers.escribe import EscribeScraper

        official = EscribeScraper._parse_meeting_date(raw)
        if official:
            return official.isoformat()
        return utils.extract_date_from_string(raw.get("FormattedStart") or "")

    @staticmethod
    def _extract_attr(html: str, attr: str) -> str | None:
        match = re.search(rf'{re.escape(attr)}=["\']([^"\']+)["\']', html)
        return match.group(1) if match else None

    @staticmethod
    def _matches_hint(title: str, hint: str) -> bool:
        title = title.lower()
        if "public hearing" in hint:
            return "public hearing" in title
        if "committee" in hint or "cow" in hint:
            return "committee" in title or "cow" in title
        if "council" in hint:
            return "council" in title and "public hearing" not in title
        return False
