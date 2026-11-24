// Hermes Music's Discord bot (3.11): music, ambience and sound effects in a Discord voice channel, for
// D&D nights. Run from the Discord Bot tab in Sour Player (admins, and people they allow in Config).
// Hermes Music starts this as its own process once a bot token is saved in Config; the Discord libraries
// are installed into BOT_DEPS by Hermes the first time. It talks to Hermes over IPC:
//   Hermes -> bot: { id, cmd, args }
//   bot -> Hermes: { id, ok, result | error }, { type: "state", state }, { type: "log", text }
// Everything that plays is mixed here into one stream (Discord takes one per bot): the music (a queue),
// any number of looping ambience tracks, and one-shot sound effects on top. ffmpeg decodes each file.
// BOT_FAKE=1: no Discord at all (a pretend server with two voice channels, and what would be sent goes
// into BOT_DATA/fake-voice.wav), for trying the tab out without a bot.
// (3.17) "Hey Sour Box": with the ears switched on (Sour Player's Discord Bot tab), the bot stays undeafened
// in the voice channel and listens. What someone says goes, one sentence at a time, to a helper on this
// machine (sour-ears.py: Vosk speech recognition, nothing leaves the Umbrel); only sentences with "Sour Box"
// in them go on to Hermes Music, as text. Nothing is recorded or kept. The same commands can be typed:
// /sourbox, or a message that mentions the bot.
//   bot -> Hermes: { type: "heard", user: { id, name }, text, typed?, reply? }
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { createRequire } = require("module");

const FAKE = process.env.BOT_FAKE === "1";
const DEPS = process.env.BOT_DEPS || "/data/tools/discord-bot";
const DATA = process.env.BOT_DATA || "/data/discord-bot";
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const need = createRequire(path.join(DEPS, "package.json"));

const RATE = 48000;
const FRAME_SAMPLES = 960; // 20 ms
const FRAME = FRAME_SAMPLES * 2 * 2; // bytes: 16-bit stereo
const AHEAD = RATE * 2 * 2 * 2; // how much ffmpeg may decode ahead (2 s)
const ALONE_MS = 5 * 60 * 1000; // leave a voice channel nobody's in after 5 minutes

const send = (m) => { try { process.send(m); } catch {} };
const log = (text) => send({ type: "log", text });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));

// ---------- one sound: ffmpeg decodes the file to raw 48 kHz stereo, a little ahead of what's heard ----------
class Source {
  constructor(item, { loop = false, from = 0, gain = 1, fadeMs = 0 } = {}) {
    this.item = item;
    this.from = from;
    this.gain = gain; // where the volume is heading
    this.level = fadeMs ? 0 : gain; // where it is now
    this.step = fadeMs ? 1 / Math.max(1, fadeMs / 20) : 1; // per 20 ms
    this.chunks = [];
    this.size = 0;
    this.frames = 0;
    this.stopping = false;
    this.ended = false;
    this.err = "";
    const args = ["-v", "error", "-nostdin"];
    if (loop) args.push("-stream_loop", "-1");
    if (from > 0) args.push("-ss", String(from));
    args.push("-i", item.file, "-vn", "-f", "s16le", "-ar", String(RATE), "-ac", "2", "pipe:1");
    // FFMPEG may be a .js stand-in when trying the bot out on a computer without ffmpeg
    this.proc = FFMPEG.endsWith(".js")
      ? spawn(process.execPath, [FFMPEG, ...args], { stdio: ["ignore", "pipe", "pipe"] })
      : spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.proc.stdout.on("data", (d) => {
      this.chunks.push(d);
      this.size += d.length;
      if (this.size > AHEAD) this.proc.stdout.pause();
    });
    this.proc.stderr.on("data", (d) => { this.err = (this.err + d).slice(-500); });
    this.proc.on("error", (e) => { this.err = e.message; this.ended = true; });
    this.proc.on("close", () => {
      this.ended = true;
      if (this.err && !this.frames && !this.killed) log(`couldn't play ${item.title}: ${this.err.trim().split("\n").pop()}`);
    });
  }
  get finished() { return this.ended && this.size < FRAME && !(this.size > 0); }
  get position() { return this.from + this.frames * 0.02; }
  // the next 20 ms, or null when ffmpeg hasn't got that far yet (or it's over)
  take() {
    if (this.size < FRAME) {
      if (!this.ended || this.size === 0) return null;
      const last = Buffer.alloc(FRAME); // the end of the file: pad the last bit with silence
      Buffer.concat(this.chunks).copy(last);
      this.chunks = [];
      this.size = 0;
      this.frames++;
      return last;
    }
    let out;
    if (this.chunks[0].length >= FRAME) {
      out = this.chunks[0].subarray(0, FRAME);
      this.chunks[0] = this.chunks[0].subarray(FRAME);
      if (!this.chunks[0].length) this.chunks.shift();
    } else {
      out = Buffer.allocUnsafe(FRAME);
      let at = 0;
      while (at < FRAME) {
        const c = this.chunks[0];
        const n = Math.min(c.length, FRAME - at);
        c.copy(out, at, 0, n);
        at += n;
        if (n === c.length) this.chunks.shift();
        else this.chunks[0] = c.subarray(n);
      }
    }
    this.size -= FRAME;
    if (this.size < AHEAD / 2 && this.proc.stdout.isPaused()) this.proc.stdout.resume();
    this.frames++;
    return out;
  }
  kill() {
    this.killed = true;
    this.ended = true;
    this.chunks = [];
    this.size = 0;
    try { this.proc.kill("SIGKILL"); } catch {}
  }
}

