#!/usr/bin/env bash
# Installs and enables the autopilot service (does not start it).
set -euo pipefail
cd "$(dirname "$0")"
[ -f config.json ] || cp config.example.json config.json
command -v claude >/dev/null || { echo "claude not found in PATH" >&2; exit 1; }
install -m 644 systemd/agent-autopilot.service /etc/systemd/system/agent-autopilot.service
mkdir -p /root/.config
touch /root/.config/agent-autopilot.env && chmod 600 /root/.config/agent-autopilot.env
systemctl daemon-reload
systemctl enable agent-autopilot
echo "Installed. Start with: systemctl start agent-autopilot"
