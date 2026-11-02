#!/usr/bin/env bash
# Installs the archive workers (ingest and diarization) as launchd agents 2 and 3. They don't start at login;
# start one with: launchctl kickstart gui/$(id -u)/com.viewroyal.langford-archive-worker-2
set -euo pipefail

PIPELINE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ROOT="$(cd "$PIPELINE_DIR/../.." && pwd)"
LOG_DIR="$PROJECT_ROOT/data/langford/logs"
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
chmod +x "$PIPELINE_DIR/launchd/run_archive_worker.sh"

for n in 2 3; do
  LABEL="com.viewroyal.langford-archive-worker-$n"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array><string>$PIPELINE_DIR/launchd/run_archive_worker.sh</string></array>
    <key>WorkingDirectory</key><string>$PIPELINE_DIR</string>
    <key>StandardOutPath</key><string>$LOG_DIR/archive-worker-$n.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/archive-worker-$n.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key><string>$HOME</string>
        <key>PATH</key><string>/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>PYTHONUNBUFFERED</key><string>1</string>
    </dict>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "Installed $LABEL"
done
