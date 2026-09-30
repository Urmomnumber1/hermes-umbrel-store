// Song request queue: public page + agent API. No dependencies (Node 22).
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
const TOKEN = process.env.AGENT_TOKEN;
const HERMES_URL = process.env.HERMES_URL; // e.g. http://hermes:8642
const HERMES_KEY = process.env.HERMES_KEY;
const DB = "/data/requests.json";
const PAGE = fs.readFileSync(path.join(__dirname, "index.html"));

let items = [];
try { items = JSON.parse(fs.readFileSync(DB, "utf8")); } catch {}
const save = () => fs.writeFileSync(DB, JSON.stringify(items.slice(-500), null, 1));
const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "content-type": type });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((ok) => {
  let b = "";
  req.on("data", (c) => { b += c; if (b.length > 5000) req.destroy(); });
  req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } });
  req.on("error", () => ok({}));
});

// Nudge Hermes to work the queue. One run at a time.
let busy = false;
async function wake() {
  if (busy || !HERMES_URL || !items.some((i) => i.status === "pending")) return;
  busy = true;
  try {
    await fetch(`${HERMES_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${HERMES_KEY}` },
      body: JSON.stringify({
        model: "hermes-agent",
        messages: [{ role: "user", content: "Process all pending song requests using the song-requests skill." }],
      }),
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
  } catch (e) { console.error("wake failed:", e.message); }
  busy = false;
}
setInterval(wake, 5 * 60 * 1000);

const rate = new Map(); // ip -> timestamps
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const agent = req.headers.authorization === `Bearer ${TOKEN}`;

  if (req.method === "GET" && url.pathname === "/") return send(res, 200, PAGE, "text/html");

  if (url.pathname === "/api/requests" && req.method === "GET") {
    const list = items.slice(-50).reverse().map(({ id, query, status, title, artist, note, created }) =>
      ({ id, query, status, title, artist, note, created }));
    return send(res, 200, list);
  }
  if (url.pathname === "/api/requests" && req.method === "POST") {
    const ip = req.socket.remoteAddress;
    const hits = (rate.get(ip) || []).filter((t) => Date.now() - t < 60000);
    if (hits.length >= 5) return send(res, 429, { error: "Slow down a little" });
    rate.set(ip, [...hits, Date.now()]);
    const { query } = await readBody(req);
    const q = String(query || "").trim().slice(0, 200);
    if (q.length < 2) return send(res, 400, { error: "Enter a song name" });
    const item = { id: Date.now().toString(36), query: q, status: "pending", created: new Date().toISOString() };
    items.push(item); save(); wake();
    return send(res, 201, item);
  }

  // ---- agent API (Bearer token) ----
  if (url.pathname.startsWith("/api/agent/")) {
    if (!agent) return send(res, 401, { error: "unauthorized" });
    if (req.method === "GET" && url.pathname === "/api/agent/pending")
      return send(res, 200, items.filter((i) => i.status === "pending"));
    const m = url.pathname.match(/^\/api\/agent\/requests\/([\w-]+)$/);
    if (m && req.method === "POST") {
      const item = items.find((i) => i.id === m[1]);
      if (!item) return send(res, 404, { error: "not found" });
      const b = await readBody(req);
      if (["pending", "working", "done", "failed"].includes(b.status)) item.status = b.status;
      for (const k of ["title", "artist", "note"]) if (b[k] != null) item[k] = String(b[k]).slice(0, 300);
      save();
      return send(res, 200, item);
    }
  }
  send(res, 404, { error: "not found" });
}).listen(PORT, () => console.log("song requests on", PORT));
