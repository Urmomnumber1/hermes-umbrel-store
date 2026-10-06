# Hermes Music (Umbrel community app store)

A song request page that runs entirely on your Umbrel. Anyone on your network requests a song,
Hermes Music identifies it, downloads it with yt-dlp and saves it into your Umbrel music folder
(Files app: Home > Downloads > music, i.e. `/home/umbrel/umbrel/home/Downloads/music`), where Navidrome picks it up for Feishin.

## Setup
1. Add this repo as a community app store in Umbrel and install **Hermes Music**.
2. Open it (or `http://<umbrel-ip>:3340`). The first start downloads ffmpeg, yt-dlp and Claude Code (cached, so
   later starts are instant); the Worker line shows when they are ready.
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
- Queued requests show a number (`#3`); `/now 3` moves that one to the front (`/bump NAME` does the same by name).
- Config > Provider > **Both** runs Claude Code and a local model at the same time (two songs at once).
- `/rescan` re-reads the music folder (it also does this every 30 minutes; only new or changed files are read).
- `/video SONG` finds the official music video for a song in your library (`/video SONG | LINK` to pick one,
  `/video list`, `/video remove SONG`). The custom Feishin build shows a video button for those songs and streams the
  video with YouTube's embedded player; nothing is downloaded. Feishin asks `GET /api/videos/lookup?artist=&title=`.
- Videos are picked from the artist's own (or VEVO) channel and the most-watched uploads, skipping fan edits, lyric and
  audio uploads; each pick is then checked by sound against your file, and the next candidate is tried if it isn't the
  same recording. Wrong anyway? Press **Wrong video** in Feishin or type `/video wrong SONG`.
- The custom Feishin updates itself from this fork's releases (downloads in the background, installs when you close it).
- Music videos play muted in step with the song in the custom Feishin. Hermes Music lines each video up with the song
  in the background by matching the sound (the video's audio is fetched for that and deleted right after).
- Group Play (custom Feishin, people icon): a host creates a group and shares the 5-letter code; members join, hear what
  the host plays, and can add songs (right-click > Add to group queue). Only the host skips or seeks. Hermes Music relays
  the state (`/api/group/...`, Server-Sent Events); groups live in memory.
- `/duplicate` lists copies of the same song (same artist, title and length) and keeps the best-quality one;
  `/duplicate confirm` (plus your PIN, if set) moves the extras to the hidden `.duplicates` folder in your music folder.
- Songs already in the music folder are skipped: the app indexes the folder's tags on start and every 30 minutes.
- Tags and covers come from iTunes or Deezer; songs neither knows are saved as singles named after the song.

## Catalogues and Spotify links (no accounts needed)
- Tags, covers and tracklists come from iTunes; when iTunes has no good match, from Deezer's free public API.
- Paste Spotify song, album, playlist or artist links: the tracklist is read from Spotify's public embed page.
  Audio always comes from YouTube. If Spotify changes those pages, links may stop working until the app is updated.

## Downtify backup (optional)
If the Downtify app is installed, turn on **Use Downtify as backup** in Config. Best: in Downtify open Settings > Apps,
create a pairing code, paste it into Config and press Pair (no password needed). Then press Test. Hermes Music always tries itself first and only hands a song to Downtify when it can't find
or download it. The file is then moved from Downtify's folder into your music folder and re-tagged like any other song.

## Notes
- The page has no login (guests use it); keep port 3340 off the internet.
- Secrets (Claude token, API key) are stored in the app's data folder on the Umbrel and never sent to the page.
- Only download music you're entitled to; ripping from YouTube may violate its terms and copyright law where you live.

---

# Stocks AI

An AI portfolio assistant. Claude reviews your Alpaca brokerage account, prices and news, then proposes trades.
Hard-coded risk limits check every proposal, and by default each trade waits for your approval. It starts on a paper (simulated) account.

## Setup
1. Install **Stocks AI** from this store and open it from the Umbrel dashboard (it's behind your Umbrel login).
2. In **Settings**, paste your Anthropic API key and your Alpaca **paper trading** key ID and secret (free at alpaca.markets).
3. Turn on **Trading on**, save, and click **Run AI now** during market hours. Suggested trades appear under **Awaiting your approval**.

Source code, risk rules and docs: https://github.com/Urmomnumber1/umbrel-apps/tree/main/stocks-ai
