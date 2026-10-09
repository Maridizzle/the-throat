// THE THROAT -- collaborative story mindmap server
// Signed Maridizzle
//
// Per-node saves with revision checks, hide-only removal (nothing is ever
// hard-deleted), plus backups and history. Backup and restore logic is adapted
// from the memoir tool's server.js. Storage is Postgres in production and a
// local JSON file when no DATABASE_URL is set.

const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const { existsSync } = require("fs");
const { Pool } = require("pg");
const { createAuth } = require("./auth");

const app = express();
const PORT = process.env.PORT || 3002;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, ".data");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const MAX_IMAGES = Number(process.env.MAX_IMAGES_PER_NODE) || 12;
const MAX_NODE_BYTES = Number(process.env.MAX_NODE_BYTES) || 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES) || 1.5 * 1024 * 1024;
const MAX_THUMB_BYTES = 200 * 1024;
const BACKUP_PERIOD_MS = 10 * 60 * 1000;
// 0 means never prune. Pruning old snapshots deletes data, so it is opt-in.
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP) || 0;

const ID_RE = /^[0-9A-Za-z_\-]{1,64}$/;
const BACKUP_ID_RE = /^[0-9A-Za-z_\-]+$/;

// Health check sits before auth so Railway can probe it. Reveals nothing.
app.get("/api/health", (req, res) => res.json({ ok: true }));

// ── Sign-in ──────────────────────────────────────────────
// See auth.js. With no WRITER_n_* variables this is the old shared password
// (APP_PASSWORD, Basic Auth). With them it is the sign-in page and a signed
// cookie, and every write is stamped with the signed-in writer.
let authn;
try {
  authn = createAuth(process.env);
} catch (e) {
  console.error("Startup failed: " + e.message);
  process.exit(1);
}
console.log("Sign-in mode: " + authn.mode + (authn.mode === "writers" ? " (" + authn.writers.length + " writer(s))" : ""));
app.set("trust proxy", 1); // Railway's proxy sits in front, so req.ip is the real visitor
app.use(authn.middleware);
app.use(express.json({ limit: "12mb" }));
authn.mount(app);
app.use(express.static(path.join(__dirname, "public")));

// ── Validation ───────────────────────────────────────────
// Images are stored inline as JPEG data URIs. Only that shape is accepted, so a
// stored record can never point the page at a script or an outside address.
const JPEG_URI = "data:image/jpeg;base64,";
const B64_RE = /^[A-Za-z0-9+/]+=*$/;
function checkImages(images) {
  if (!Array.isArray(images)) return "images must be an array";
  if (images.length > MAX_IMAGES) return "too many images (max " + MAX_IMAGES + ")";
  const ids = new Set();
  for (const img of images) {
    if (!img || typeof img !== "object" || Array.isArray(img)) return "each image must be an object";
    if (typeof img.id !== "string" || !ID_RE.test(img.id)) return "image id is missing or invalid";
    if (ids.has(img.id)) return "duplicate image id";
    ids.add(img.id);
    for (const [key, cap] of [["src", MAX_IMAGE_BYTES], ["thumb", MAX_THUMB_BYTES]]) {
      const v = img[key];
      if (v === undefined && key === "thumb") continue;
      if (typeof v !== "string" || !v.startsWith(JPEG_URI)) return "image " + key + " must be a JPEG data URI";
      if (v.length > cap) return "image " + key + " is too large";
      if (!B64_RE.test(v.slice(JPEG_URI.length))) return "image " + key + " is not valid base64";
    }
    if (img.caption !== undefined && (typeof img.caption !== "string" || img.caption.length > 500)) return "image caption must be text of at most 500 characters";
    if (img.createdAt !== undefined && !Number.isFinite(img.createdAt)) return "image createdAt must be a number";
  }
  return null;
}
function checkNodeData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "data must be an object";
  if (data.images !== undefined) {
    const bad = checkImages(data.images);
    if (bad) return bad;
  }
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_NODE_BYTES) return "node too large";
  return null;
}
function parseBaseRev(v) {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (Number.isInteger(v) && v >= 1) return { ok: true, value: v };
  return { ok: false };
}

// ── Stores ────────────────────────────────────────────────
// Both stores expose the same interface. Rows look like
// { id, data, rev, seq, hidden, updated_at }. `rev` guards one node against
// lost updates. `seq` is a global counter so clients can ask "what changed
// since N". Write methods return { row } | { conflict: row } | { notFound }.

