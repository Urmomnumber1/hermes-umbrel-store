#!/bin/sh
# Starts the request page right away. The download tools (ffmpeg, ffprobe, yt-dlp, Claude Code) are
# single files cached in /data/tools, so they're fetched once (in parallel) and later starts are instant.
set -e
APP=$(cd "$(dirname "$0")" && pwd) # /data/app/<version> (fetched for this version) or /app (installed copy)
TOOLS=/data/tools
# drop code fetched for older versions
[ -n "$HM_VERSION" ] && [ -d /data/app ] && find /data/app -mindepth 1 -maxdepth 1 ! -name "$HM_VERSION" -exec rm -rf {} +
TV=2 # bump to force a fresh download of the cached tools
mkdir -p "$TOOLS/bin" /data/home /data/staging /music
# The music folder must be writable by the app user (uid 1000). Only the top folder is changed.
[ "$(stat -c %u /music)" = "1000" ] || chown 1000:1000 /music
rm -f "$TOOLS/ready" "$TOOLS/setup.log"
chown 1000:1000 /data /data/home /data/staging "$TOOLS" "$TOOLS/bin"

# yt-dlp needs a JavaScript runtime for YouTube; use the Node that's already in this image.
mkdir -p /data/home/.config/yt-dlp
printf '%s\n' '--js-runtimes node' '--remote-components ejs:github' > /data/home/.config/yt-dlp/config
chown -R 1000:1000 /data/home/.config

case "$(uname -m)" in
  aarch64|arm64) FF=linux-arm64; YT=yt-dlp_linux_aarch64 ;;
  *) FF=linux-x64; YT=yt-dlp_linux ;;
esac

# download URL FILE [gz]: Node's fetch, so no apt packages are needed
fetch() {
  node -e '
    const [url, out, gz] = process.argv.slice(1);
    (async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
      let buf = Buffer.from(await r.arrayBuffer());
      if (gz) buf = require("zlib").gunzipSync(buf);
      require("fs").writeFileSync(out + ".part", buf, { mode: 0o755 });
      require("fs").renameSync(out + ".part", out);
    })().catch((e) => { console.error(e.message); process.exit(1); });
  ' "$@"
}

(
  set -e
  # tools from older versions (yt-dlp needing Python, ffmpeg from apt) are replaced once
  if [ "$(cat "$TOOLS/version" 2>/dev/null)" != "$TV" ]; then
    rm -f "$TOOLS/bin/yt-dlp" "$TOOLS/bin/ffmpeg" "$TOOLS/bin/ffprobe"
  fi
  FFR=https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1
  pids=""
  [ -x "$TOOLS/bin/ffmpeg" ] || { fetch "$FFR/ffmpeg-$FF.gz" "$TOOLS/bin/ffmpeg" gz & pids="$pids $!"; }
  [ -x "$TOOLS/bin/ffprobe" ] || { fetch "$FFR/ffprobe-$FF.gz" "$TOOLS/bin/ffprobe" gz & pids="$pids $!"; }
  [ -x "$TOOLS/bin/yt-dlp" ] || { fetch "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$YT" "$TOOLS/bin/yt-dlp" & pids="$pids $!"; }
  [ -x "$TOOLS/npm/bin/claude" ] || { npm install -g --silent --no-audit --no-fund --prefix "$TOOLS/npm" @anthropic-ai/claude-code & pids="$pids $!"; }
  for p in $pids; do wait "$p"; done
  echo "$TV" > "$TOOLS/version"
  chown -R 1000:1000 "$TOOLS"
  touch "$TOOLS/ready"
  echo "tools ready"
  # keep yt-dlp current without holding up the queue
  setpriv --reuid=1000 --regid=1000 --clear-groups env HOME=/data/home "$TOOLS/bin/yt-dlp" -U || true
) >"$TOOLS/setup.log" 2>&1 &

exec setpriv --reuid=1000 --regid=1000 --clear-groups \
  env HOME=/data/home PATH="$TOOLS/bin:$TOOLS/npm/bin:$PATH" node "$APP/server.js"
