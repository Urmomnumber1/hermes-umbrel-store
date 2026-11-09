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
function startSong(i, from = 0) {
  if (st.music) st.music.kill();
  st.music = null;
  st.index = i;
  const item = st.queue[i];
  if (!item) { st.index = -1; changed(); return; }
  st.music = new Source(item, { from, gain: 1, fadeMs: from ? 300 : 0 });
  st.paused = false;
  wake();
  changed();
}

function advance(dir, ended = false) {
  if (!st.queue.length) return startSong(-1);
  if (ended && st.loop === "one") return startSong(st.index);
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
  client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  client.once(Events.ClientReady, (c) => {
    online = true;
    error = "";
    user = { id: c.user.id, name: c.user.username, avatar: c.user.displayAvatarURL({ size: 64 }) };
    log(`online as ${c.user.tag} in ${c.guilds.cache.size} server(s)`);
    changed();
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
    voice.connection.rejoin({ channelId: channel.id, selfDeaf: true, selfMute: false });
    changed();
    return state().voice;
  }
  if (voice) leave();
  voice = { guildId: guild.id, channelId: channel.id, status: "connecting" };
  aloneSince = 0;
  changed();
  const connection = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true });
  voice.connection = connection;
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
    if (st.music && st.music.position > 3) startSong(st.index);
    else advance(-1);
    return null;
  },
  seek: ({ seconds }) => { if (st.index >= 0) startSong(st.index, clamp(seconds, 0, 24 * 3600)); return null; },
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
