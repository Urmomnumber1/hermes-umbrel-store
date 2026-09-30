// Song request queue: public page + agent API. No dependencies (Node 22).
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
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

// Requests are picked up by the worker on the owner's PC (worker/song-worker.ps1),
// which polls /api/agent/pending. LAN-only, so the agent endpoints are not password protected.

const rate = new Map(); // ip -> timestamps
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

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
    items.push(item); save();
    return send(res, 201, item);
  }

  // ---- worker API ----
  if (url.pathname.startsWith("/api/agent/")) {
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