// ---------- the mix: music + ambience + sound effects, 20 ms at a time ----------
const st = {
  volumes: { master: 0.9, music: 0.7, ambience: 0.5, sfx: 0.9 },
  queue: [], // { id, title, artist, duration, file }
  index: -1,
  paused: false,
  loop: "off", // off | all | one
  shuffle: false,
  history: [],
  music: null, // Source
  ambience: new Map(), // id -> Source
  sfx: new Set(), // Source
};
const acc = new Float32Array(FRAME_SAMPLES * 2);
const pcm = Buffer.alloc(FRAME);
const KNEE = 24000;
const ROOM = 32767 - KNEE;
let idleSince = Date.now();

function mixInto(src, layer) {
  const buf = src.take();
  if (!buf) return false;
  const target = src.stopping ? 0 : src.gain;
  const from = src.level;
  let to = target;
  if (from !== target) to = from < target ? Math.min(target, from + src.step) : Math.max(target, from - src.step);
  src.level = to;
  const n = buf.length >> 1;
  const d = (to - from) / n; // the volume glides across the 20 ms, so changes don't click
  let g = from;
  for (let i = 0; i < n; i++, g += d) acc[i] += buf.readInt16LE(i << 1) * g * layer;
  if (src.stopping && to === 0) src.kill();
  return true;
}

function nextFrame() {
  acc.fill(0);
  let sound = false;
  const v = st.volumes;
  // the music: the song ends -> the next one in the queue
  if (st.music && !st.paused) {
    if (mixInto(st.music, v.music)) sound = true;
    else if (st.music.finished) {
      const was = st.music;
      st.music = null;
      if (!was.killed) advance(+1, true);
    }
  } else if (st.music && st.paused && st.music.stopping) {
    if (mixInto(st.music, v.music)) sound = true;
  }
  for (const [id, a] of st.ambience) {
    if (mixInto(a, v.ambience)) sound = true;
    else if (a.finished) st.ambience.delete(id);
  }
  for (const s of st.sfx) {
    if (mixInto(s, v.sfx)) sound = true;
    else if (s.finished) st.sfx.delete(s);
  }
  // a soft limiter: music + rain + a sword hit at once would go past what 16 bits hold and crackle;
  // above 24000 the peaks are rounded off instead
  const m = v.master;
  for (let i = 0; i < acc.length; i++) {
    let x = acc[i] * m;
    const ax = x < 0 ? -x : x;
    if (ax > KNEE) {
      const y = KNEE + ROOM * Math.tanh((ax - KNEE) / ROOM);
      x = x < 0 ? -y : y;
    }
    pcm.writeInt16LE(Math.round(x), i << 1);
  }
  if (sound) idleSince = 0;
  else if (!idleSince) idleSince = Date.now();
  return pcm;
}

// nothing has played for a second (and nothing is about to): Discord can stop listening for us
const busy = () => (st.music && !st.paused) || st.ambience.size > 0 || st.sfx.size > 0;
const idle = () => !busy() && idleSince && Date.now() - idleSince > 1000;

// ---------- the music queue ----------
// again: the same song once more (a seek, a restart, loop one) - not a new song for anyone
function startSong(i, from = 0, again = false) {
  if (st.music) st.music.kill();
  st.music = null;
  st.index = i;
  const item = st.queue[i];
  if (!item) { st.index = -1; changed(); return; }
  st.music = new Source(item, { from, gain: 1, fadeMs: from ? 300 : 0 });
  st.paused = false;
  wake();
  changed();
  if (!again) send({ type: "song", item: view(item) }); // (3.17.1) Hermes Music may post its music video's link
}

function advance(dir, ended = false) {
  if (!st.queue.length) return startSong(-1);
  if (ended && st.loop === "one") return startSong(st.index, 0, true);
  let i;
  if (dir > 0 && st.shuffle && st.queue.length > 1) {
    const left = st.queue.map((_, n) => n).filter((n) => n !== st.index && !st.history.includes(n));
    const pool = left.length ? left : st.queue.map((_, n) => n).filter((n) => n !== st.index);
    if (!left.length && st.loop !== "all" && ended) return startSong(-1);
    if (!left.length) st.history = [];
    i = pool[Math.floor(Math.random() * pool.length)];
  } else if (dir < 0 && st.shuffle && st.history.length) {
    i = st.history.pop();
    st.music?.kill();
    st.music = null;
    return startSong(i);
  } else {
    i = st.index + dir;
    if (i >= st.queue.length) {
      if (st.loop !== "all") { // the end of the queue
        if (st.music) st.music.kill();
        st.music = null;
        st.index = -1;
        changed();
        return;
      }
      i = 0;
    }
    if (i < 0) i = 0;
  }
  if (dir > 0 && st.index >= 0) st.history = [...st.history, st.index].slice(-200);
  startSong(i);
}

const view = (it) => it && { id: it.id, title: it.title, artist: it.artist || "", duration: it.duration || 0 };

// ---------- Discord (or the pretend one) ----------
let client = null;
let voice = null; // { guildId, channelId, connection?, status }
let player = null;
let aloneSince = 0;
let fakeTimer = null;
let fakeOut = null;
let user = null;
let online = false;
let error = "";
let voiceLib = null;

