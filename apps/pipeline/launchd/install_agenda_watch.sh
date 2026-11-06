#!/usr/bin/env bash
# Installs (or reinstalls) the agenda watch as a launchd agent: main.py --upcoming-agendas every 2 hours from
# 07:00 to 21:00. Run on the machine that does pipeline runs: ./launchd/install_agenda_watch.sh
# A run missed while the Mac sleeps happens once on wake. Remove: launchctl bootout gui/$(id -u)/<label>
set -euo pipefail

LABEL="com.viewroyal.langford-agenda-watch"
PIPELINE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ROOT="$(cd "$PIPELINE_DIR/../.." && pwd)"
LOG_DIR="$PROJECT_ROOT/data/langford/logs"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

INTERVALS=""
for hour in 7 9 11 13 15 17 19 21; do
  INTERVALS="$INTERVALS<dict><key>Hour</key><integer>$hour</integer><key>Minute</key><integer>5</integer></dict>"
done

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
chmod +x "$PIPELINE_DIR/launchd/run_agenda_watch.sh"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array><string>$PIPELINE_DIR/launchd/run_agenda_watch.sh</string></array>
    <key>WorkingDirectory</key><string>$PIPELINE_DIR</string>
    <key>StartCalendarInterval</key>
    <array>$INTERVALS</array>
    <key>StandardOutPath</key><string>$LOG_DIR/agenda-watch.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/agenda-watch.err.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key><string>$HOME</string>
        <key>PATH</key><string>/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>PYTHONUNBUFFERED</key><string>1</string>
    </dict>
</dict>
</plist>
PLIST

plutil -lint "$PLIST" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL (every 2 hours, 07:05-21:05). Logs: $LOG_DIR/agenda-watch.log"
