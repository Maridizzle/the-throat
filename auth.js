// THE THROAT -- writer sign-in, sessions and presence
// Signed Maridizzle
//
// Two modes, chosen at startup from environment variables:
//   legacy  no WRITER_n_* variables: the old shared password (Basic Auth prompt).
//   writers WRITER_1_NAME / WRITER_1_PASSWORD (up to 4) plus SESSION_SECRET:
//           sign-in page, signed cookie session, per-writer identity.
// In writers mode the shared APP_PASSWORD, if set, stays as an emergency way in:
// sign in with the reserved name "shared", or send it as Basic Auth from a tool.

const crypto = require("crypto");

const COLORS = ["#B9A6D6", "#C48CB8", "#8A8FE0", "#A073DA"]; // inside the violet range
const SHARED = { id: "shared", name: "Shared access", color: "#9A8FB5" };
const COOKIE = "throat_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PRESENCE_TTL_MS = 25 * 1000;
const MAX_ATTEMPTS = 10, ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MIN_PASSWORD = 10, MIN_SECRET = 24, MAX_WRITERS = 4;
const ID_RE = /^[0-9A-Za-z_\-]{1,64}$/;
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Reachable without signing in: just what the sign-in page itself needs.
const OPEN_PATHS = new Set(["/login.html", "/css/throat.css", "/js/login.js", "/api/login", "/api/logout"]);

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const pub = (w) => ({ id: w.id, name: w.name, color: w.color });

