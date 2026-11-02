#!/usr/bin/env bash
# Installs (or reinstalls) the quick worker as a launchd agent that starts at login and restarts if it stops.
# Run on the machine that should do staff page fixes: ./launchd/install_quick_worker.sh
set -euo pipefail

LABEL="com.viewroyal.langford-quick-worker"
PIPELINE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_ROOT="$(cd "$PIPELINE_DIR/../.." && pwd)"
LOG_DIR="$PROJECT_ROOT/data/langford/logs"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
chmod +x "$PIPELINE_DIR/launchd/run_quick_worker.sh"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array><string>$PIPELINE_DIR/launchd/run_quick_worker.sh</string></array>
    <key>WorkingDirectory</key><string>$PIPELINE_DIR</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>30</integer>
    <key>StandardOutPath</key><string>$LOG_DIR/quick-worker.log</string>
    <key>StandardErrorPath</key><string>$LOG_DIR/quick-worker.err.log</string>
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
echo "Installed $LABEL. Logs: $LOG_DIR/quick-worker.log"
