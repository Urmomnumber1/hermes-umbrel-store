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

## Using it
- Type a song name (add the artist for best results).
- `/album NAME` downloads a whole album, `/artist NAME` an artist's albums (limits in Config).
- `/duplicate` lists copies of the same song (same artist, title and length) and keeps the best-quality one;
  `/duplicate confirm` (plus your PIN, if set) moves the extras to the hidden `.duplicates` folder in your music folder.
- Songs already in the music folder are skipped: the app indexes the folder's tags on start and every 30 minutes.
- Tags and covers come from iTunes or Deezer; songs neither knows are saved as singles named after the song.

## Catalogues and Spotify links (no accounts needed)
- Tags, covers and tracklists come from iTunes; when iTunes has no good match, from Deezer's free public API.
- Paste Spotify song, album, playlist or artist links: the tracklist is read from Spotify's public embed page.
  Audio always comes from YouTube. If Spotify changes those pages, links may stop working until the app is updated.

## Downtify backup (optional)
If the Downtify app is installed, turn on **Use Downtify as backup** in Config (default address and login work for
the Umbrel app; press Test). Hermes Music always tries itself first and only hands a song to Downtify when it can't find
or download it. The file is then moved from Downtify's folder into your music folder and re-tagged like any other song.

## Notes
- The page has no login (guests use it); keep port 3340 off the internet.
- Secrets (Claude token, API key) are stored in the app's data folder on the Umbrel and never sent to the page.
- Only download music you're entitled to; ripping from YouTube may violate its terms and copyright law where you live.