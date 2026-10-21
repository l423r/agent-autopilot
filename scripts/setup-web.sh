#!/usr/bin/env bash
# Installs the browser panel: systemd unit + Caddy route /pult/ behind the same
# password as /term. Run by a person (it opens a new public path). Idempotent.
# CADDYFILE and SETUP_WEB_CADDY_ONLY=1 (edit the file only) exist for testing.
set -euo pipefail

DIR=/root/agent-autopilot
CADDYFILE=${CADDYFILE:-/etc/caddy/Caddyfile}
CREDS=/root/.config/ntfy-credentials
UNIT=agent-autopilot-web.service

if grep -q 'handle_path /pult/\*' "$CADDYFILE"; then
  echo "Caddyfile: /pult/ already present"
else
  # The basicauth hash line of the /term block (user + bcrypt hash).
  AUTH=$(awk '/handle \/term/ {t=1} t && /basicauth/ {b=1; next} t && b && NF==2 {print $1, $2; exit}' "$CADDYFILE")
  [ -n "$AUTH" ] || { echo "no basicauth under /term in $CADDYFILE" >&2; exit 1; }
  cp "$CADDYFILE" "$CADDYFILE.bak-pult"
  TMP=$(mktemp)
  # Insert before the catch-all `handle {` of the site block.
  awk -v auth="$AUTH" '
    !done && /^[[:space:]]*handle \{/ {
      print "\tredir /pult /pult/"
      print "\thandle_path /pult/* {"
      print "\t\tbasicauth {"
      print "\t\t\t" auth
      print "\t\t}"
      print "\t\treverse_proxy 127.0.0.1:7690"
      print "\t}"
      done = 1
    }
    { print }
    END { if (!done) exit 2 }
  ' "$CADDYFILE" > "$TMP" || { rm -f "$TMP"; echo "no catch-all 'handle {' in $CADDYFILE" >&2; exit 1; }
  cat "$TMP" > "$CADDYFILE"; rm -f "$TMP"
  echo "Caddyfile: /pult/ added (backup: $CADDYFILE.bak-pult)"
fi

[ "${SETUP_WEB_CADDY_ONLY:-}" = 1 ] && exit 0

caddy validate --config "$CADDYFILE" --adapter caddyfile

install -m 644 "$DIR/systemd/$UNIT" /etc/systemd/system/$UNIT
systemctl daemon-reload
systemctl enable --now $UNIT
systemctl reload caddy
sleep 2

HOST=$(awk 'NF && $1 !~ /^#/ && /\{$/ {print $1; exit}' "$CADDYFILE")
URL="https://$HOST/pult/"
read -r _ USER PASS < <(grep '^terminal ' "$CREDS")
NOAUTH=$(curl -s -o /dev/null -w '%{http_code}' "$URL")
WITHAUTH=$(curl -s -o /dev/null -w '%{http_code}' -u "$USER:$PASS" "$URL")
echo "без пароля: $NOAUTH (ждём 401), с паролем: $WITHAUTH (ждём 200)"
[ "$NOAUTH" = 401 ] && [ "$WITHAUTH" = 200 ] || { echo "ПРОВЕРКА НЕ ПРОШЛА" >&2; exit 1; }
echo "Пульт: $URL — впишите его в config.json как webPublicUrl"