function makeFileStore() {
  const FILE = path.join(DATA_DIR, "state.json");
  let st = null;
  let queue = Promise.resolve();
  const run = (fn) => {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  };
  async function load() {
    if (st) return st;
    try {
      st = JSON.parse(await fs.readFile(FILE, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      st = { seq: 0, nodes: {}, meta: {} };
    }
    return st;
  }
  async function persist() {
    const tmp = FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(st), "utf8");
    await fs.rename(tmp, FILE);
  }
  // Any failure while writing drops the in-memory copy so the next call
  // reloads what is actually on disk.
  const mutate = (fn) =>
    run(async () => {
      const s = await load();
      try {
        const out = await fn(s);
        if (out && (out.row || out.done)) await persist();
        return out;
      } catch (e) {
        st = null;
        throw e;
      }
    });

  function guarded(table, key, baseRev, by, build) {
    return mutate((s) => {
      const cur = s[table][key];
      if (baseRev == null) {
        if (cur) return { conflict: cur };
      } else {
        if (!cur) return { notFound: true };
        if (cur.rev !== baseRev) return { conflict: cur };
      }
      const row = build(cur);
      row.rev = cur ? cur.rev + 1 : 1;
      row.seq = ++s.seq;
      row.updated_at = new Date().toISOString();
      row.updated_by = by || null;
      s[table][key] = row;
      return { row };
    });
  }

  return {
    async init() {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.mkdir(BACKUP_DIR, { recursive: true });
      console.log("No DATABASE_URL set, using local JSON file storage at " + FILE);
    },
    async getState(sinceSeq) {
      const s = await load();
      const since = sinceSeq || 0;
      return {
        seq: s.seq,
        nodes: Object.values(s.nodes).filter((r) => r.seq > since),
        meta: Object.values(s.meta).filter((r) => r.seq > since),
      };
    },
    putNode(id, data, baseRev, by) {
      return guarded("nodes", id, baseRev, by, (cur) => ({ id, data, hidden: cur ? cur.hidden : false }));
    },
    setHidden(id, hidden, baseRev, by) {
      return guarded("nodes", id, baseRev, by, (cur) => ({ id, data: cur.data, hidden }));
    },
    putMeta(key, data, baseRev, by) {
      return guarded("meta", key, baseRev, by, () => ({ key, data }));
    },
    async snapshot() {
      const s = await load();
      return {
        nodes: Object.values(s.nodes).map((r) => ({ id: r.id, data: r.data, hidden: r.hidden })),
        meta: Object.values(s.meta).map((r) => ({ key: r.key, data: r.data })),
      };
    },
    // Restore never removes rows. Nodes absent from the snapshot are hidden.
    replaceAll(snap, by) {
      return mutate((s) => {
        const keep = new Set(snap.nodes.map((n) => n.id));
        const stamp = new Date().toISOString();
        for (const n of snap.nodes) {
          const cur = s.nodes[n.id];
          s.nodes[n.id] = { id: n.id, data: n.data, hidden: !!n.hidden, rev: cur ? cur.rev + 1 : 1, seq: ++s.seq, updated_at: stamp, updated_by: by || null };
        }
        for (const id of Object.keys(s.nodes)) {
          if (!keep.has(id) && !s.nodes[id].hidden) {
            const cur = s.nodes[id];
            s.nodes[id] = { ...cur, hidden: true, rev: cur.rev + 1, seq: ++s.seq, updated_at: stamp, updated_by: by || null };
          }
        }
        for (const m of snap.meta || []) {
          const cur = s.meta[m.key];
          s.meta[m.key] = { key: m.key, data: m.data, rev: cur ? cur.rev + 1 : 1, seq: ++s.seq, updated_at: stamp, updated_by: by || null };
        }
        return { done: true };
      });
    },
  };
}

function makePgStore(pool) {
  const outNode = (r) => ({ id: r.id, data: r.data, rev: r.rev, seq: Number(r.seq), hidden: r.hidden, updated_at: r.updated_at, updated_by: r.updated_by || null });
  const outMeta = (r) => ({ key: r.key, data: r.data, rev: r.rev, seq: Number(r.seq), updated_at: r.updated_at, updated_by: r.updated_by || null });

  async function guardedUpsert(table, keyCol, out, key, data, baseRev, by) {
    if (baseRev == null) {
      const r = await pool.query(
        `INSERT INTO ${table} (${keyCol}, data, rev, seq, updated_by) VALUES ($1, $2, 1, nextval('throat_seq'), $3)
         ON CONFLICT (${keyCol}) DO NOTHING RETURNING *`,
        [key, data, by || null]
      );
      if (r.rows.length) return { row: out(r.rows[0]) };
      const c = await pool.query(`SELECT * FROM ${table} WHERE ${keyCol} = $1`, [key]);
      return { conflict: out(c.rows[0]) };
    }
    const r = await pool.query(
      `UPDATE ${table} SET data = $2, rev = rev + 1, seq = nextval('throat_seq'), updated_at = now(), updated_by = $4
       WHERE ${keyCol} = $1 AND rev = $3 RETURNING *`,
      [key, data, baseRev, by || null]
    );
    if (r.rows.length) return { row: out(r.rows[0]) };
    const c = await pool.query(`SELECT * FROM ${table} WHERE ${keyCol} = $1`, [key]);
    if (!c.rows.length) return { notFound: true };
    return { conflict: out(c.rows[0]) };
  }

  return {
    async init() {
      await pool.query("CREATE SEQUENCE IF NOT EXISTS throat_seq;");
      await pool.query(`
        CREATE TABLE IF NOT EXISTS throat_nodes (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          rev INTEGER NOT NULL DEFAULT 1,
          seq BIGINT NOT NULL,
          hidden BOOLEAN NOT NULL DEFAULT false,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );`);
      await pool.query("CREATE INDEX IF NOT EXISTS throat_nodes_seq_idx ON throat_nodes (seq);");
      await pool.query(`
        CREATE TABLE IF NOT EXISTS throat_meta (
          key TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          rev INTEGER NOT NULL DEFAULT 1,
          seq BIGINT NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS throat_backups (
          id BIGSERIAL PRIMARY KEY,
          data JSONB NOT NULL,
          node_count INTEGER NOT NULL,
          reason TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );`);
      await pool.query("CREATE INDEX IF NOT EXISTS throat_backups_created_idx ON throat_backups (created_at DESC);");
      // Writer attribution. Added to existing tables without touching existing rows.
      await pool.query("ALTER TABLE throat_nodes ADD COLUMN IF NOT EXISTS updated_by TEXT;");
      await pool.query("ALTER TABLE throat_meta ADD COLUMN IF NOT EXISTS updated_by TEXT;");
      await pool.query("ALTER TABLE throat_backups ADD COLUMN IF NOT EXISTS created_by TEXT;");
      console.log("DB ready.");
    },
    async getState(sinceSeq) {
      const since = sinceSeq || 0;
      const n = await pool.query("SELECT * FROM throat_nodes WHERE seq > $1 ORDER BY seq", [since]);
      const m = await pool.query("SELECT * FROM throat_meta WHERE seq > $1 ORDER BY seq", [since]);
      const top = await pool.query(
        "SELECT GREATEST((SELECT COALESCE(MAX(seq),0) FROM throat_nodes), (SELECT COALESCE(MAX(seq),0) FROM throat_meta)) AS seq"
      );
      return { seq: Number(top.rows[0].seq), nodes: n.rows.map(outNode), meta: m.rows.map(outMeta) };
    },
    putNode(id, data, baseRev, by) {
      return guardedUpsert("throat_nodes", "id", outNode, id, data, baseRev, by);
    },
    async setHidden(id, hidden, baseRev, by) {
      const r = await pool.query(
        `UPDATE throat_nodes SET hidden = $2, rev = rev + 1, seq = nextval('throat_seq'), updated_at = now(), updated_by = $4
         WHERE id = $1 AND rev = $3 RETURNING *`,
        [id, hidden, baseRev, by || null]
      );
      if (r.rows.length) return { row: outNode(r.rows[0]) };
      const c = await pool.query("SELECT * FROM throat_nodes WHERE id = $1", [id]);
      if (!c.rows.length) return { notFound: true };
      return { conflict: outNode(c.rows[0]) };
    },
    putMeta(key, data, baseRev, by) {
      return guardedUpsert("throat_meta", "key", outMeta, key, data, baseRev, by);
    },
    async snapshot() {
      const n = await pool.query("SELECT id, data, hidden FROM throat_nodes ORDER BY id");
      const m = await pool.query("SELECT key, data FROM throat_meta ORDER BY key");
      return { nodes: n.rows, meta: m.rows };
    },
    async replaceAll(snap, by) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const keep = snap.nodes.map((n) => n.id);
        for (const n of snap.nodes) {
          await client.query(
            `INSERT INTO throat_nodes (id, data, hidden, rev, seq, updated_by) VALUES ($1, $2, $3, 1, nextval('throat_seq'), $4)
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, hidden = EXCLUDED.hidden,
               rev = throat_nodes.rev + 1, seq = nextval('throat_seq'), updated_at = now(), updated_by = EXCLUDED.updated_by`,
            [n.id, n.data, !!n.hidden, by || null]
          );
        }
        await client.query(
          `UPDATE throat_nodes SET hidden = true, rev = rev + 1, seq = nextval('throat_seq'), updated_at = now(), updated_by = $2
           WHERE NOT (id = ANY($1::text[])) AND NOT hidden`,
          [keep, by || null]
        );
        for (const m of snap.meta || []) {
          await client.query(
            `INSERT INTO throat_meta (key, data, rev, seq, updated_by) VALUES ($1, $2, 1, nextval('throat_seq'), $3)
             ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, rev = throat_meta.rev + 1,
               seq = nextval('throat_seq'), updated_at = now(), updated_by = EXCLUDED.updated_by`,
            [m.key, m.data, by || null]
          );
        }
        await client.query("COMMIT");
        return { done: true };
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

const usingPostgres = !!process.env.DATABASE_URL;
// On a host with a throwaway filesystem (Railway), a missing DATABASE_URL would
// silently fall back to a local file that is wiped on every redeploy. Setting
// REQUIRE_DATABASE=1 turns that mistake into a loud startup failure instead.
if (!usingPostgres && ["1", "true", "yes"].includes(String(process.env.REQUIRE_DATABASE || "").toLowerCase())) {
  console.error("REQUIRE_DATABASE is set but DATABASE_URL is missing. Refusing to start without a database.");
  process.exit(1);
}
const pool = usingPostgres
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
    })
  : null;
const store = usingPostgres ? makePgStore(pool) : makeFileStore();

// ── Backups ───────────────────────────────────────────────
// A snapshot is { nodes: [{id, data, hidden}], meta: [{key, data}] }, taken of
// the state about to be changed, so every snapshot is a known-good prior
// version. Hiding a node always snapshots first. Ordinary saves snapshot at
// most once per BACKUP_PERIOD_MS.
const BACKUP_REASONS = ["periodic", "before_hide", "before_restore", "manual"];

const visibleCount = (snap) => (snap && Array.isArray(snap.nodes) ? snap.nodes.filter((n) => !n.hidden).length : 0);

// For backups made on someone's action, `by` is that writer; for the periodic
// kind it is the writer whose save triggered it.
function backupFileName(reason, count, by) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const salt = Math.random().toString(36).slice(2, 6);
  const who = String(by || "").replace(/[^0-9A-Za-z_-]/g, "");
  return stamp + "-" + salt + "__" + reason + "__" + count + (who ? "__" + who : "") + ".json";
}
function parseBackupId(id) {
  const parts = id.split("__");
  if (parts.length !== 3 && parts.length !== 4) return null;
  const iso = parts[0]
    .slice(0, 23)
    .replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})$/, "$1-$2-$3T$4:$5:$6.$7Z");
  const at = new Date(iso);
  return {
    id,
    created_at: isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString(),
    reason: parts[1],
    node_count: parseInt(parts[2], 10) || 0,
    created_by: parts[3] || null,
  };
}