// ---------- (3.17) ears ----------
const ears = { on: false, cfg: null, proc: null, ready: false, seq: 0, waiting: new Map(), buf: "", streams: new Map(), restarts: 0, watched: new WeakSet() };
const replies = new Map(); // typed commands waiting for their answer: reply id -> { interaction | message, at }
const fakePosts = []; // the pretend bot: what it wrote into the voice channel's chat

function earsLine(line) {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.ready) { ears.ready = true; ears.restarts = 0; log('listening for "Hey Sour Box"'); changed(); return; }
  const w = ears.waiting.get(m.id);
  if (w) { ears.waiting.delete(m.id); w(m); }
}
function earsStart() {
  if (FAKE || ears.proc || !ears.cfg || !ears.on) return; // the pretend bot has no helper
  const { python, script, model } = ears.cfg;
  let p;
  try { p = spawn(python, [script, model], { stdio: ["pipe", "pipe", "inherit"] }); } catch (e) { log("ears: " + e.message); return; }
  ears.proc = p;
  ears.ready = false;
  ears.buf = "";
  p.stdout.on("data", (d) => {
    ears.buf += d;
    let i;
    while ((i = ears.buf.indexOf("\n")) >= 0) { const line = ears.buf.slice(0, i); ears.buf = ears.buf.slice(i + 1); earsLine(line); }
  });
  p.stdin.on("error", () => {});
  p.on("error", (e) => log("ears: " + e.message));
  p.on("exit", () => {
    if (ears.proc !== p) return;
    ears.proc = null;
    ears.ready = false;
    for (const w of ears.waiting.values()) w(null);
    ears.waiting.clear();
    changed();
    if (ears.on && ears.restarts++ < 5) setTimeout(earsStart, 5000);
  });
  if (ears.cfg.words && ears.cfg.words.length) p.stdin.write(JSON.stringify({ grammar: ears.cfg.words }) + "\n");
}
function earsStop() {
  const p = ears.proc;
  ears.proc = null;
  ears.ready = false;
  if (p) { try { p.kill(); } catch {} }
  for (const s of ears.streams.values()) { try { s.destroy(); } catch {} }
  ears.streams.clear();
}
// one thing someone said (16 kHz mono PCM) -> { wake, text } from the helper (null when it isn't there)
function earsHear(pcm, force = false) {
  if (!ears.proc || !ears.ready) return Promise.resolve(null);
  const id = ++ears.seq;
  return new Promise((ok) => {
    const t = setTimeout(() => { ears.waiting.delete(id); ok(null); }, 20000);
    ears.waiting.set(id, (m) => { clearTimeout(t); ok(m); });
    try {
      ears.proc.stdin.write(JSON.stringify({ id, bytes: pcm.length, force: !!force }) + "\n");
      ears.proc.stdin.write(pcm);
    } catch { ears.waiting.delete(id); clearTimeout(t); ok(null); }
  });
}
// Discord's Opus packets -> 48 kHz mono PCM
function opusDecoder() {
  try {
    const { OpusEncoder } = need("@discordjs/opus");
    const d = new OpusEncoder(RATE, 1);
    return (packet) => d.decode(packet);
  } catch {}
  const OpusScript = need("opusscript");
  const d = new OpusScript(RATE, 1, OpusScript.Application.VOIP);
  return (packet) => Buffer.from(d.decode(packet));
}
// 48 kHz -> 16 kHz (what the recognizer takes): every three samples become one
function to16k(pcm) {
  const n = Math.floor(pcm.length / 6);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round((pcm.readInt16LE(i * 6) + pcm.readInt16LE(i * 6 + 2) + pcm.readInt16LE(i * 6 + 4)) / 3), i * 2);
  return out;
}
const EAR_MIN = 16000 * 2 * 0.4; // shorter than 0.4 s: a cough, not a sentence
const EAR_MAX = 16000 * 2 * 12; // nobody's command is longer than 12 s
async function earsSaid(who, pcm) {
  // after "Hey Sour Box" on its own (a chime answered), the next thing that person says is the command
  const armed = ears.armed && ears.armed.id === who.id && Date.now() < ears.armed.until;
  if (armed) ears.armed = null;
  const heard = await earsHear(pcm, armed);
  if (!heard || !heard.wake || !ears.on) return;
  // "Sour Box" was heard by the first pass (or answered with the chime a moment ago): this is for the bot,
  // also when the second pass lost those words. Its other readings go along (3.17.1).
  const mark = (t) => (/sour box/.test(t) ? t : "sour box " + t);
  const text = mark(String(heard.text || ""));
  const alts = (Array.isArray(heard.alts) ? heard.alts : []).map((t) => mark(String(t || ""))).filter((t) => t !== text).slice(0, 10);
  send({ type: "heard", user: who, text, alts });
}
// each person in the channel, one sentence at a time (a new one starts when they speak again)
function earsWatch(connection, guildId) {
  if (ears.watched.has(connection)) return;
  ears.watched.add(connection);
  const { EndBehaviorType } = voiceLib;
  connection.receiver.speaking.on("start", (userId) => {
    if (!ears.on || !ears.ready || ears.streams.has(userId)) return;
    const member = client && client.guilds.cache.get(guildId) ? client.guilds.cache.get(guildId).members.cache.get(userId) : null;
    if (member && member.user.bot) return;
    let decode;
    try { decode = opusDecoder(); } catch (e) { log("ears: " + e.message); return; }
    const parts = [];
    let size = 0, done = false;
    const stream = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 700 } });
    ears.streams.set(userId, stream);
    const finish = () => {
      if (done) return;
      done = true;
      ears.streams.delete(userId);
      try { stream.destroy(); } catch {}
      if (size >= EAR_MIN) earsSaid({ id: userId, name: member ? member.displayName : "Someone" }, Buffer.concat(parts)).catch(() => {});
    };
    stream.on("data", (packet) => {
      try { const pcm = to16k(decode(packet)); parts.push(pcm); size += pcm.length; } catch { return; }
      if (size > EAR_MAX) finish();
    });
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", finish);
  });
}
// deafened while the ears are off (Discord shows it), undeafened while they listen
function earsApply() {
  if (ears.on) earsStart(); else earsStop();
  if (!FAKE && voice && voice.connection) {
    try { voice.connection.rejoin({ channelId: voice.channelId, selfDeaf: !ears.on, selfMute: false }); } catch {}
    if (ears.on) earsWatch(voice.connection, voice.guildId);
  }
  if (!FAKE && client && client.user) {
    try {
      const { ActivityType } = need("discord.js");
      client.user.setPresence({ activities: ears.on ? [{ name: 'Hey Sour Box', type: ActivityType.Listening }] : [] }); // shows as: Listening to Hey Sour Box
    } catch {}
  }
  changed();
}
// a short two-note chime (made here, once): "I heard you"
function chimeFile() {
  const file = path.join(DATA, "sour-box-chime.wav");
  if (fs.existsSync(file)) return file;
  const n = Math.floor(RATE * 0.34), pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / RATE, second = t >= 0.15, u = second ? t - 0.15 : t;
    pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * (second ? 1318.5 : 880) * t) * Math.min(1, u / 0.008) * Math.exp(-u * 9) * 9000), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + pcm.length, 4); head.write("WAVEfmt ", 8); head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(RATE, 24); head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write("data", 36); head.writeUInt32LE(pcm.length, 40);
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(file, Buffer.concat([head, pcm]));
  return file;
}
// typed commands: /sourbox, or a message that mentions the bot
function typedCommand(user, text, target) {
  const reply = "r" + (++ears.seq);
  replies.set(reply, { ...target, at: Date.now() });
  for (const [k, v] of replies) if (Date.now() - v.at > 10 * 60 * 1000) replies.delete(k);
  send({ type: "heard", user, text: "sour box " + String(text || "").trim(), typed: true, reply });
}