function loadWriters(env) {
  const writers = [], seen = new Set();
  for (let i = 1; i <= MAX_WRITERS; i++) {
    const name = String(env["WRITER_" + i + "_NAME"] || "").trim();
    const password = String(env["WRITER_" + i + "_PASSWORD"] || "");
    if (!name && !password) continue;
    if (!name) throw new Error("WRITER_" + i + "_PASSWORD is set but WRITER_" + i + "_NAME is missing.");
    if (!password) throw new Error("WRITER_" + i + "_NAME is set but WRITER_" + i + "_PASSWORD is missing.");
    if (name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("WRITER_" + i + "_NAME must be 1 to 40 characters with no control characters.");
    if (name.toLowerCase() === "shared") throw new Error("WRITER_" + i + "_NAME cannot be \"shared\" (reserved for the emergency password).");
    if (seen.has(name.toLowerCase())) throw new Error("Writer names must be unique (duplicate: " + name + ").");
    if (password.length < MIN_PASSWORD) throw new Error("WRITER_" + i + "_PASSWORD must be at least " + MIN_PASSWORD + " characters.");
    seen.add(name.toLowerCase());
    writers.push({ id: "w" + i, name, password, color: COLORS[i - 1] });
  }
  return writers;
}

function createAuth(env) {
  const writers = loadWriters(env);
  const appPassword = env.APP_PASSWORD ? String(env.APP_PASSWORD) : "";
  const mode = writers.length ? "writers" : "legacy";
  const secret = String(env.SESSION_SECRET || "");
  if (mode === "writers" && secret.length < MIN_SECRET) {
    throw new Error("Writers are configured but SESSION_SECRET is missing or shorter than " + MIN_SECRET + " characters.");
  }
  const dummy = crypto.randomBytes(16).toString("hex"); // keeps unknown-name timing close to known-name timing

  /* ---- cookies and sessions ---- */
  const parseCookies = (h) => {
    const out = {};
    for (const part of String(h || "").split(";")) {
      const i = part.indexOf("=");
      if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  };
  const mac = (body) => crypto.createHmac("sha256", secret).update(body).digest();
  const signSession = (payload) => {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return "v1." + body + "." + mac(body).toString("base64url");
  };
  function verifySession(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return null;
    const given = Buffer.from(parts[2], "base64url"), want = mac(parts[1]);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
    let p;
    try { p = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch (e) { return null; }
    return p && typeof p.w === "string" && typeof p.exp === "number" && p.exp > Date.now() ? p : null;
  }
  const identityOf = (id) => (id === "shared" ? (appPassword ? SHARED : null) : writers.find((w) => w.id === id) || null);
  function setCookie(req, res, value, maxAgeSec) {
    const https = req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
    res.append("Set-Cookie", COOKIE + "=" + value + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAgeSec + (https ? "; Secure" : ""));
  }
  function basicPassword(req) {
    const [scheme, encoded] = String(req.headers.authorization || "").split(" ");
    return scheme === "Basic" && encoded ? Buffer.from(encoded, "base64").toString("utf8").split(":").slice(1).join(":") : "";
  }

  /* ---- the gate ---- */
  function legacyGate(req, res, next) {
    if (!appPassword) {
      console.error("APP_PASSWORD env var not set, refusing all requests.");
      return res.status(503).send("Server misconfigured: APP_PASSWORD is not set.");
    }
    const given = basicPassword(req);
    if (!given || !safeEqual(given, appPassword)) {
      res.set("WWW-Authenticate", 'Basic realm="The Throat", charset="UTF-8"');
      return res.status(401).send("Authentication required.");
    }
    req.writer = SHARED;
    next();
  }
  function writersGate(req, res, next) {
    let who = null, viaCookie = false;
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const sess = token && verifySession(token);
    if (sess) { who = identityOf(sess.w); viaCookie = !!who; }
    if (!who && appPassword) {
      const given = basicPassword(req);
      if (given && safeEqual(given, appPassword)) who = SHARED;
    }
    if (who) {
      // Cookie-authenticated writes must be JSON (a plain cross-site form cannot send that).
      if (viaCookie && UNSAFE.has(req.method) && !/^application\/json/i.test(req.headers["content-type"] || "")) {
        return res.status(415).json({ error: "json_required" });
      }
      req.writer = who;
      return next();
    }
    if (OPEN_PATHS.has(req.path)) return next();
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "auth_required" });
    if (req.method === "GET" && String(req.headers.accept || "").includes("text/html")) return res.redirect(302, "/login.html");
    return res.status(401).send("Authentication required.");
  }

  /* ---- failed-attempt limiter (in memory, per address and per name) ---- */
  const attempts = new Map();
  const blocked = (key) => { const a = attempts.get(key); return !!a && a.reset > Date.now() && a.n >= MAX_ATTEMPTS; };
  function noteFail(key) {
    const now = Date.now(), a = attempts.get(key);
    if (!a || a.reset <= now) attempts.set(key, { n: 1, reset: now + ATTEMPT_WINDOW_MS }); else a.n++;
    if (attempts.size > 2000) for (const [k, v] of attempts) if (v.reset <= now) attempts.delete(k);
  }

  /* ---- presence (in memory; fine for one server instance) ---- */
  const presence = new Map();
  function presenceList() {
    const now = Date.now(), out = [];
    for (const [id, p] of presence) {
      if (now - p.seen > PRESENCE_TTL_MS) { presence.delete(id); continue; }
      const w = identityOf(id);
      if (w) out.push({ ...pub(w), focus: p.focus, editing: p.editing, idle: Math.round((now - p.seen) / 1000) });
    }
    return out;
  }

  /* ---- routes, mounted after the JSON body parser ---- */
  function mount(app) {
    app.post("/api/login", (req, res) => {
      if (mode !== "writers") return res.status(404).json({ error: "not_found" });
      const name = String((req.body && req.body.name) || "").trim().slice(0, 100);
      const password = String((req.body && req.body.password) || "").slice(0, 200);
      const nameKey = "name:" + name.toLowerCase(), ipKey = "ip:" + req.ip;
      if (blocked(ipKey) || blocked(nameKey)) return res.status(429).json({ error: "too_many_attempts" });
      const w = writers.find((x) => x.name.toLowerCase() === name.toLowerCase());
      let ident = null;
      if (w) { if (safeEqual(password, w.password)) ident = w; }
      else if (name.toLowerCase() === "shared" && appPassword && safeEqual(password, appPassword)) ident = SHARED;
      else safeEqual(password, dummy);
      if (!ident) {
        noteFail(ipKey); noteFail(nameKey);
        return res.status(401).json({ error: "bad_login" });
      }
      attempts.delete(nameKey);
      const now = Date.now();
      setCookie(req, res, signSession({ w: ident.id, iat: now, exp: now + SESSION_MS }), Math.round(SESSION_MS / 1000));
      res.json({ ok: true, writer: pub(ident) });
    });
    app.post("/api/logout", (req, res) => {
      setCookie(req, res, "", 0);
      res.json({ ok: true });
    });
    app.get("/api/me", (req, res) => res.json({ mode, writer: pub(req.writer), writers: writers.map(pub) }));
    app.get("/api/presence", (req, res) => res.json({ online: presenceList() }));
    app.post("/api/presence", (req, res) => {
      const b = req.body || {};
      const focus = typeof b.focus === "string" && ID_RE.test(b.focus) ? b.focus : null;
      presence.set(req.writer.id, { focus, editing: b.editing === true && !!focus, seen: Date.now() });
      res.json({ online: presenceList() });
    });
  }

  return { mode, writers, middleware: mode === "writers" ? writersGate : legacyGate, mount, pub };
}

module.exports = { createAuth };
