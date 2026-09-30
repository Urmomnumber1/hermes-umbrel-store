# Anjalo's Umbrel Community App Store — Hermes Agent

Add to Umbrel: **App Store → ⋯ → Community App Stores → paste this repo's Git URL**.

Login: user `umbrel`, password = the app's default password shown in Umbrel.
Data lives in `~/umbrel/app-data/anjalo-hermes/data` (config.yaml, .env, memories, skills).
Add a provider key (e.g. `ANTHROPIC_API_KEY=...`) to `data/.env` or via the dashboard.

Notes
- Uses the official `nousresearch/hermes-agent:stable` image (amd64/arm64), pin a version/digest for production.
- The gateway API (8642) is not published; other Umbrel apps reach it at `http://anjalo-hermes_hermes_1:8642` with `API_SERVER_KEY`.
- Add an `icon:` URL and `gallery` images to `umbrel-app.yml` before publishing.

## Song requests -> Hermes -> Feishin

- Guests open `http://umbrel.local:3340` and type a song name (LAN only, no login, rate-limited).
- The request service wakes Hermes via its API (and re-checks every 5 min). The `song-requests` skill
  (`anjalo-hermes/skills/song-requests/SKILL.md`) has Hermes identify the song, find it on YouTube / YT Music
  with yt-dlp, save it to `/music` (= `~/umbrel/data/storage/downloads/music`) and report status.
- Point Navidrome (or Jellyfin) at that folder; Feishin is just the client for it. Make sure the folder exists
  and is writable by uid 1000 (`mkdir -p` it before starting the app).
- Hermes needs a model provider key configured, plus a model that can run tools.
- Only download music you're entitled to; ripping from YouTube may violate its terms and copyright law where you live.