const FAKE_GUILDS = [{
  id: "g1", name: "Test server", channels: [
    { id: "c1", name: "Tavern", members: [{ id: "u1", name: "Owen", avatar: "" }, { id: "u2", name: "Gavin", avatar: "" }] },
    { id: "c2", name: "Dungeon", members: [] },
  ],
}];

function guildsView() {
  if (FAKE) return FAKE_GUILDS.map((g) => ({ ...g, channels: g.channels.map((c) => ({ ...c, canJoin: true })) }));
  if (!client || !online) return [];
  const { ChannelType, PermissionsBitField } = need("discord.js");
  const want = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak];
  return [...client.guilds.cache.values()].map((g) => ({
    id: g.id,
    name: g.name,
    channels: [...g.channels.cache.values()]
      .filter((c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice)
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((c) => ({
        id: c.id,
        name: c.name,
        canJoin: !!(g.members.me && c.permissionsFor(g.members.me)?.has(want)),
        members: [...c.members.values()].filter((m) => m.id !== client.user.id).map((m) => ({
          id: m.id, name: m.displayName, avatar: m.user.displayAvatarURL({ size: 64 }), bot: m.user.bot,
        })),
      })),
  }));
}

function state() {
  const guilds = guildsView();
  const g = voice && guilds.find((x) => x.id === voice.guildId);
  const c = g && g.channels.find((x) => x.id === voice.channelId);
  return {
    fake: FAKE,
    online,
    error,
    user,
    guilds,
    voice: voice && { guildId: voice.guildId, guildName: g ? g.name : "", channelId: voice.channelId, channelName: c ? c.name : "", status: voice.status, members: c ? c.members : [] },
    music: {
      current: st.index >= 0 ? view(st.queue[st.index]) : null,
      index: st.index,
      position: st.music ? Math.round(st.music.position * 10) / 10 : 0,
      paused: st.paused || !st.music,
      loop: st.loop,
      shuffle: st.shuffle,
      queue: st.queue.map(view),
    },
    ears: { on: ears.on, ready: FAKE ? ears.on : ears.ready },
    ...(FAKE ? { posts: fakePosts.slice(-20) } : {}),
    ambience: [...st.ambience.values()].filter((a) => !a.stopping).map((a) => ({ ...view(a.item), volume: a.gain })),
    sfx: [...st.sfx].filter((s) => !s.stopping).map((s) => view(s.item)),
    volumes: st.volumes,
  };
}

let pushTimer = null;
function changed() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => { pushTimer = null; send({ type: "state", state: state() }); }, 120);
}
setInterval(() => { if (st.music && !st.paused) changed(); }, 1000); // the song's position

