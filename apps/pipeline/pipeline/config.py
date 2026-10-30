import os

from dotenv import load_dotenv  # Import this

# Load environment variables from .env file
load_dotenv()  # Run this

# Base URLs
CIVICWEB_BASE_URL = "https://viewroyalbc.civicweb.net"
VIMEO_PROFILE_URL = "https://vimeo.com/viewroyal"

# Which municipality the pipeline works on when --municipality isn't given.
MUNICIPALITY_SLUG = os.environ.get("MUNICIPALITY_SLUG") or "langford"

# API Credentials
VIMEO_ACCESS_TOKEN = os.environ.get("VIMEO_TOKEN")
SUPABASE_URL = os.environ.get("SUPABASE_URL")
ALERT_WORKER_KEY = os.environ.get("ALERT_WORKER_KEY")
# Legacy local email-enqueue outbox. Off by default: the web Worker cron now
# enqueues per-meeting alerts, so the pipeline needs no persistent outbox file.
PIPELINE_EMAIL_OUTBOX = os.environ.get("PIPELINE_EMAIL_OUTBOX", "").lower() == "true"
ALERT_OUTBOX_PATH = os.environ.get(
    "ALERT_OUTBOX_PATH",
    os.path.join(os.environ.get("XDG_STATE_HOME", os.path.expanduser("~/.local/state")),
                 "openlangford", "email-enqueue.sqlite3"),
)
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")
SUPABASE_SECRET_KEY = os.environ.get("SUPABASE_SECRET_KEY")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
DATABASE_URL = os.environ.get("DATABASE_URL")
SUPABASE_DB_PASSWORD = os.environ.get("SUPABASE_DB_PASSWORD")
MOSHI_TOKEN = os.environ.get("MOSHI_TOKEN")

# AI settings (models, providers, timeouts) are resolved per stage in pipeline.ai.config.

# Diarization
DIARIZATION_DEVICE = os.environ.get("DIARIZATION_DEVICE", "mps")

# Local Storage
# Files will be downloaded directly into this clean structure
OUTPUT_DIR = os.path.join(os.getcwd(), "viewroyal_archive")

# Network Settings
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
REQUEST_TIMEOUT = 30
YTDLP_SOCKET_TIMEOUT = 30  # yt-dlp per-socket timeout (seconds)
DELAY_BETWEEN_REQUESTS = 0.1

# Cookie Settings for Vimeo
# Options: 'chrome', 'firefox', 'safari', 'opera', 'edge', 'brave'
COOKIE_BROWSER = "chrome"
