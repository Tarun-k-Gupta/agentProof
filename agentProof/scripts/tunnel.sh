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

# A tunnel to a dead port opens fine and then serves 502s, which looks like a
# tunnel problem and is not one — so say something. But do not refuse: the
# correct boot order is tunnel FIRST, because the API bakes API_PUBLIC_URL into
# its x402 challenge at startup and cannot learn a hostname that does not exist
# yet. Refusing here forces an API restart later, which is how the challenge
# ends up advertising a hostname that has already been replaced.
if ! curl -sf -m 5 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "Note: nothing answering on 127.0.0.1:${PORT} yet."
  echo "That is expected if you are running this before 'pnpm api' — which is"
  echo "the right order. The tunnel will 502 until the API is up."
  API_UP=0
else
  API_UP=1
fi

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
# cloudflared prints the hostname as soon as it has one, which is well before
# Cloudflare's edge will route to it — a single check here fails on a tunnel
# that is merely young, kills it, and sends you chasing a problem you do not
# have. Retry for a minute before calling it broken.
if [ "$API_UP" = "1" ]; then
  echo "Waiting for the edge to route ${URL} ..."
  REACHABLE=0
  for _ in $(seq 1 20); do
    if curl -sf -m 10 "${URL}/health" >/dev/null 2>&1; then REACHABLE=1; break; fi
    sleep 3
  done

  [ "$REACHABLE" = "1" ] || {
    echo "Tunnel opened at ${URL} but /health never answered through it." >&2
    echo "The API is up locally, so this is the tunnel, not the API. Log: $LOG" >&2
    exit 1
  }
fi

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

  Start the API next, in a shell that sources this .env, so its x402 challenge
  advertises the hostname above. An API already running when this script ran is
  still advertising the old one and needs a restart.

  Still to do by hand: set AGENTPROOF_API_URL to the above in the Vercel
  project and redeploy. The console inlines it at build time, so editing the
  variable without a redeploy changes nothing.

  Ctrl-C to close the tunnel.
MSG

wait "$TUNNEL_PID"