// something is about to play: make sure audio is flowing
function wake() {
  if (FAKE) return startFakeSink();
  if (player && voice && voice.status === "ready") player.unpause();
}

// Opus packets for Discord, 20 ms each, made as Discord asks for them (so a sound effect starts right away)
class MixStream extends Readable {
  constructor(encoder) {
    super({ highWaterMark: 2, objectMode: true });
    this.encoder = encoder;
  }
  _read() {
    const frame = nextFrame();
    this.push(this.encoder(frame));
    if (idle() && player) setImmediate(() => { if (idle()) player.pause(true); });
  }
}

function opusEncoder() {
  try {
    const { OpusEncoder } = need("@discordjs/opus");
    const e = new OpusEncoder(RATE, 2);
    e.setBitrate(128000);
    return (pcmFrame) => e.encode(pcmFrame);
  } catch {}
  const OpusScript = need("opusscript");
  const e = new OpusScript(RATE, 2, OpusScript.Application.AUDIO);
  try { e.setBitrate(128000); } catch {}
  return (pcmFrame) => e.encode(pcmFrame, FRAME_SAMPLES);
}

async function login(token) {
  if (FAKE) {
    online = true;
    user = { id: "bot", name: "Sour Bot (test)", avatar: "" };
    changed();
    return { online: true };
  }
  const { Client, GatewayIntentBits, Events } = need("discord.js");
  voiceLib = need("@discordjs/voice");
  // (3.17) GuildMessages: messages that mention the bot (their text comes without the privileged intent)
  client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages] });
  client.once(Events.ClientReady, (c) => {
    online = true;
    error = "";
    user = { id: c.user.id, name: c.user.username, avatar: c.user.displayAvatarURL({ size: 64 }) };
    log(`online as ${c.user.tag} in ${c.guilds.cache.size} server(s)`);
    changed();
    // /sourbox in every server (needs the bot to have been invited with slash commands; fine without)
    const slash = { name: "sourbox", description: "Tell Sour Box what to do: play <song>, pause, resume, skip, stop",
      options: [{ name: "do", description: "play <song>, pause, resume, skip, stop", type: 3, required: true }] };
    for (const g of c.guilds.cache.values()) g.commands.create(slash).catch(() => {});
    if (ears.on) earsApply();
  });
  client.on(Events.GuildCreate, (g) => { g.commands.create({ name: "sourbox", description: "Tell Sour Box what to do: play <song>, pause, resume, skip, stop",
    options: [{ name: "do", description: "play <song>, pause, resume, skip, stop", type: 3, required: true }] }).catch(() => {}); });
  client.on(Events.InteractionCreate, (i) => {
    if (!i.isChatInputCommand || !i.isChatInputCommand() || i.commandName !== "sourbox") return;
    i.deferReply().then(() => typedCommand({ id: i.user.id, name: (i.member && i.member.displayName) || i.user.username }, i.options.getString("do"), { interaction: i })).catch(() => {});
  });
  client.on(Events.MessageCreate, (m) => {
    if (!client.user || m.author.bot || !m.mentions.users.has(client.user.id)) return;
    const text = String(m.content || "").replace(/<@!?\d+>/g, " ").trim();
    if (text) typedCommand({ id: m.author.id, name: (m.member && m.member.displayName) || m.author.username }, text, { message: m });
  });
  for (const ev of [Events.VoiceStateUpdate, Events.GuildCreate, Events.GuildDelete, Events.ChannelCreate, Events.ChannelDelete, Events.ChannelUpdate]) {
    client.on(ev, () => { checkAlone(); changed(); });
  }
  client.on(Events.ShardDisconnect, () => { online = false; changed(); });
  client.on(Events.ShardResume, () => { online = true; changed(); });
  client.on(Events.Error, (e) => { error = e.message; changed(); });
  try {
    await client.login(token);
  } catch (e) {
    online = false;
    error = /token/i.test(e.message) ? "Discord didn't accept the bot token (copy it again from the Discord developer page)" : e.message;
    changed();
    throw new Error(error);
  }
  return { online: true };
}

// a voice channel nobody's in (except bots): leave after a while
function checkAlone() {
  if (!voice || FAKE || !client) return;
  const g = client.guilds.cache.get(voice.guildId);
  const c = g && g.channels.cache.get(voice.channelId);
  const people = c ? [...c.members.values()].filter((m) => !m.user.bot).length : 0;
  if (people) aloneSince = 0;
  else if (!aloneSince) aloneSince = Date.now();
}
setInterval(() => {
  checkAlone();
  if (voice && aloneSince && Date.now() - aloneSince > ALONE_MS) { log("left the voice channel: nobody was in it"); leave(); }
}, 30000);

