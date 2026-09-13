#!/usr/bin/env bash
#
# Expose the local Verification API on a public hostname.
#
# A Cloudflare quick tunnel needs no account and no DNS, which is why it is what
# the demo uses — but it gets a brand new hostname every time it starts. Three
# places hold that hostname (.env, the README table, and the deployed console's
# AGENTPROOF_API_URL), and chasing them by hand is how one of them ends up
# pointing at a dead host during a recording. This script rewrites the two it
# can reach and tells you about the third.
#
# Usage: bash scripts/tunnel.sh    (foreground; Ctrl-C stops the tunnel)
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-8402}"
LOG="$(mktemp -t agentproof-tunnel.XXXXXX.log)"

command -v cloudflared >/dev/null 2>&1 || {
  echo "cloudflared not found. Install it:" >&2
  echo "  curl -sfL -o ~/.local/bin/cloudflared \\" >&2
  echo "    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" >&2
  echo "  chmod +x ~/.local/bin/cloudflared" >&2
  exit 1
}

# Fail before opening a tunnel to nothing. A tunnel to a dead port succeeds and
# then serves 502s, which looks like a tunnel problem and is not one.
curl -sf -m 5 "http://127.0.0.1:${PORT}/health" >/dev/null || {
  echo "No API answering on 127.0.0.1:${PORT}. Start it first: pnpm api" >&2
  exit 1
}

echo "Opening tunnel to 127.0.0.1:${PORT} ..."
cloudflared tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate > "$LOG" 2>&1 &
TUNNEL_PID=$!
trap 'kill "$TUNNEL_PID" 2>/dev/null || true' EXIT

URL=""
for _ in $(seq 1 30); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  sleep 1
done

[ -n "$URL" ] || { echo "Tunnel did not report a hostname. Log: $LOG" >&2; exit 1; }

# Confirm it is actually reachable from outside before anyone relies on it.
curl -sf -m 20 "${URL}/health" >/dev/null || {
  echo "Tunnel opened at ${URL} but /health did not answer through it." >&2
  exit 1
}

if grep -q '^API_PUBLIC_URL=' .env 2>/dev/null; then
  sed -i.bak "s|^API_PUBLIC_URL=.*|API_PUBLIC_URL=${URL}|" .env && rm -f .env.bak
  echo "  .env        API_PUBLIC_URL updated"
fi

if grep -q 'trycloudflare\.com' README.md 2>/dev/null; then
  sed -i.bak -E "s|https://[a-z0-9-]+\.trycloudflare\.com|${URL}|g" README.md && rm -f README.md.bak
  echo "  README.md   deployed-links table updated"
fi

cat <<MSG

  Public API   ${URL}
  Health       ${URL}/health

  Still to do by hand: set AGENTPROOF_API_URL to the above in the Vercel
  project and redeploy. The console inlines it at build time, so editing the
  variable without a redeploy changes nothing.

  Ctrl-C to close the tunnel.
MSG

wait "$TUNNEL_PID"
