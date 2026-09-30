# Hermes Music (Umbrel community app store)

Anyone on your network requests a song on a web page; Claude Code (on your PC) finds it,
downloads it, and copies it to your Umbrel music library so Navidrome / Feishin can play it.

## Pieces
- `anjalo-hermes/` - the Umbrel app (request page + queue, port 3340). Install it from the community store.
- `worker/song-worker.ps1` - runs on your PC. Uses `claude -p` (your Claude Code login) to identify each song,
  then yt-dlp downloads it and scp copies it to `~/umbrel/data/storage/downloads/music`.
- `worker/setup-ssh.ps1` - one-time SSH key setup so the copy needs no password.

## Setup (PC)
1. Install yt-dlp and ffmpeg: `winget install yt-dlp.yt-dlp` and `winget install Gyan.FFmpeg`
2. `powershell -ExecutionPolicy Bypass -File worker\setup-ssh.ps1` (enter your Umbrel password once)
3. `powershell -ExecutionPolicy Bypass -File worker\song-worker.ps1` and leave it running.

The PC must be on for songs to be picked up; requests wait in the queue otherwise.
Only download music you're entitled to; ripping from YouTube may violate its terms and copyright law where you live.
The worker endpoints on the request page are not password protected (LAN only); do not expose port 3340 to the internet.