async function join({ guildId, channelId }) {
  if (FAKE) {
    const g = FAKE_GUILDS.find((x) => x.id === guildId);
    if (!g || !g.channels.some((c) => c.id === channelId)) throw new Error("no such voice channel");
    voice = { guildId, channelId, status: "ready" };
    changed();
    if (busy()) startFakeSink();
    return state().voice;
  }
  if (!client || !online) throw new Error("the bot isn't connected to Discord yet");
  const guild = client.guilds.cache.get(String(guildId));
  const channel = guild && guild.channels.cache.get(String(channelId));
  if (!channel || !channel.isVoiceBased()) throw new Error("that voice channel is gone");
  const { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, NoSubscriberBehavior, StreamType, VoiceConnectionStatus } = voiceLib;
  // another channel on the same server: move there, the music keeps going
  if (voice && voice.guildId === guild.id && voice.connection) {
    if (voice.channelId === channel.id) return state().voice;
    voice.channelId = channel.id;
    aloneSince = 0;
    voice.connection.rejoin({ channelId: channel.id, selfDeaf: !ears.on, selfMute: false });
    changed();
    return state().voice;
  }
  if (voice) leave();
  voice = { guildId: guild.id, channelId: channel.id, status: "connecting" };
  aloneSince = 0;
  changed();
  const connection = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: !ears.on });
  voice.connection = connection;
  if (ears.on) earsWatch(connection, guild.id);
  connection.on("stateChange", (_, next) => {
    if (!voice || voice.connection !== connection) return;
    if (next.status === VoiceConnectionStatus.Ready) { voice.status = "ready"; if (busy()) player?.unpause(); }
    if (next.status === VoiceConnectionStatus.Destroyed) { voice = null; stopAll(true); } // kicked out of the channel
    changed();
  });
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try { // moved to another channel, or a short network blip: it reconnects by itself
      await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5000), entersState(connection, VoiceConnectionStatus.Connecting, 5000)]);
    } catch {
      if (voice && voice.connection === connection) { connection.destroy(); voice = null; changed(); }
    }
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
  } catch {
    connection.destroy();
    voice = null;
    changed();
    throw new Error("couldn't connect to the voice channel (does the bot have Connect and Speak there?)");
  }
  if (!player) {
    player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 250 } });
    player.on("error", (e) => log("audio error: " + e.message));
    player.play(createAudioResource(new MixStream(opusEncoder()), { inputType: StreamType.Opus }));
  }
  connection.subscribe(player);
  voice.status = "ready";
  if (busy()) player.unpause();
  else player.pause(true);
  changed();
  return state().voice;
}

function leave() {
  if (voice && voice.connection) { try { voice.connection.destroy(); } catch {} }
  voice = null;
  stopAll(true);
  stopFakeSink();
  changed();
}

// ---------- the pretend voice channel: the mix goes into fake-voice.wav at real speed ----------
function startFakeSink() {
  if (!FAKE || !voice || fakeTimer) return;
  fs.mkdirSync(DATA, { recursive: true });
  const file = path.join(DATA, "fake-voice.wav");
  fakeOut = { fd: fs.openSync(file, "w"), bytes: 0, peaks: [] };
  fs.writeSync(fakeOut.fd, Buffer.alloc(44));
  let due = Date.now();
  fakeTimer = setInterval(() => {
    while (Date.now() >= due) {
      const frame = nextFrame();
      if (fakeOut.bytes < RATE * 4 * 60 * 10) { fs.writeSync(fakeOut.fd, frame); fakeOut.bytes += frame.length; }
      let peak = 0;
      for (let i = 0; i < frame.length; i += 2) peak = Math.max(peak, Math.abs(frame.readInt16LE(i)));
      fakeOut.peaks.push(peak);
      due += 20;
    }
  }, 10);
}
function stopFakeSink() {
  if (!fakeTimer) return;
  clearInterval(fakeTimer);
  fakeTimer = null;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + fakeOut.bytes, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(fakeOut.bytes, 40);
  fs.writeSync(fakeOut.fd, h, 0, 44, 0);
  fs.closeSync(fakeOut.fd);
  fakeOut = null;
}

// ---------- what Hermes Music (the Discord Bot tab) asks for ----------
function stopAll(now = false) {
  if (st.music) { if (now) st.music.kill(); else { st.music.stopping = true; st.music.step = 1 / 25; } }
  st.paused = true;
  for (const a of st.ambience.values()) { if (now) a.kill(); else { a.stopping = true; a.step = 1 / 50; } }
  if (now) st.ambience.clear();
  for (const s of st.sfx) { if (now) s.kill(); else { s.stopping = true; s.step = 1 / 10; } }
  if (now) st.sfx.clear();
  changed();
}

const ready = () => { if (!voice) throw new Error("make the bot join a voice channel first"); };
const items = (list) => (Array.isArray(list) ? list : []).filter((x) => x && x.file && fs.existsSync(x.file));