async function writeBackup(snap, reason, by) {
  const count = visibleCount(snap);
  if (!usingPostgres) {
    const name = backupFileName(reason, count, by);
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    await fs.writeFile(path.join(BACKUP_DIR, name), JSON.stringify({ data: snap }), "utf8");
    return parseBackupId(name.replace(/\.json$/, ""));
  }
  const r = await pool.query(
    "INSERT INTO throat_backups (data, node_count, reason, created_by) VALUES ($1, $2, $3, $4) RETURNING id, node_count, reason, created_at, created_by",
    [snap, count, reason, by || null]
  );
  const row = r.rows[0];
  return { id: String(row.id), created_at: row.created_at, reason: row.reason, node_count: row.node_count, created_by: row.created_by || null };
}

async function listBackups() {
  if (!usingPostgres) {
    let names = [];
    try {
      names = await fs.readdir(BACKUP_DIR);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return names
      .filter((n) => n.endsWith(".json"))
      .map((n) => parseBackupId(n.replace(/\.json$/, "")))
      .filter(Boolean)
      .sort((a, b) => b.id.localeCompare(a.id));
  }
  const r = await pool.query("SELECT id, node_count, reason, created_at, created_by FROM throat_backups ORDER BY created_at DESC, id DESC");
  return r.rows.map((row) => ({ id: String(row.id), created_at: row.created_at, reason: row.reason, node_count: row.node_count, created_by: row.created_by || null }));
}

async function getBackup(id) {
  if (!BACKUP_ID_RE.test(id)) return null;
  if (!usingPostgres) {
    const meta = parseBackupId(id);
    if (!meta) return null;
    try {
      const raw = await fs.readFile(path.join(BACKUP_DIR, id + ".json"), "utf8");
      return Object.assign({}, meta, { data: JSON.parse(raw).data });
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  if (!/^\d+$/.test(id)) return null;
  const r = await pool.query("SELECT id, data, node_count, reason, created_at, created_by FROM throat_backups WHERE id = $1", [id]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return { id: String(row.id), created_at: row.created_at, reason: row.reason, node_count: row.node_count, created_by: row.created_by || null, data: row.data };
}

// Only runs when BACKUP_KEEP is set to a positive number.
async function pruneBackups(keep) {
  if (!usingPostgres) {
    const doomed = (await listBackups()).slice(keep);
    for (const b of doomed) await fs.unlink(path.join(BACKUP_DIR, b.id + ".json")).catch(() => {});
    return doomed.length;
  }
  const r = await pool.query(
    `DELETE FROM throat_backups WHERE id NOT IN (
       SELECT id FROM throat_backups ORDER BY created_at DESC, id DESC LIMIT $1)`,
    [keep]
  );
  return r.rowCount;
}

let lastBackupAt = 0;
// Never lets a backup failure cost anyone a save.
async function snapshotIf(reason, by) {
  if (reason === "periodic" && Date.now() - lastBackupAt < BACKUP_PERIOD_MS) return;
  const prev = lastBackupAt;
  lastBackupAt = Date.now();
  try {
    const snap = await store.snapshot();
    if (!snap.nodes.length && !snap.meta.length) {
      lastBackupAt = prev;
      return;
    }
    await writeBackup(snap, reason, by);
    if (BACKUP_KEEP > 0) await pruneBackups(BACKUP_KEEP);
  } catch (e) {
    lastBackupAt = prev;
    console.error("snapshot failed (save proceeding):", e.message);
  }
}

// ── State and node API ───────────────────────────────────
function sendWrite(res, result, label) {
  if (result.notFound) return res.status(404).json({ error: "not_found" });
  if (result.conflict) return res.status(409).json({ error: "conflict", current: result.conflict });
  return res.json(Object.assign({ ok: true }, label === "meta" ? { meta: result.row } : { node: result.row }));
}
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(req.method + " " + req.path + " failed:", e.message);
    if (!res.headersSent) res.status(500).json({ error: "server_error" });
  });

// Everything, or only rows changed since `since_seq`.
app.get("/api/state", wrap(async (req, res) => {
  const since = Number(req.query.since_seq) || 0;
  res.json(await store.getState(since));
}));

// Create (base_rev omitted) or update (base_rev = rev the client last saw).
app.put("/api/nodes/:id", wrap(async (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.status(400).json({ error: "bad_id" });
  const base = parseBaseRev(req.body.base_rev);
  if (!base.ok) return res.status(400).json({ error: "bad_base_rev" });
  const problem = checkNodeData(req.body.data);
  if (problem) return res.status(400).json({ error: "bad_payload", message: problem });
  await snapshotIf("periodic", req.writer.id);
  sendWrite(res, await store.putNode(id, req.body.data, base.value, req.writer.id));
}));

// Hide and unhide are the only forms of removal. Nothing is erased.
app.post("/api/nodes/:id/hide", wrap(async (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.status(400).json({ error: "bad_id" });
  const base = parseBaseRev(req.body.base_rev);
  if (!base.ok || base.value === null) return res.status(400).json({ error: "bad_base_rev" });
  await snapshotIf("before_hide", req.writer.id);
  sendWrite(res, await store.setHidden(id, true, base.value, req.writer.id));
}));
app.post("/api/nodes/:id/unhide", wrap(async (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.status(400).json({ error: "bad_id" });
  const base = parseBaseRev(req.body.base_rev);
  if (!base.ok || base.value === null) return res.status(400).json({ error: "bad_base_rev" });
  await snapshotIf("periodic", req.writer.id);
  sendWrite(res, await store.setHidden(id, false, base.value, req.writer.id));
}));

// Shared settings such as era bands. Same revision rules as nodes.
app.put("/api/meta/:key", wrap(async (req, res) => {
  const { key } = req.params;
  if (!ID_RE.test(key)) return res.status(400).json({ error: "bad_key" });
  const base = parseBaseRev(req.body.base_rev);
  if (!base.ok) return res.status(400).json({ error: "bad_base_rev" });
  const problem = checkNodeData(req.body.data);
  if (problem) return res.status(400).json({ error: "bad_payload", message: problem });
  await snapshotIf("periodic", req.writer.id);
  sendWrite(res, await store.putMeta(key, req.body.data, base.value, req.writer.id), "meta");
}));

// ── Backup API ────────────────────────────────────────────
app.get("/api/backups", wrap(async (req, res) => {
  res.json({ backups: await listBackups(), keep: BACKUP_KEEP || null });
}));

app.post("/api/backups", wrap(async (req, res) => {
  const snap = await store.snapshot();
  if (!snap.nodes.length && !snap.meta.length) return res.status(400).json({ error: "nothing_to_back_up" });
  const rec = await writeBackup(snap, "manual", req.writer.id);
  lastBackupAt = Date.now();
  if (BACKUP_KEEP > 0) await pruneBackups(BACKUP_KEEP);
  res.json({ ok: true, backup: rec });
}));

// Must be registered before /api/backups/:id or "archive" would match as an id.
app.get("/api/backups/archive", wrap(async (req, res) => {
  const snapshots = [];
  for (const m of await listBackups()) {
    const full = await getBackup(m.id);
    if (full) snapshots.push(full);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Disposition", 'attachment; filename="throat-backups-' + stamp + '.json"');
  res.json({
    exported_at: new Date().toISOString(),
    storage: usingPostgres ? "postgres" : "json-file",
    current: await store.snapshot(),
    snapshots,
  });
}));

app.get("/api/backups/:id", wrap(async (req, res) => {
  const rec = await getBackup(req.params.id);
  if (!rec) return res.status(404).json({ error: "not_found" });
  res.json(rec);
}));

// Restore snapshots the current state first, so restoring is itself undoable.
// Nodes missing from the snapshot are hidden, never erased.
app.post("/api/backups/:id/restore", wrap(async (req, res) => {
  const rec = await getBackup(req.params.id);
  if (!rec) return res.status(404).json({ error: "not_found" });
  if (!rec.data || !Array.isArray(rec.data.nodes)) return res.status(400).json({ error: "corrupt_backup" });
  const current = await store.snapshot();
  if (current.nodes.length || current.meta.length) await writeBackup(current, "before_restore", req.writer.id);
  await store.replaceAll(rec.data, req.writer.id);
  lastBackupAt = Date.now();
  res.json({ ok: true, restored_from: rec.id, state: await store.getState(0) });
}));

// Malformed JSON and oversized bodies get a JSON reply, not a stack trace.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || 400;
  res.status(status).json({ error: status === 413 ? "too_large" : "bad_request" });
});

// SPA fallback once the client exists.
app.get("*", (req, res) => {
  if (!req.writer) return res.status(404).send("Not found."); // never hand the app page to someone signed out
  const index = path.join(__dirname, "public", "index.html");
  if (existsSync(index)) return res.sendFile(index);
  res.status(404).send("Client not built yet.");
});

(async () => {
  try {
    await store.init();
    const existing = await listBackups();
    if (existing.length) {
      const t = new Date(existing[0].created_at).getTime();
      if (Number.isFinite(t)) lastBackupAt = t;
    }
    app.listen(PORT, () => console.log("THE THROAT running on :" + PORT));
  } catch (e) {
    console.error("Startup failed:", e);
    process.exit(1);
  }
})();
