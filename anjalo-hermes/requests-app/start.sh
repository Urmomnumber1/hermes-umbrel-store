#!/bin/sh
# Starts the request page right away, and installs the download tools in the background
# (ffmpeg via apt each start; yt-dlp and Claude Code cached in /data/tools).
set -e
TOOLS=/data/tools
mkdir -p "$TOOLS/bin" /data/home /data/staging /music
# The music folder must be writable by the app user (uid 1000). Only the top folder is changed.
[ "$(stat -c %u /music)" = "1000" ] || chown 1000:1000 /music
rm -f "$TOOLS/ready" "$TOOLS/setup.log"
chown 1000:1000 /data /data/home /data/staging "$TOOLS" "$TOOLS/bin"

(
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends ffmpeg python3 ca-certificates curl
  if [ -x "$TOOLS/bin/yt-dlp" ]; then
    "$TOOLS/bin/yt-dlp" -U || true
  else
    curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "$TOOLS/bin/yt-dlp"
    chmod +x "$TOOLS/bin/yt-dlp"
  fi
  if [ ! -x "$TOOLS/npm/bin/claude" ]; then
    npm install -g --silent --prefix "$TOOLS/npm" @anthropic-ai/claude-code
  fi
  chown -R 1000:1000 "$TOOLS"
  touch "$TOOLS/ready"
) >"$TOOLS/setup.log" 2>&1 &

exec setpriv --reuid=1000 --regid=1000 --clear-groups \
  env HOME=/data/home PATH="$TOOLS/bin:$TOOLS/npm/bin:$PATH" node /app/server.js