const commands = {
  login: ({ token }) => login(String(token || "")),
  state: () => state(),
  join,
  leave: () => { leave(); return null; },
  // the queue: play these now (from `start`), or add them after the current song / at the end
  play: ({ items: list, start = 0 }) => {
    const q = items(list);
    if (!q.length) throw new Error("nothing to play");
    st.queue = q;
    st.history = [];
    startSong(clamp(start, 0, q.length - 1));
    return null;
  },
  enqueue: ({ items: list, next }) => {
    const q = items(list);
    if (!q.length) throw new Error("nothing to add");
    if (next && st.index >= 0) st.queue.splice(st.index + 1, 0, ...q);
    else st.queue.push(...q);
    if (st.index < 0) startSong(st.queue.length - q.length);
    changed();
    return null;
  },
  remove: ({ index }) => {
    const i = Number(index);
    if (!(i >= 0 && i < st.queue.length)) return null;
    st.queue.splice(i, 1);
    st.history = [];
    if (i === st.index) { st.index--; advance(+1); }
    else if (i < st.index) st.index--;
    changed();
    return null;
  },
  move: ({ from, to }) => {
    const f = Number(from), t = clamp(to, 0, st.queue.length - 1);
    if (!(f >= 0 && f < st.queue.length) || f === t) return null;
    const cur = st.queue[st.index];
    const [it] = st.queue.splice(f, 1);
    st.queue.splice(t, 0, it);
    st.index = st.queue.indexOf(cur);
    st.history = [];
    changed();
    return null;
  },
  clear: () => {
    const cur = st.queue[st.index];
    st.queue = cur ? [cur] : [];
    st.index = cur ? 0 : -1;
    st.history = [];
    changed();
    return null;
  },
  jump: ({ index }) => { startSong(clamp(index, 0, st.queue.length - 1)); return null; },
  pause: () => { st.paused = true; changed(); return null; },
  resume: () => {
    if (!st.music && st.queue.length) startSong(st.index >= 0 ? st.index : 0);
    st.paused = false;
    wake();
    changed();
    return null;
  },
  skip: () => { advance(+1); return null; },
  previous: () => {
    if (st.music && st.music.position > 3) startSong(st.index, 0, true);
    else advance(-1);
    return null;
  },
  seek: ({ seconds }) => { if (st.index >= 0) startSong(st.index, clamp(seconds, 0, 24 * 3600), true); return null; },
  stopMusic: () => {
    if (st.music) { st.music.stopping = true; st.music.step = 1 / 15; const m = st.music; setTimeout(() => m.kill(), 600); }
    st.music = null;
    st.paused = true;
    changed();
    return null;
  },
  loop: ({ mode }) => { st.loop = ["off", "all", "one"].includes(mode) ? mode : "off"; changed(); return null; },
  shuffle: ({ on }) => { st.shuffle = !!on; st.history = []; changed(); return null; },
  // ambience: any number of loops at once, each with its own volume, fading in and out
  ambience: ({ item, on, volume }) => {
    const [it] = items([item]);
    if (!it) throw new Error("that sound is gone");
    const have = st.ambience.get(it.id);
    if (on === false) {
      if (have) { have.stopping = true; have.step = 1 / 75; }
    } else if (have && !have.stopping) {
      if (volume != null) have.gain = clamp(volume, 0, 1.5);
    } else {
      if (have) have.kill();
      st.ambience.set(it.id, new Source(it, { loop: true, gain: volume != null ? clamp(volume, 0, 1.5) : 0.8, fadeMs: 2000 }));
      wake();
    }
    changed();
    return null;
  },
  ambienceOff: () => { for (const a of st.ambience.values()) { a.stopping = true; a.step = 1 / 75; } changed(); return null; },
  // sound effects: played once, on top of everything
  sfx: ({ item, volume }) => {
    const [it] = items([item]);
    if (!it) throw new Error("that sound is gone");
    if (st.sfx.size >= 8) { const oldest = st.sfx.values().next().value; oldest.kill(); st.sfx.delete(oldest); }
    st.sfx.add(new Source(it, { gain: volume != null ? clamp(volume, 0, 1.5) : 1 }));
    wake();
    changed();
    return null;
  },
  stopSfx: () => { for (const s of st.sfx) { s.stopping = true; s.step = 1 / 5; } changed(); return null; },
  volume: ({ layer, value }) => {
    if (!(layer in st.volumes)) throw new Error("no such volume");
    st.volumes[layer] = clamp(value, 0, 1.5);
    changed();
    return null;
  },
  stopAll: () => { stopAll(false); return null; },
  // what the pretend voice channel heard: the loudest moment of each second
  fakeLevels: () => {
    if (!FAKE) return null;
    const p = fakeOut ? fakeOut.peaks : [];
    const out = [];
    for (let i = 0; i < p.length; i += 50) out.push(Math.max(...p.slice(i, i + 50)));
    return out;
  },
  // (3.17) the ears: on or off, and where the helper and its word list are
  ears: ({ on, python, script, model, words }) => {
    const cfg = on && python && script && model ? { python, script, model, words: Array.isArray(words) ? words : [] } : null;
    const sameHelper = cfg && ears.cfg && cfg.python === ears.cfg.python && cfg.script === ears.cfg.script && cfg.model === ears.cfg.model;
    const was = ears.on;
    ears.on = !!on && (FAKE || !!cfg);
    if (ears.on && sameHelper && ears.proc) { // only the words changed (the library grew)
      ears.cfg = cfg;
      try { ears.proc.stdin.write(JSON.stringify({ grammar: cfg.words }) + "\n"); } catch {}
    } else {
      if (ears.proc) earsStop();
      ears.cfg = cfg;
      ears.restarts = 0;
    }
    if (was !== ears.on || !sameHelper) earsApply();
    return { on: ears.on };
  },
  // an answer: into the chat of the voice channel (or wherever the typed command came from)
  say: async ({ text, reply }) => {
    const msg = String(text || "").slice(0, 400);
    if (!msg) return null;
    const to = reply && replies.get(reply);
    if (to) {
      replies.delete(reply);
      try { if (to.interaction) await to.interaction.editReply(msg); else await to.message.reply({ content: msg, allowedMentions: { repliedUser: false } }); } catch {}
      return null;
    }
    if (FAKE || !client || !voice) return null;
    try {
      const g = client.guilds.cache.get(voice.guildId);
      const c = g && g.channels.cache.get(voice.channelId);
      if (c && c.isTextBased && c.isTextBased()) await c.send({ content: msg, allowedMentions: { parse: [] } });
    } catch {}
    return null;
  },
  // (3.17.1) a message into the chat of the voice channel the bot is in (a song's music video link)
  post: async ({ text }) => {
    const msg = String(text || "").slice(0, 800);
    if (!msg || !voice) return { sent: false };
    if (FAKE) { fakePosts.push(msg); if (fakePosts.length > 40) fakePosts.shift(); changed(); return { sent: true }; }
    if (!client) return { sent: false };
    const g = client.guilds.cache.get(voice.guildId);
    const c = g && g.channels.cache.get(voice.channelId);
    if (!c || !c.isTextBased || !c.isTextBased()) throw new Error("that voice channel has no chat to write in");
    try { await c.send({ content: msg, allowedMentions: { parse: [] } }); }
    catch (e) { throw new Error(/permission|access/i.test(String(e && e.message)) ? `the bot may not write in the chat of ${c.name}: give it Send Messages and Embed Links there` : String((e && e.message) || e)); }
    return { sent: true };
  },
  chime: ({ arm }) => {
    if (arm) ears.armed = { id: String(arm), until: Date.now() + 9000 };
    if (!voice) return null;
    try {
      st.sfx.add(new Source({ id: "sour-box-chime", title: "chime", file: chimeFile() }, { gain: 0.5 }));
      wake();
    } catch {}
    return null;
  },
  // tests: as if someone in the voice channel had said this (no speech recognition involved)
  hear: ({ text, name, alts }) => {
    if (!ears.on) throw new Error("the ears are off");
    send({ type: "heard", user: { id: "test", name: String(name || "Tester") }, text: String(text || ""), alts: Array.isArray(alts) ? alts.map(String) : [] });
    return null;
  },
  // tests (on a machine with the real helper): a sound file through the same path Discord's voices take,
  // Opus packets -> 16 kHz -> the helper. Answers what it understood.
  eartest: async ({ file }) => {
    if (!ears.proc || !ears.ready) throw new Error("the ears aren't ready");
    const pcm = await new Promise((ok, fail) => {
      const parts = [];
      const p = spawn(FFMPEG, ["-v", "error", "-nostdin", "-i", file, "-vn", "-f", "s16le", "-ar", String(RATE), "-ac", "1", "pipe:1"], { stdio: ["ignore", "pipe", "inherit"] });
      p.stdout.on("data", (d) => parts.push(d));
      p.on("error", fail);
      p.on("close", () => ok(Buffer.concat(parts)));
    });
    // into 20 ms Opus packets and back, like a voice in the channel
    const OpusScript = need("opusscript");
    const enc = new OpusScript(RATE, 1, OpusScript.Application.VOIP);
    const decode = opusDecoder();
    const out = [];
    for (let at = 0; at + FRAME_SAMPLES * 2 <= pcm.length; at += FRAME_SAMPLES * 2) out.push(to16k(decode(Buffer.from(enc.encode(pcm.subarray(at, at + FRAME_SAMPLES * 2), FRAME_SAMPLES)))));
    const heard = await earsHear(Buffer.concat(out));
    return { seconds: Math.round((pcm.length / 2 / RATE) * 10) / 10, heard };
  },
  // which Discord libraries were found (opus, encryption, voice encryption)
  report: () => (FAKE ? "fake mode" : need("@discordjs/voice").generateDependencyReport()),
  // the sound path without a voice channel: (a file through ffmpeg ->) the mix -> Opus packets -> a
  // Discord audio resource. Silence makes 3-byte packets, sound a few hundred bytes each.
  selftest: async ({ file }) => {
    const { createAudioResource, StreamType } = need("@discordjs/voice");
    if (file) {
      st.sfx.add(new Source({ id: "selftest", title: "self test", file }));
      await new Promise((r) => setTimeout(r, 800));
    }
    const resource = createAudioResource(new MixStream(opusEncoder()), { inputType: StreamType.Opus });
    let packets = 0, bytes = 0;
    for (let i = 0; i < 100; i++) {
      const p = resource.read();
      if (p) { packets++; bytes += p.length; }
      await new Promise((r) => setTimeout(r, 2));
    }
    let encoder = "opusscript";
    try { need("@discordjs/opus"); encoder = "@discordjs/opus"; } catch {}
    return { packets, bytes, encoder };
  },
};
// these need the bot in a voice channel
for (const k of ["play", "enqueue", "jump", "resume", "seek", "ambience", "sfx"]) {
  const run = commands[k];
  commands[k] = (args) => { ready(); return run(args); };
}

process.on("message", async (m) => {
  if (!m || !m.cmd) return;
  try {
    const fn = commands[m.cmd];
    if (!fn) throw new Error("unknown command " + m.cmd);
    const result = await fn(m.args || {});
    send({ id: m.id, ok: true, result, state: state() }); // the answer carries what changed
  } catch (e) {
    send({ id: m.id, ok: false, error: e.message, state: state() });
  }
  changed();
});
process.on("disconnect", () => process.exit(0)); // Hermes Music stopped
process.on("uncaughtException", (e) => { log("crashed: " + (e.stack || e.message)); process.exit(1); });
process.on("unhandledRejection", (e) => log("error: " + (e && e.message ? e.message : e)));
changed();
