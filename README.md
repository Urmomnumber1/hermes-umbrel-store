# Hermes Music (Umbrel community app store)

A song request page that runs entirely on your Umbrel. Anyone on your network requests a song,
Hermes Music identifies it, downloads it with yt-dlp and saves it into your Umbrel music folder
(Files app: Home > Downloads > music, i.e. `/home/umbrel/umbrel/home/Downloads/music`), where Navidrome picks it up for Feishin.

## Setup
1. Add this repo as a community app store in Umbrel and install **Hermes Music**.
2. Open it (or `http://<umbrel-ip>:3340`). The first start installs ffmpeg, yt-dlp and Claude Code
   in the background; the Worker line shows when it's ready.
3. Open **Config** and pick a provider:
   - **Claude Code**: on any computer with Claude Code, run `claude setup-token`, then paste the token
     into Config. Uses your Claude subscription.
   - **Local model**: enter your OpenAI-compatible server's base URL (for example `http://<umbrel-ip>:11434/v1`
     for Ollama) and model name.
4. Set a PIN in Config so only you can change settings.
5. Make sure Navidrome's music folder is Home > Downloads > music. If existing files there aren't writable, run
   `sudo chown -R 1000:1000 /home/umbrel/umbrel/home/Downloads/music` once on the Umbrel.

## Notes
- The page has no login (guests use it); keep port 3340 off the internet.
- Secrets (Claude token, API key) are stored in the app's data folder on the Umbrel and never sent to the page.
- Only download music you're entitled to; ripping from YouTube may violate its terms and copyright law where you live.