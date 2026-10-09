/* The Throat client, slice 2a: read-only 3D map.
 * Signed Maridizzle
 *
 * Sections: constants, model and API, layout (temporary), scene, UI, loop.
 * Node record (data field): { type, name, summary, links:[{to, label}],
 *   time:{era, order} }. Links live on the source node. A node with a `time`
 * sits on the story-time flow: grouped by era (order of the shared "eras"
 * setting, { eras:[{id, name}] }), then by `order`, evenly spaced. A node
 * with no `time` sits on the drifting outer ring. User text is only ever
 * inserted with textContent, never innerHTML.
 */
(() => {
"use strict";
const TAU = Math.PI * 2;
const $ = (id) => document.getElementById(id);

/* ---------- constants ---------- */
const TYPES = {
  character: { label: "Character", hex: "#B9A6D6", shape: "circle" },
  place: { label: "Place", hex: "#8A8FE0", shape: "diamond" },
  rule: { label: "Rule", hex: "#A073DA", shape: "hexagon" },
  thread: { label: "Thread", hex: "#C48CB8", shape: "triangle" },
  question: { label: "Open question", hex: "#9DB0F0", shape: "ring" },
  faction: { label: "Faction", hex: "#8FA6C9", shape: "square" },
  lore: { label: "Lore", hex: "#C9B8E6", shape: "pentagon" },
  chapter: { label: "Chapter", hex: "#C98BB0", shape: "octagon" },
  other: { label: "Untyped", hex: "#9A8FB5", shape: "circle" },
};
const TYPE_ORDER = ["character", "place", "rule", "thread", "question", "faction", "lore", "chapter", "other"];
const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
for (const k in TYPES) TYPES[k].rgb = hex2rgb(TYPES[k].hex);
const mixc = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const PLUM = [26, 15, 38], WHITE = [255, 255, 255];
const POLL_MS = 8000, POLL_OVERLAP = 8;

/* ---------- model and API ---------- */
const model = { rows: new Map(), meta: new Map(), seq: 0 };
let lastSync = 0, online = true;
let me = null;  // { mode, writer, writers } from /api/me
let peers = []; // who is online: [{ id, name, color, focus, editing }]

async function fetchState(sinceSeq) {
  const r = await fetch("/api/state?since_seq=" + sinceSeq, { headers: { Accept: "application/json" } });
  if (!r.ok) {
    const e = new Error("HTTP " + r.status);
    e.status = r.status;
    throw e;
  }
  return r.json();
}
// A repeated row with the same rev is ignored, so overlap in polling is harmless.
function applyState(s) {
  let changed = false;
  for (const row of s.nodes || []) {
    const cur = model.rows.get(row.id);
    if (!cur || row.rev > cur.rev) {
      model.rows.set(row.id, row);
      changed = true;
    }
  }
  for (const row of s.meta || []) {
    const cur = model.meta.get(row.key);
    if (!cur || row.rev > cur.rev) {
      model.meta.set(row.key, row);
      changed = true;
    }
  }
  model.seq = Math.max(model.seq, s.seq || 0);
  return changed;
}

/* ---------- graph derived from rows ---------- */
const HX_DX0 = 52;
let graph = { nodes: [], byId: new Map(), links: [], nbrs: new Map(),
  lay: { U: 0, dx: HX_DX0, lanes: [], bands: [], timed: [], ringNodes: [], hasHelix: false }, homeDist: 780 };
const hash = (str) => {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
};
const rng = (seed) => () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
/* Story-time flow. Time runs left to right along X. Each node type has its own leyline, a gently
 * weaving stream, and timed nodes sit on their type's stream in story order, evenly spaced, with a
 * small extra gap between eras. Untimed nodes drift in a cloud that orbits the whole flow. */
const HX = { DX: 52, LANE: 74, WEAVE_Y: 26, WEAVE_Z: 30, GAP: .9, CLOUD_PAD: 190 };
const xOfU = (u, lay) => (u - lay.U / 2) * lay.dx;
function streamPoint(lay, type, x, out) {
  const k = Math.max(0, lay.lanes.indexOf(type)), ph = k * 1.7;
  return out.set(x, Math.sin(x * .0075 + ph) * HX.WEAVE_Y, (k - (lay.lanes.length - 1) / 2) * HX.LANE + Math.sin(x * .0052 + ph * 1.3) * HX.WEAVE_Z);
}
const hasTime = (d) => !!d.time && typeof d.time === "object" && (d.time.era != null || Number.isFinite(d.time.order));
function layoutNodes(nodes) {
  const em = model.meta.get("eras");
  const eraList = em && em.data && Array.isArray(em.data.eras) ? em.data.eras.filter((e) => e && e.id != null) : [];
  const eraIdx = new Map(eraList.map((e, i) => [String(e.id), i]));
  const timed = [], ringNodes = [];
  for (const n of nodes) {
    if (n.fixed) continue;
    (hasTime(n.raw) ? timed : ringNodes).push(n);
  }
  const eraKey = (n) => (n.raw.time.era == null ? "" : String(n.raw.time.era));
  const rankOf = (k) => (k === "" ? -1 : eraIdx.has(k) ? eraIdx.get(k) : 1e6);
  const ord = (n) => (Number.isFinite(n.raw.time.order) ? n.raw.time.order : 1e9);
  timed.sort((a, b) => rankOf(eraKey(a)) - rankOf(eraKey(b)) || eraKey(a).localeCompare(eraKey(b)) ||
    ord(a) - ord(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const bands = [];
  let u = 0, prev = null;
  timed.forEach((n, i) => {
    const k = eraKey(n);
    if (prev !== null && k !== prev) u += HX.GAP;
    let b = bands[bands.length - 1];
    if (!b || b.key !== k) {
      const known = eraIdx.has(k);
      b = { key: k, name: k === "" ? "" : known ? String(eraList[eraIdx.get(k)].name || "ERA_TBD") : "ERA_TBD", u0: u, u1: u, count: 0 };
      bands.push(b);
    }
    n.u = u; n.beat = i + 1; n.band = bands.length - 1; b.u1 = u; b.count++;
    prev = k; u += 1;
  });
  const U = timed.length ? timed[timed.length - 1].u : 0;
  const lanes = TYPE_ORDER.filter((t) => timed.some((n) => n.type === t));
  const lay = { U, dx: Math.max(30, Math.min(HX.DX, 2600 / Math.max(U, 1))), lanes, bands, timed, ringNodes, hasHelix: timed.length > 0 };
  const v = new THREE.Vector3();
  for (const n of timed) { streamPoint(lay, n.type, xOfU(n.u, lay), v); n.x = v.x; n.y = v.y; n.z = v.z; }
  const cloudR = Math.max(260, (lanes.length * HX.LANE) / 2 + HX.CLOUD_PAD), span = Math.max(U * lay.dx, 900) * 1.05;
  ringNodes.sort((a, b) => a.id.localeCompare(b.id));
  ringNodes.forEach((n, i) => {
    n.ring = {
      a0: ((i * 0.618034) % 1) * TAU + ((hash(n.id) % 100) / 100 - .5) * .25,
      r: cloudR * (.9 + ((hash(n.id + "r") % 100) / 100) * .22),
      x: ((i + .5) / ringNodes.length - .5) * span + ((hash(n.id + "x") % 100) / 100 - .5) * 50,
    };
    n.x = n.ring.x; n.y = Math.cos(n.ring.a0) * n.ring.r * .8; n.z = Math.sin(n.ring.a0) * n.ring.r;
  });
  return lay;
}
function rebuildGraph() {
  const nodes = [], byId = new Map();
  for (const row of model.rows.values()) {
    if (row.hidden) continue;
    const d = row.data || {};
    const type = TYPES[d.type] ? d.type : "other";
    const fixed = !!(d.pos && isFinite(d.pos.x) && isFinite(d.pos.y) && isFinite(d.pos.z));
    const n = { id: row.id, type, name: String(d.name || row.id), summary: String(d.summary || ""),
      x: fixed ? d.pos.x : 0, y: fixed ? d.pos.y : 0, z: fixed ? d.pos.z : 0, fixed, u: null, beat: 0, band: -1, ring: null,
      deg: 0, updated_at: row.updated_at, by: row.updated_by || null, raw: d };
    nodes.push(n);
    byId.set(n.id, n);
  }
  const links = [], seen = new Set(), nbrs = new Map(nodes.map((n) => [n.id, []]));
  for (const n of nodes) {
    for (const l of Array.isArray(n.raw.links) ? n.raw.links : []) {
      const to = l && byId.get(l.to);
      if (!to || to === n) continue;
      const key = n.id < to.id ? n.id + "|" + to.id : to.id + "|" + n.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const label = String((l && l.label) || "");
      links.push({ a: n, b: to, label, bend: ((hash(key) % 1000) / 1000 - 0.5) * 0.34 });
      n.deg++; to.deg++;
      nbrs.get(n.id).push({ node: to, label });
      nbrs.get(to.id).push({ node: n, label });
    }
  }
  const lay = layoutNodes(nodes);
  for (const l of links) l.moving = !!(l.a.ring || l.b.ring);
  let extX = 200, extYZ = 200;
  for (const n of nodes) { extX = Math.max(extX, Math.abs(n.x)); extYZ = Math.max(extYZ, Math.hypot(n.y, n.z)); }
  const homeDist = Math.min(3600, Math.max(560, extX * 1.55, extYZ * 2.6));
  graph = { nodes, byId, links, nbrs, lay, homeDist };
}

/* ---------- three.js scene ---------- */
if (!window.THREE) {
  showState("Could not load the 3D engine", "The three.js library did not load. Check your connection and reload.", true);
  return;
}
const cv = $("c");
const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0);
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x0B0714, 0.00042);
const camera = new THREE.PerspectiveCamera(50, 1, 5, 9000);
let W = 0, H = 0;

let quality = 2, calm = false;
const cam = { yaw: 0.12, pit: 0.3, dist: 780 };
const HOME = { yaw: 0.12, pit: 0.3, dist: 780 };
const target = new THREE.Vector3(), goal = new THREE.Vector3();

function resize() {
  W = innerWidth; H = innerHeight;
  renderer.setPixelRatio(quality === 0 ? 1 : Math.min(devicePixelRatio || 1, quality === 1 ? 1.5 : 2));
  renderer.setSize(W, H, false);
  cv.style.width = W + "px"; cv.style.height = H + "px";
  camera.aspect = W / H; camera.updateProjectionMatrix();
}
addEventListener("resize", resize);

/* textures drawn on canvases */
const tileCanvas = (() => {
  const t = document.createElement("canvas"); t.width = t.height = 160;
  const x = t.getContext("2d"), id = x.createImageData(160, 160), r = rng(4242);
  for (let i = 0; i < 160 * 160; i++) { const v = 70 + r() * 150 | 0; id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
  x.putImageData(id, 0, 0); x.lineCap = "round";
  for (let i = 0; i < 7; i++) {
    x.strokeStyle = `rgba(255,255,255,${.12 + r() * .18})`; x.lineWidth = .6 + r() * 1.2; x.beginPath();
    x.moveTo(r() * 160, r() * 160); x.bezierCurveTo(r() * 160, r() * 160, r() * 160, r() * 160, r() * 160, r() * 160); x.stroke();
  }
  return t;
})();
function shapePath(c, shape, x, y, r) {
  c.beginPath();
  if (shape === "circle") { c.arc(x, y, r, 0, TAU); return; }
  if (shape === "ring") { c.arc(x, y, r, 0, TAU); c.moveTo(x + r * .55, y); c.arc(x, y, r * .55, 0, TAU, true); return; }
  const n = { diamond: 4, hexagon: 6, triangle: 3, square: 4, pentagon: 5, octagon: 8 }[shape];
  const rot = { hexagon: 0, square: -Math.PI / 4, octagon: Math.PI / 8 }[shape] ?? -Math.PI / 2;
  const k = { diamond: 1.2, square: 1.15, octagon: 1.04 }[shape] || 1.08;
  for (let i = 0; i < n; i++) { const a = rot + i * TAU / n, px = x + Math.cos(a) * r * k, py = y + Math.sin(a) * r * k; i ? c.lineTo(px, py) : c.moveTo(px, py); }
  c.closePath();
}
function nodeTexture(type) {
  const S = 256, C = S / 2, R = 84, t = TYPES[type], rgb = t.rgb;
  const cv2 = document.createElement("canvas"); cv2.width = cv2.height = S;
  const c = cv2.getContext("2d");
  const hi = mixc(rgb, WHITE, .42), mid = mixc(rgb, PLUM, .38);
  const g = c.createRadialGradient(C - R * .38, C - R * .42, R * .08, C, C, R * 1.2);
  g.addColorStop(0, rgba(hi, 1)); g.addColorStop(.42, rgba(mid, 1)); g.addColorStop(1, rgba(mixc(PLUM, rgb, .12), 1));
  c.shadowColor = "rgba(5,2,12,.9)"; c.shadowBlur = 28; c.shadowOffsetX = 11; c.shadowOffsetY = 15;
  shapePath(c, t.shape, C, C, R); c.fillStyle = g; c.fill();
  c.shadowColor = "transparent"; c.shadowBlur = 0; c.shadowOffsetX = 0; c.shadowOffsetY = 0;
  c.save(); shapePath(c, t.shape, C, C, R); c.clip();
  c.globalCompositeOperation = "overlay"; c.globalAlpha = .34; c.fillStyle = c.createPattern(tileCanvas, "repeat"); c.fillRect(0, 0, S, S);
  c.restore();
  const rg = c.createLinearGradient(C - R, C - R, C + R, C + R);
  rg.addColorStop(0, "rgba(233,222,247,.9)"); rg.addColorStop(.45, rgba(hi, .25)); rg.addColorStop(1, rgba(rgb, .06));
  shapePath(c, t.shape, C, C, R); c.strokeStyle = rg; c.lineWidth = 7; c.stroke();
  const tex = new THREE.CanvasTexture(cv2);
  return tex;
}
function radialTexture(stops) {
  const S = 128, c = document.createElement("canvas"); c.width = c.height = S;
  const x = c.getContext("2d"), g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  for (const [o, a] of stops) g.addColorStop(o, `rgba(255,255,255,${a})`);
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}
function ringTexture() {
  const S = 128, c = document.createElement("canvas"); c.width = c.height = S;
  const x = c.getContext("2d");
  x.strokeStyle = "rgba(255,255,255,.95)"; x.lineWidth = 3; x.beginPath(); x.arc(S / 2, S / 2, S / 2 - 6, 0, TAU); x.stroke();
  return new THREE.CanvasTexture(c);
}
const glowTex = radialTexture([[0, 1], [.35, .3], [1, 0]]);
const dustTex = radialTexture([[0, 1], [.5, .35], [1, 0]]);
const pulseTex = radialTexture([[0, 1], [.25, .55], [1, 0]]);
const selRingTex = ringTexture();
const nodeTex = {};
for (const k of TYPE_ORDER) nodeTex[k] = nodeTexture(k);

/* dust */
let dust = null;
function buildDust() {
  if (dust) { scene.remove(dust); dust.geometry.dispose(); dust.material.dispose(); dust = null; }
  if (quality === 0) return;
  const n = quality === 1 ? 140 : 280, pos = new Float32Array(n * 3), r = rng(99);
  for (let i = 0; i < n; i++) { pos[i * 3] = (r() - .5) * 1500; pos[i * 3 + 1] = (r() - .5) * 1100; pos[i * 3 + 2] = (r() - .5) * 1500; }
  const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  dust = new THREE.Points(geo, new THREE.PointsMaterial({ map: dustTex, size: 9, sizeAttenuation: true, transparent: true,
    opacity: .5, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xB9A6D6 }));
  dust.renderOrder = 0;
  scene.add(dust);
}

/* node and link objects, rebuilt whenever the graph changes */
const group = new THREE.Group(); scene.add(group);
let objs = [], linkObjs = [];
const hidden = new Set();
let selectedId = null, hoverId = null;
const pulses = [];
let decorObjs = [], ringAngle = 0;
const UP = new THREE.Vector3(0, 1, 0), tmpP = new THREE.Vector3(), tmpQ = new THREE.Vector3();
function clearGroup() {
  for (const o of objs) { o.sprite.material.dispose(); if (o.glow) o.glow.material.dispose(); }
  for (const l of linkObjs) { l.line.geometry.dispose(); l.line.material.dispose(); }
  for (const d of decorObjs) { d.geometry.dispose(); d.material.dispose(); }
  for (const p of pulses) p.material.dispose();
  pulses.length = 0;
  while (group.children.length) group.remove(group.children[0]);
  objs = []; linkObjs = []; decorObjs = [];
}
// Recompute one link's curve and line from its endpoints' current positions.
function updateLinkGeom(lo) {
  const l = lo.link, c = lo.curve;
  c.v0.set(l.a.x, l.a.y, l.a.z); c.v2.set(l.b.x, l.b.y, l.b.z);
  c.v1.copy(c.v0).add(c.v2).multiplyScalar(.5);
  if (l.moving) {
    tmpP.subVectors(c.v2, c.v0).cross(UP);
    if (tmpP.lengthSq() < 1e-6) tmpP.set(1, 0, 0);
    tmpP.normalize().multiplyScalar(c.v0.distanceTo(c.v2) * l.bend);
  } else tmpP.set(0, c.v0.distanceTo(c.v2) * (.14 + Math.abs(l.bend) * .6), 0); // links between timed nodes arch over the flow
  c.v1.add(tmpP);
  const pos = lo.line.geometry.attributes.position, n = pos.count;
  for (let i = 0; i < n; i++) { c.getPoint(i / (n - 1), tmpQ); pos.setXYZ(i, tmpQ.x, tmpQ.y, tmpQ.z); }
  pos.needsUpdate = true;
}
// Cloud nodes drift slowly around the flow. Moves sprites and the links attached to them.
function placeRing() {
  for (const o of objs) {
    const r = o.n.ring; if (!r) continue;
    const a = r.a0 + ringAngle;
    o.n.x = r.x; o.n.z = Math.sin(a) * r.r;
    o.n.y = Math.cos(a) * r.r * .8 + (calm ? 0 : Math.sin(time * .4 + o.ph) * 6);
    o.sprite.position.set(o.n.x, o.n.y, o.n.z);
    if (o.glow) o.glow.position.copy(o.sprite.position);
  }
  for (const lo of linkObjs) if (lo.link.moving) updateLinkGeom(lo);
}
function buildDecor() {
  const lay = graph.lay;
  if (!lay.hasHelix) return;
  const x0 = xOfU(-.8, lay), x1 = xOfU(lay.U + .8, lay), reach = lay.lanes.length * HX.LANE / 2 + 70;
  const add = (m) => { m.renderOrder = 0; group.add(m); decorObjs.push(m); };
  for (const type of lay.lanes) { // one glowing leyline per node type
    const pts = [];
    for (let x = x0; x <= x1 + 1e-6; x += 24) pts.push(streamPoint(lay, type, x, new THREE.Vector3()));
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = (radius, opacity) => add(new THREE.Mesh(new THREE.TubeGeometry(curve, pts.length * 2, radius, 6, false),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(TYPES[type].hex), transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false })));
    tube(1.1, .5);
    if (quality >= 1) tube(5, .09);
  }
  if (!lay.bands.some((b) => b.key !== "")) return;
  const edges = lay.bands.map((b, i) => xOfU(b.u0 - (i === 0 ? .5 : HX.GAP / 2), lay));
  edges.push(xOfU(lay.bands[lay.bands.length - 1].u1 + .5, lay));
  lay.bands.forEach((b, i) => { // soft glowing pool under each era
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: glowTex, color: i % 2 ? 0xB9A6D6 : 0x6D72D6, transparent: true, opacity: i % 2 ? .1 : .16, blending: THREE.AdditiveBlending, depthWrite: false }));
    pool.rotation.x = -Math.PI / 2;
    pool.position.set((edges[i] + edges[i + 1]) / 2, -120, 0);
    pool.scale.set(edges[i + 1] - edges[i] + lay.dx * 1.2, (reach + 60) * 2, 1);
    add(pool);
  });
  for (const ex of edges) { // faint boundary where one era gives way to the next
    const ring = [];
    for (let i = 0; i < 64; i++) { const a = i / 64 * TAU; ring.push(new THREE.Vector3(ex, Math.sin(a) * 120, Math.cos(a) * (reach + 30))); }
    add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ring),
      new THREE.LineBasicMaterial({ color: 0x6D72D6, transparent: true, opacity: .22, blending: THREE.AdditiveBlending, depthWrite: false })));
  }
}
const radiusOf = (n) => 16 + Math.min(n.deg, 7) * 2.2;
function buildScene() {
  clearGroup();
  const byId = new Map();
  buildDecor();
  const SEG = 29;
  for (const l of graph.links) {
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3());
    const col = new Float32Array(SEG * 3), ca = TYPES[l.a.type].rgb, cb = TYPES[l.b.type].rgb;
    for (let i = 0; i < SEG; i++) { const t = i / (SEG - 1); for (let k = 0; k < 3; k++) col[i * 3 + k] = (ca[k] + (cb[k] - ca[k]) * t) / 255; }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SEG * 3), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .3,
      blending: THREE.AdditiveBlending, depthWrite: false }));
    line.renderOrder = 0; line.frustumCulled = false; group.add(line);
    const lo = { link: l, line, curve, op: .3 };
    updateLinkGeom(lo);
    linkObjs.push(lo);
  }
  for (const n of graph.nodes) {
    const t = TYPES[n.type], R = radiusOf(n);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: nodeTex[n.type], transparent: true, depthWrite: false }));
    sprite.scale.setScalar(R * 3.05); sprite.position.set(n.x, n.y, n.z); sprite.renderOrder = 2;
    let glow = null;
    if (quality >= 1) {
      glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color(t.hex), transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending, opacity: .3 }));
      glow.position.copy(sprite.position); glow.renderOrder = 1; group.add(glow);
    }
    group.add(sprite);
    const o = { n, sprite, glow, R, ph: (hash(n.id) % 628) / 100, gk: 1, op: .3 };
    objs.push(o); byId.set(n.id, o);
  }
  objs.byId = byId;
  if (quality >= 1) {
    for (let i = 0; i < 14; i++) {
      const p = new THREE.Sprite(new THREE.SpriteMaterial({ map: pulseTex, color: 0xE9DEF7, transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
      p.scale.setScalar(18); p.renderOrder = 3; p.visible = false; group.add(p); pulses.push(p);
    }
  }
  selRing.visible = false; group.add(selRing);
  for (const s of presRings) group.add(s);
  placeRing();
  applyVisibility();
}
const selRing = new THREE.Sprite(new THREE.SpriteMaterial({ map: selRingTex, color: 0xE9DEF7, transparent: true,
  depthWrite: false, blending: THREE.AdditiveBlending, opacity: .7 }));
selRing.renderOrder = 3;
// One ring per other writer (up to three), tinted in that writer's color.
const presRings = [0, 1, 2].map(() => {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: selRingTex, color: 0xffffff, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, opacity: 0 }));
  s.renderOrder = 3; s.visible = false;
  return s;
});
function applyVisibility() {
  for (const o of objs) { const v = !hidden.has(o.n.type); o.sprite.visible = v; if (o.glow) o.glow.visible = v; }
  for (const l of linkObjs) l.line.visible = !hidden.has(l.link.a.type) && !hidden.has(l.link.b.type);
}

/* ---------- UI ---------- */
const icons = {
  circle: '<circle cx="9" cy="9" r="6" fill="currentColor"/>',
  diamond: '<polygon points="9,1.5 16.5,9 9,16.5 1.5,9" fill="currentColor"/>',
  hexagon: '<polygon points="16,9 12.5,15 5.5,15 2,9 5.5,3 12.5,3" fill="currentColor"/>',
  triangle: '<polygon points="9,2 16.5,15.5 1.5,15.5" fill="currentColor"/>',
  ring: '<circle cx="9" cy="9" r="5.5" fill="none" stroke="currentColor" stroke-width="3"/>',
  square: '<rect x="3" y="3" width="12" height="12" rx="1.5" fill="currentColor"/>',
  pentagon: '<polygon points="9,1.8 16,7 13.3,15.5 4.7,15.5 2,7" fill="currentColor"/>',
  octagon: '<polygon points="6,2 12,2 16,6 16,12 12,16 6,16 2,12 2,6" fill="currentColor"/>',
};
function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const k in props) { if (k === "class") e.className = props[k]; else if (k === "style") e.style.cssText = props[k]; else if (k.startsWith("on")) e.addEventListener(k.slice(2), props[k]); else e.setAttribute(k, props[k]); }
  for (const kid of kids) if (kid != null) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}
function showState(title, msg, retry) {
  const s = $("state");
  s.replaceChildren(el("h2", null, title), el("p", null, msg));
  if (retry) s.append(el("button", { type: "button", onclick: () => location.reload() }, "Reload"));
  s.classList.add("show");
}
const hideState = () => $("state").classList.remove("show");

// Layers: a checkbox per type plus an arrow that lists every node in that layer (alphabetical).
// On a phone the list opens in a pop-up, because the panel is a single row of chips there.
const openLayers = new Set(); // which layer lists are open; survives the map refreshing
const isPhone = () => matchMedia("(max-width:860px)").matches;
const nodesOfType = (k) => graph.nodes.filter((n) => n.type === k).sort((a, b) => a.name.localeCompare(b.name));
function layerButtons(k, onPick) {
  return nodesOfType(k).map((n) => el("button", { type: "button", "data-id": n.id, title: n.name, onclick: () => onPick(n.id) }, n.name));
}
function markLayerSelection() {
  for (const b of document.querySelectorAll("#legend .lnodes button")) {
    const on = b.dataset.id === selectedId;
    b.classList.toggle("sel", on);
    if (on) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
  }
}
function openLayerPopup(k) {
  const t = TYPES[k], ul = el("ul", { class: "hl lpop" });
  for (const b of layerButtons(k, (id) => { closeModal(); select(id); })) ul.append(el("li", null, b));
  if (!ul.children.length) ul.append(el("li", { class: "dim" }, "No nodes in this layer."));
  openModal(t.label + " (" + ul.querySelectorAll("button").length + ")", ul, [{ label: "Close", kind: "quiet", onclick: closeModal }]);
}
function buildLegend() {
  const lg = $("legend"), counts = {};
  for (const n of graph.nodes) counts[n.type] = (counts[n.type] || 0) + 1;
  lg.replaceChildren(el("h2", null, "Layers"));
  for (const k of TYPE_ORDER) {
    if (k === "other" && !counts.other) continue;
    const t = TYPES[k];
    const cb = el("input", { type: "checkbox", "aria-label": "Show " + t.label });
    cb.checked = !hidden.has(k);
    cb.addEventListener("change", () => { cb.checked ? hidden.delete(k) : hidden.add(k); applyVisibility(); });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 18 18"); svg.setAttribute("aria-hidden", "true"); svg.innerHTML = icons[t.shape];
    const open = openLayers.has(k) && !isPhone();
    const listId = "lnodes-" + k;
    const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    arrow.setAttribute("viewBox", "0 0 12 12"); arrow.setAttribute("aria-hidden", "true"); arrow.innerHTML = '<path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
    const ul = el("ul", { class: "lnodes", id: listId });
    ul.hidden = !open;
    if (open) for (const b of layerButtons(k, (id) => select(id))) ul.append(el("li", null, b));
    const btn = el("button", { type: "button", class: "exp", "aria-expanded": String(open), "aria-controls": listId,
      "aria-label": (open ? "Hide the list of " : "Show the list of ") + t.label + " nodes" }, arrow);
    btn.addEventListener("click", () => {
      if (isPhone()) { openLayerPopup(k); return; }
      const nowOpen = ul.hidden; // it is about to open
      ul.hidden = !nowOpen;
      btn.setAttribute("aria-expanded", String(nowOpen));
      btn.setAttribute("aria-label", (nowOpen ? "Hide the list of " : "Show the list of ") + t.label + " nodes");
      if (nowOpen) { openLayers.add(k); ul.replaceChildren(...layerButtons(k, (id) => select(id)).map((b) => el("li", null, b))); markLayerSelection(); }
      else openLayers.delete(k);
    });
    lg.append(el("div", { class: "layer" },
      el("label", { style: "color:" + t.hex }, cb, svg, el("span", { style: "color:var(--text)" }, t.label), el("span", { class: "n" }, counts[k] || 0)),
      btn), ul);
  }
  markLayerSelection();
}
function relTime(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (!isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return Math.floor(s / 86400) + " d ago";
}
function whenText(n) {
  const b = graph.lay.bands[n.band];
  return (b && b.name ? b.name + ", " : "") + "beat " + n.beat + " of " + graph.lay.timed.length;
}
function showDetail() {
  const d = $("detail"), n = selectedId && graph.byId.get(selectedId);
  if (editing) { updateEditWarn(); return; } // never wipe a form that is being edited
  d.classList.remove("editing");
  if (!n) {
    d.replaceChildren(el("h2", null, graph.nodes.length ? "Nothing selected" : "Empty map"),
      el("p", { class: "dim" }, graph.nodes.length ? "Click a node to fly to it." : "No nodes yet. Create the first one."),
      el("div", { class: "acts" }, el("button", { type: "button", onclick: () => startEdit(null) }, "New node")));
    return;
  }
  const t = TYPES[n.type], nb = graph.nbrs.get(n.id) || [];
  const list = el("ul");
  for (const x of nb) list.append(el("li", null, el("button", { class: "nb", type: "button", onclick: () => select(x.node.id) }, x.node.name), x.label ? " " : null, x.label ? el("span", { class: "lkl" }, x.label) : null));
  d.replaceChildren(
    el("span", { class: "chip cin", style: "color:" + t.hex }, t.label),
    el("h2", null, n.name),
    el("div", { class: "f" }, "Summary"),
    n.summary ? el("p", null, n.summary) : el("p", { class: "dim" }, "No summary yet."),
    imagesBlock(n),
    el("div", { class: "f" }, "Story time"),
    n.u == null ? el("p", { class: "dim" }, "No story time yet (drifting cloud)") : el("p", null, whenText(n)),
    el("div", { class: "f" }, "Connected to (" + nb.length + ")"),
    nb.length ? list : el("p", { class: "dim" }, "No links yet."),
    el("div", { class: "f" }, "Last changed"), el("p", null, relTime(n.updated_at) + byText(n.by)),
    el("div", { class: "acts" },
      el("button", { type: "button", onclick: () => startEdit(n) }, "Edit"),
      el("button", { type: "button", class: "quiet", onclick: () => askHide(n) }, "Hide"),
      el("button", { type: "button", class: "quiet", onclick: () => chatAdd(n.id) }, "Add to chat")));
}
function setSync() {
  const p = $("sync");
  p.className = online ? "" : "off";
  p.textContent = online ? (lastSync ? "Synced " + relTime(new Date(lastSync).toISOString()) : "Connecting...") : "Offline, retrying";
}

/* ---------- selection and camera ---------- */
let editing = null; // { id, isNew, baseRev, base } while the node editor is open
function select(id) {
  if (editing && id !== editing.id) {
    if (!confirmDiscard()) return;
    editing = null;
  }
  selectedId = id && graph.byId.has(id) ? id : null;
  const n = selectedId && graph.byId.get(selectedId);
  if (n) goal.set(n.x, n.y, n.z);
  refreshLinkEmphasis();
  showDetail();
  markLayerSelection();
  chatSync();
  pingSoon();
}
function refreshLinkEmphasis() {
  for (const l of linkObjs) l.sel = !!selectedId && (l.link.a.id === selectedId || l.link.b.id === selectedId);
}
function centroid() {
  const c = new THREE.Vector3();
  if (!graph.nodes.length) return c;
  for (const n of graph.nodes) c.add(new THREE.Vector3(n.x, n.y, n.z));
  return c.multiplyScalar(1 / graph.nodes.length);
}

/* input */
let dragging = false, px = 0, py = 0, moved = 0, mx = -999, my = -999, mouseOn = false;
cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture(e.pointerId); dragging = true; cv.classList.add("drag"); px = e.clientX; py = e.clientY; moved = 0; });
cv.addEventListener("pointermove", (e) => {
  mx = e.clientX; my = e.clientY; mouseOn = e.pointerType === "mouse";
  if (!dragging) return;
  const dx = e.clientX - px, dy = e.clientY - py; px = e.clientX; py = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
  cam.yaw -= dx * .0052; cam.pit = Math.max(-1.25, Math.min(1.25, cam.pit + dy * .0052));
});
cv.addEventListener("pointerup", () => { dragging = false; cv.classList.remove("drag"); if (moved < 6) select(hoverId); });
cv.addEventListener("pointerleave", () => { mx = my = -999; mouseOn = false; });
cv.addEventListener("wheel", (e) => { e.preventDefault(); cam.dist = Math.max(260, Math.min(2200, cam.dist * Math.exp(e.deltaY * .0011))); }, { passive: false });
const keys = new Set();
const typing = (e) => /^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || "");
addEventListener("keydown", (e) => { if (!typing(e)) keys.add(e.key.toLowerCase()); });
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
addEventListener("blur", () => keys.clear());

function applyBodyClass() { document.body.className = (calm ? "calm " : "") + "q" + quality; }
$("qsel").addEventListener("change", (e) => { quality = +e.target.value; applyBodyClass(); resize(); buildDust(); buildScene(); refreshLinkEmphasis(); });
const calmBox = $("calm"), mq = matchMedia("(prefers-reduced-motion: reduce)");
function setCalm(v) { calm = v; calmBox.checked = v; applyBodyClass(); }
calmBox.addEventListener("change", (e) => setCalm(e.target.checked));
$("reset").addEventListener("click", () => { Object.assign(cam, HOME); select(null); goal.copy(centroid()); });

/* ---------- editing: write API, modal, node editor, conflicts, hide, eras ---------- */
const LIM = { name: 200, summary: 20000, label: 200, era: 120 };
const uid = (p) => p + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
const deepCopy = (v) => JSON.parse(JSON.stringify(v));

async function apiWrite(method, url, body) {
  try {
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body || {}) });
    let json = null;
    try { json = await r.json(); } catch (e) { /* no body */ }
    return { status: r.status, json };
  } catch (e) {
    return { status: 0, json: null };
  }
}
async function apiRead(url) {
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    let json = null;
    try { json = await r.json(); } catch (e) { /* no body */ }
    return { status: r.status, json };
  } catch (e) {
    return { status: 0, json: null };
  }
}
let toastTimer = 0;
function toast(msg, bad) {
  const t = $("toast");
  t.textContent = msg; t.className = "show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ""; }, 6000);
}
function writeFailure(r) {
  if (r.status === 401) toast("Your sign-in ended. Sign in again in a new tab, then press Save again. Your edits are still in this form.", true);
  else if (r.status === 400 && r.json && r.json.message) toast("The server refused that: " + r.json.message, true);
  else toast("Could not save. Your edits are still in the form.", true);
}

/* modal */
let modalEl = null, modalOnClose = null;
function closeModal() {
  if (!modalEl) return;
  modalEl.remove(); modalEl = null;
  const f = modalOnClose; modalOnClose = null;
  if (f) f();
}
function openModal(title, body, buttons, opts) {
  closeModal();
  const bar = el("div", { class: "bar" }), btns = {};
  for (const b of buttons) {
    const x = el("button", { type: "button", class: b.kind || "", onclick: b.onclick }, b.label);
    bar.append(x); btns[b.id || b.label] = x;
  }
  const box = el("div", { class: "box" + (opts && opts.wide ? " wide" : ""), role: "dialog", "aria-modal": "true", "aria-label": title }, el("h2", null, title), body, bar);
  modalEl = el("div", { class: "modal" }, box);
  modalOnClose = (opts && opts.onClose) || null;
  modalEl.addEventListener("pointerdown", (e) => { if (e.target === modalEl && !(opts && opts.sticky)) closeModal(); });
  document.body.append(modalEl);
  const first = box.querySelector("input,select,textarea") || box.querySelector(".bar button");
  if (first) first.focus();
  return { box, btns };
}
addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (modalEl) closeModal(); else if (editing) cancelEdit();
});

/* field helpers shared by the editor and the conflict dialog */
const FIELDS = ["type", "name", "summary", "time", "links", "images"];
const FIELD_LABEL = { type: "Type", name: "Name", summary: "Summary", time: "Story time", links: "Links from this node", images: "Images" };
const MAX_IMAGES = 12, IMG_MAX_DIM = 900, THUMB_DIM = 200, JPEG_PREFIX = "data:image/jpeg;base64,";
// Only inline JPEG data URIs are ever shown. Anything else in stored data is ignored.
const safeJpeg = (s) => typeof s === "string" && s.startsWith(JPEG_PREFIX);
const imagesOf = (d) => (Array.isArray(d.images) ? d.images.filter((i) => i && i.id && safeJpeg(i.src)) : []);
const eraList = () => {
  const em = model.meta.get("eras");
  return em && em.data && Array.isArray(em.data.eras) ? em.data.eras.filter((e) => e && e.id != null) : [];
};
const eraName = (id) => { const e = eraList().find((x) => String(x.id) === String(id)); return e ? String(e.name || "ERA_TBD") : "ERA_TBD"; };
function fieldsOf(d) {
  return {
    type: String(d.type || ""),
    name: String(d.name || ""),
    summary: String(d.summary || ""),
    time: hasTime(d) ? JSON.stringify({ era: d.time.era == null ? null : String(d.time.era), order: Number.isFinite(d.time.order) ? d.time.order : null }) : "",
    links: JSON.stringify((Array.isArray(d.links) ? d.links : []).filter((l) => l && l.to).map((l) => [String(l.to), String(l.label || "")]).sort()),
    images: JSON.stringify(imagesOf(d).map((i) => [String(i.id), String(i.caption || "")])),
  };
}
function setField(target, f, src) {
  if (f === "time") { if (hasTime(src)) target.time = deepCopy(src.time); else delete target.time; }
  else if (f === "links") target.links = deepCopy(Array.isArray(src.links) ? src.links : []);
  else if (f === "images") { if (Array.isArray(src.images) && src.images.length) target.images = deepCopy(src.images); else delete target.images; }
  else if (src[f] === undefined) delete target[f];
  else target[f] = src[f];
}
function nodeNameById(id) {
  const n = graph.byId.get(id);
  if (n) return n.name;
  const r = model.rows.get(id);
  return r && r.data && r.data.name ? r.data.name + " (hidden)" : id;
}
function fieldDisplay(f, d) {
  if (f === "type") return el("span", null, d.type ? (TYPES[d.type] ? TYPES[d.type].label : String(d.type)) : "(none)");
  if (f === "name") return el("span", null, d.name ? String(d.name) : "(empty)");
  if (f === "summary") return el("span", { class: "pre" }, d.summary ? String(d.summary) : "(empty)");
  if (f === "time") {
    if (!hasTime(d)) return el("span", { class: "dim" }, "No story time");
    const parts = [];
    if (d.time.era != null) parts.push(eraName(d.time.era));
    if (Number.isFinite(d.time.order)) parts.push("order " + d.time.order);
    return el("span", null, parts.join(", "));
  }
  if (f === "images") {
    const ims = imagesOf(d);
    if (!ims.length) return el("span", { class: "dim" }, "(none)");
    const row = el("div", { class: "thumbrow" });
    for (const im of ims) row.append(el("img", { src: safeJpeg(im.thumb) ? im.thumb : im.src, alt: im.caption || "", title: im.caption || "" }));
    return el("div", null, row, el("small", null, ims.length + (ims.length === 1 ? " image" : " images")));
  }
  const ls = (Array.isArray(d.links) ? d.links : []).filter((l) => l && l.to);
  if (!ls.length) return el("span", { class: "dim" }, "(none)");
  const ul = el("ul");
  for (const l of ls) ul.append(el("li", null, nodeNameById(String(l.to)), l.label ? " (" + l.label + ")" : ""));
  return ul;
}

/* images: resized in the browser, stored inline as JPEG data URIs */
async function decodeImage(file) {
  try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch (e) {
    const url = URL.createObjectURL(file);
    try {
      const im = new Image();
      im.src = url;
      await im.decode();
      return im;
    } finally { URL.revokeObjectURL(url); }
  }
}
function encodeJpeg(src, maxDim, quality) {
  let w = src.width, h = src.height;
  if (w > maxDim || h > maxDim) { if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; } else { w = Math.round(w * maxDim / h); h = maxDim; } }
  const c = document.createElement("canvas");
  c.width = Math.max(1, w); c.height = Math.max(1, h);
  const x = c.getContext("2d");
  x.fillStyle = "#1A0F26"; x.fillRect(0, 0, c.width, c.height); // flatten transparency onto the plum field
  x.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}
async function processImageFile(file) {
  if (!/^image\//.test(file.type)) throw new Error("not an image");
  const src = await decodeImage(file);
  let full = encodeJpeg(src, IMG_MAX_DIM, .82);
  if (full.length > 1.2 * 1024 * 1024) full = encodeJpeg(src, 720, .7); // keep well under the server cap
  const thumb = encodeJpeg(src, THUMB_DIM, .7);
  if (src.close) src.close();
  if (!safeJpeg(full)) throw new Error("could not encode");
  return { id: uid("i_"), src: full, thumb, caption: "", createdAt: Date.now() };
}
function imagesBlock(n) {
  const ims = imagesOf(n.raw);
  if (!ims.length) return document.createDocumentFragment(); // empty, not null: replaceChildren would print "null"
  const row = el("div", { class: "thumbrow big" });
  ims.forEach((im, i) => row.append(el("button", { type: "button", class: "tb", "aria-label": "View image " + (i + 1) + (im.caption ? ": " + im.caption : ""), onclick: () => openLightbox(ims, i) },
    el("img", { src: safeJpeg(im.thumb) ? im.thumb : im.src, alt: im.caption || "" }))));
  return el("div", null, el("div", { class: "f" }, "Images (" + ims.length + ")"), row);
}
function openLightbox(ims, start) {
  let i = start;
  const img = el("img", { class: "lbimg", alt: "" }), cap = el("p", { class: "lbcap" }), cnt = el("small", null, "");
  const show = () => { const im = ims[i]; img.src = im.src; img.alt = im.caption || ""; cap.textContent = im.caption || ""; cnt.textContent = (i + 1) + " of " + ims.length; };
  const step = (d) => { i = (i + d + ims.length) % ims.length; show(); };
  const onKey = (e) => { if (e.key === "ArrowLeft") step(-1); else if (e.key === "ArrowRight") step(1); };
  const btns = [];
  if (ims.length > 1) btns.push({ label: "Previous", kind: "quiet", onclick: () => step(-1) }, { label: "Next", kind: "quiet", onclick: () => step(1) });
  btns.push({ label: "Close", kind: "quiet", onclick: closeModal });
  addEventListener("keydown", onKey);
  openModal("Image", el("div", { class: "lbbox" }, img, cap, cnt), btns, { wide: true, onClose: () => removeEventListener("keydown", onKey) });
  show();
}

/* node editor */
const confirmDiscard = () => !editingDirty() || confirm("Discard your unsaved changes to this node?");
function startEdit(n) {
  if (chat.open) chatToggle(false); // the editor lives in the node panel, which the chat hides
  if (editing && !confirmDiscard()) return;
  const row = n && model.rows.get(n.id);
  editing = { id: n ? n.id : uid("n_"), isNew: !n, baseRev: row ? row.rev : null, base: row ? deepCopy(row.data || {}) : {} };
  editing.imgs = deepCopy(imagesOf(editing.base)); // working copy of the images while editing
  if (!n) { selectedId = null; refreshLinkEmphasis(); }
  renderEditor();
  pingSoon();
}
function cancelEdit() {
  if (!editing || !confirmDiscard()) return;
  editing = null;
  showDetail();
  pingSoon();
}
function renderEditor() {
  const d = $("detail"), base = editing.base;
  d.classList.add("editing");
  const typeSel = el("select", { id: "f-type" }, el("option", { value: "" }, "Choose a type..."));
  const types = ["character", "place", "rule", "thread", "question", "faction", "lore", "chapter"];
  if (base.type && !types.includes(base.type)) types.push(base.type);
  for (const k of types) typeSel.append(el("option", { value: k }, TYPES[k] ? TYPES[k].label : String(k)));
  typeSel.value = base.type || "";
  const nameIn = el("input", { id: "f-name", type: "text", maxlength: LIM.name }); nameIn.value = base.name || "";
  const sumIn = el("textarea", { id: "f-summary", rows: 5, maxlength: LIM.summary }); sumIn.value = base.summary || "";
  const eraSel = el("select", { id: "f-era" }, el("option", { value: "" }, "No era"));
  const known = new Set();
  for (const e of eraList()) { known.add(String(e.id)); eraSel.append(el("option", { value: String(e.id) }, String(e.name || "ERA_TBD"))); }
  if (base.time && base.time.era != null && !known.has(String(base.time.era))) eraSel.append(el("option", { value: String(base.time.era) }, "ERA_TBD (not in the era list)"));
  eraSel.value = base.time && base.time.era != null ? String(base.time.era) : "";
  const ordIn = el("input", { id: "f-order", type: "number", step: "any", placeholder: "optional" });
  ordIn.value = base.time && Number.isFinite(base.time.order) ? base.time.order : "";
  const linksBox = el("div", { id: "f-links" });
  const targets = graph.nodes.filter((x) => x.id !== editing.id).sort((a, b) => a.name.localeCompare(b.name));
  const addLinkRow = (to, label) => {
    const sel = el("select", { "aria-label": "Link target" }, el("option", { value: "" }, "Choose a node..."));
    for (const t of targets) sel.append(el("option", { value: t.id }, t.name));
    if (to && !graph.byId.has(to)) sel.append(el("option", { value: to }, nodeNameById(to)));
    sel.value = to || "";
    const lab = el("input", { type: "text", placeholder: "label (optional)", maxlength: LIM.label, "aria-label": "Link label" }); lab.value = label || "";
    const row = el("div", { class: "lrow" }, sel, lab,
      el("button", { type: "button", class: "quiet", "aria-label": "Remove this link row", onclick: () => row.remove() }, "Remove"));
    linksBox.append(row);
  };
  for (const l of Array.isArray(base.links) ? base.links : []) if (l && l.to) addLinkRow(String(l.to), String(l.label || ""));
  const imgBox = el("div", { id: "f-images", class: "thumbs" });
  const fileIn = el("input", { type: "file", accept: "image/*", multiple: "", hidden: "", id: "f-file", "aria-label": "Choose images to add" });
  const addBtn = el("button", { type: "button", class: "quiet", id: "f-addimg", onclick: () => fileIn.click() }, "Add images");
  const imgNote = el("small", { class: "hint" }, "");
  const drawImgs = () => {
    imgBox.replaceChildren();
    editing.imgs.forEach((im, i) => {
      const cap = el("input", { type: "text", maxlength: 500, placeholder: "caption (optional)", "aria-label": "Caption for image " + (i + 1) });
      cap.value = im.caption || "";
      cap.addEventListener("input", () => { im.caption = cap.value; });
      imgBox.append(el("div", { class: "th" },
        el("img", { src: safeJpeg(im.thumb) ? im.thumb : im.src, alt: im.caption || "Image " + (i + 1) }),
        cap,
        el("button", { type: "button", class: "quiet", "aria-label": "Remove image " + (i + 1), onclick: () => { editing.imgs.splice(i, 1); drawImgs(); } }, "Remove")));
    });
    addBtn.disabled = editing.imgs.length >= MAX_IMAGES;
    imgNote.textContent = editing.imgs.length + " of " + MAX_IMAGES + " images. JPEG, resized to " + IMG_MAX_DIM + " px on the longest side. Removing an image here only removes it from this version; backups keep earlier versions.";
  };
  fileIn.addEventListener("change", async () => {
    const files = [...fileIn.files]; fileIn.value = "";
    addBtn.disabled = true; imgNote.textContent = "Adding images...";
    for (const f of files) {
      if (editing.imgs.length >= MAX_IMAGES) { toast("Up to " + MAX_IMAGES + " images per node.", true); break; }
      try { editing.imgs.push(await processImageFile(f)); }
      catch (e) { toast("Could not read \"" + f.name + "\" as an image.", true); }
    }
    drawImgs();
  });
  drawImgs();
  const fld = (label, ctl, hint) => el("div", { class: "fld" }, el("label", { for: ctl.id }, label), ctl, hint ? el("small", null, hint) : null);
  d.replaceChildren(
    el("h2", null, editing.isNew ? "New node" : "Edit node"),
    el("p", { id: "f-warn", class: "warn", hidden: "" }, ""),
    fld("Type", typeSel), fld("Name", nameIn), fld("Summary", sumIn),
    el("div", { class: "f" }, "Story time"),
    el("div", { class: "two" }, fld("Era", eraSel), fld("Order", ordIn)),
    el("small", { class: "hint" }, "Leave both empty to place it on the outer ring. Order sorts nodes within an era."),
    el("div", { class: "f" }, "Links from this node"),
    linksBox,
    el("button", { type: "button", class: "quiet", onclick: () => addLinkRow("", "") }, "Add a link"),
    el("small", { class: "hint" }, "Links from other nodes are edited on those nodes."),
    el("div", { class: "f" }, "Images"),
    imgBox, addBtn, fileIn, imgNote,
    el("div", { class: "acts" },
      el("button", { type: "button", id: "f-save", onclick: saveEdit }, "Save"),
      el("button", { type: "button", class: "quiet", onclick: cancelEdit }, "Cancel")));
  updateEditWarn();
  d.scrollTop = 0;
  (editing.isNew ? typeSel : nameIn).focus();
}
function collectForm(strict) {
  const data = deepCopy(editing.base);
  const type = $("f-type").value, name = $("f-name").value.trim();
  if (strict && !type) { toast("Choose a type.", true); return null; }
  if (strict && !name) { toast("Give it a name.", true); return null; }
  data.type = type; data.name = name; data.summary = $("f-summary").value;
  const era = $("f-era").value, ordRaw = $("f-order").value.trim(), order = ordRaw === "" ? null : Number(ordRaw);
  if (strict && ordRaw !== "" && !Number.isFinite(order)) { toast("Order must be a number.", true); return null; }
  const hasOrder = order !== null && Number.isFinite(order);
  if (era !== "" || hasOrder) { data.time = {}; if (era !== "") data.time.era = era; if (hasOrder) data.time.order = order; }
  else delete data.time;
  const links = [], seen = new Set();
  for (const row of $("f-links").children) {
    const to = row.querySelector("select").value, label = row.querySelector("input").value.trim();
    if (!to || to === editing.id || seen.has(to + "|" + label)) continue;
    seen.add(to + "|" + label); links.push(label ? { to, label } : { to });
  }
  data.links = links;
  if (editing.imgs.length || Array.isArray(editing.base.images)) data.images = deepCopy(editing.imgs);
  if (strict && JSON.stringify(data).length > 7.5 * 1024 * 1024) { toast("This node is too large to save. Remove an image or two.", true); return null; }
  return data;
}
function editingDirty() {
  if (!editing || !$("f-type")) return false;
  const now = fieldsOf(collectForm(false)), was = fieldsOf(editing.base);
  return FIELDS.some((f) => now[f] !== was[f]);
}
function updateEditWarn() {
  const w = $("f-warn");
  if (!editing || !w) return;
  const row = !editing.isNew && model.rows.get(editing.id);
  if (row && row.rev > editing.baseRev) { w.hidden = false; w.textContent = (byName(row.updated_by) || "Someone else") + " saved this node since you started. If you save, you will be asked how to combine both versions."; }
  else w.hidden = true;
}
function setBusy(b) { const s = $("f-save"); if (s) s.disabled = b; }

async function saveEdit() {
  const data = collectForm(true);
  if (!data) return;
  await attemptSave(editing, data, editing.baseRev);
}
async function attemptSave(ed, data, baseRev) {
  setBusy(true);
  const r = await apiWrite("PUT", "/api/nodes/" + ed.id, ed.isNew ? { data } : { data, base_rev: baseRev });
  setBusy(false);
  if (r.status === 200 && r.json && r.json.node) {
    model.rows.set(r.json.node.id, r.json.node);
    editing = null;
    refreshAll(false);
    select(r.json.node.id);
    toast("Saved.");
  } else if (r.status === 409 && r.json && r.json.current) {
    if (ed.isNew) { ed.id = uid("n_"); attemptSave(ed, data, null); return; }
    showConflict(ed, data, r.json.current);
  } else if (r.status === 404) toast("That node no longer exists on the server. Copy your text out, then reload.", true);
  else writeFailure(r);
}

/* side-by-side conflict dialog */
function showConflict(ed, mine, current) {
  const b = fieldsOf(ed.base), m = fieldsOf(mine), t = fieldsOf(current.data || {});
  const theirName = byName(current.updated_by); // empty in shared-password mode
  const diff = FIELDS.filter((f) => m[f] !== t[f]);
  const choice = {};
  for (const f of diff) { if (m[f] === b[f]) choice[f] = "theirs"; else if (t[f] === b[f]) choice[f] = "mine"; }
  // If both sides only ADDED images (nothing removed or re-captioned), keep everyone's images.
  const combine = new Set();
  if (diff.includes("images") && m.images !== b.images && t.images !== b.images) {
    const untouched = (d) => { const cap = new Map(imagesOf(d).map((i) => [i.id, i.caption || ""])); return imagesOf(ed.base).every((i) => cap.has(i.id) && cap.get(i.id) === (i.caption || "")); };
    if (untouched(mine) && untouched(current.data || {})) { combine.add("images"); choice.images = "combine"; }
  }
  const baseImgIds = new Set(imagesOf(ed.base).map((i) => i.id));
  const mineNew = () => imagesOf(mine).filter((i) => !baseImgIds.has(i.id));
  const real = diff.filter((f) => m[f] !== b[f] && t[f] !== b[f] && !combine.has(f));
  const body = el("div");
  body.append(el("p", { class: "dim" },
    (theirName || "Someone") + " saved this node while you were editing. " + (real.length ? real.length + " field(s) were changed by both of you, so you must choose. " : "You changed different fields, so both sets of changes can be kept. ") +
    "Nothing is saved until you press Apply."));
  if (current.hidden) body.append(el("p", { class: "warn" }, "This node is currently hidden. Saving keeps it hidden."));
  const grid = el("div", { class: "cgrid" });
  grid.append(el("div", { class: "ch" }, "Field"), el("div", { class: "ch" }, "Yours"), el("div", { class: "ch" }, theirName ? "Theirs (" + theirName + ")" : "Theirs (latest)"));
  const cells = {};
  const refresh = () => {
    ui.btns.apply.disabled = !diff.every((f) => choice[f]);
    for (const f of diff) for (const c of cells[f]) c.classList.toggle("need", !choice[f]);
  };
  for (const f of FIELDS) {
    grid.append(el("div", { class: "cl" }, FIELD_LABEL[f]));
    if (m[f] === t[f]) {
      grid.append(el("div", { class: "cc same" }, fieldDisplay(f, mine), el("small", null, "Same in both")), el("div", { class: "cc same" }, fieldDisplay(f, current.data || {})));
      continue;
    }
    if (combine.has(f)) {
      grid.append(el("div", { class: "cc same wide" }, el("div", null,
        fieldDisplay("images", { images: [...imagesOf(current.data || {}), ...mineNew()] }),
        el("small", null, "Both of you added images. All of them are kept."))));
      cells[f] = [];
      continue;
    }
    const mk = (who, data) => {
      const rb = el("input", { type: "radio", name: "c-" + f, "aria-label": FIELD_LABEL[f] + ": keep " + who });
      rb.checked = choice[f] === who;
      rb.addEventListener("change", () => { choice[f] = who; refresh(); });
      const hint = who === "mine" && m[f] !== b[f] && t[f] === b[f] ? "Only you changed this" : who === "theirs" && t[f] !== b[f] && m[f] === b[f] ? "Only " + (theirName || "they") + " changed this" : "";
      return el("label", { class: "cc pick" }, rb, el("div", null, fieldDisplay(f, data), hint ? el("small", null, hint) : null));
    };
    const cm = mk("mine", mine), ct = mk("theirs", current.data || {});
    cells[f] = [cm, ct];
    grid.append(cm, ct);
  }
  body.append(grid);
  const setAll = (who) => { for (const f of diff) { if (combine.has(f)) continue; choice[f] = who; for (const rb of grid.querySelectorAll('input[name="c-' + f + '"]')) rb.checked = (rb.getAttribute("aria-label").endsWith("keep " + who)); } refresh(); };
  const ui = openModal("Two versions of this node", body, [
    { id: "apply", label: "Apply and save", kind: "primary", onclick: async () => {
      const result = deepCopy(current.data || {});
      let usesMine = false;
      for (const f of diff) {
        if (choice[f] === "mine") { setField(result, f, mine); usesMine = true; }
        else if (choice[f] === "combine") { result.images = deepCopy([...(Array.isArray(result.images) ? result.images : []), ...mineNew()]); usesMine = true; }
      }
      closeModal();
      if (!usesMine) {
        model.rows.set(current.id, current); editing = null; refreshAll(false); select(current.id); toast("Kept the latest version. Your edits were not saved.");
        return;
      }
      ed.base = deepCopy(current.data || {}); ed.baseRev = current.rev;
      await attemptSave(ed, result, current.rev);
    } },
    { id: "mine", label: "All mine", kind: "quiet", onclick: () => setAll("mine") },
    { id: "theirs", label: "All theirs", kind: "quiet", onclick: () => setAll("theirs") },
    { id: "back", label: "Back to editing", kind: "quiet", onclick: closeModal },
  ], { wide: true, sticky: true });
  refresh();
}

/* hide and unhide: the only forms of removal, always reversible */
function askHide(n) {
  const row = model.rows.get(n.id);
  openModal("Hide this node?", el("p", null, "\"" + n.name + "\" will disappear from the map. Nothing is erased: you can unhide it from the Hidden list, and links to it come back with it."), [
    { label: "Hide it", kind: "primary", onclick: async () => {
      closeModal();
      const r = await apiWrite("POST", "/api/nodes/" + n.id + "/hide", { base_rev: row.rev });
      if (r.status === 200 && r.json && r.json.node) { model.rows.set(n.id, r.json.node); select(null); refreshAll(false); toast("Hidden. Find it under Hidden to unhide."); }
      else if (r.status === 409 && r.json && r.json.current) { model.rows.set(n.id, r.json.current); refreshAll(false); toast("Someone changed this node first. Review it, then try again.", true); }
      else writeFailure(r);
    } },
    { label: "Cancel", kind: "quiet", onclick: closeModal },
  ]);
}
function openHiddenList() {
  const rows = [...model.rows.values()].filter((r) => r.hidden).sort((a, b) => String((a.data || {}).name || a.id).localeCompare(String((b.data || {}).name || b.id)));
  const ul = el("ul", { class: "hl" });
  if (!rows.length) ul.append(el("li", { class: "dim" }, "Nothing is hidden."));
  for (const r of rows) {
    ul.append(el("li", null, el("span", null, String((r.data || {}).name || r.id)),
      el("button", { type: "button", onclick: async () => {
        const res = await apiWrite("POST", "/api/nodes/" + r.id + "/unhide", { base_rev: r.rev });
        if (res.status === 200 && res.json && res.json.node) { model.rows.set(r.id, res.json.node); refreshAll(false); toast("Unhidden."); openHiddenList(); }
        else if (res.status === 409 && res.json && res.json.current) { model.rows.set(r.id, res.json.current); refreshAll(false); toast("Someone changed this node first. Try again.", true); openHiddenList(); }
        else writeFailure(res);
      } }, "Unhide")));
  }
  openModal("Hidden nodes", ul, [{ label: "Close", kind: "quiet", onclick: closeModal }]);
}

/* eras: add, rename and reorder. They cannot be deleted here. */
function openErasEditor() {
  const meta = model.meta.get("eras");
  let list = eraList().map((e) => ({ id: String(e.id), name: String(e.name || "") }));
  const box = el("div");
  const draw = () => {
    box.replaceChildren(el("p", { class: "dim" }, "Eras run from the left end of the flow to the right, in this order. They can be renamed and reordered, not deleted."));
    list.forEach((e, i) => {
      const inp = el("input", { type: "text", maxlength: LIM.era, placeholder: "Era name", "aria-label": "Era " + (i + 1) + " name" }); inp.value = e.name;
      inp.addEventListener("input", () => { e.name = inp.value; });
      const mv = (dir) => () => { const j = i + dir; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; draw(); };
      const up = el("button", { type: "button", class: "quiet", "aria-label": "Move era up", onclick: mv(-1) }, "Up");
      const dn = el("button", { type: "button", class: "quiet", "aria-label": "Move era down", onclick: mv(1) }, "Down");
      up.disabled = i === 0; dn.disabled = i === list.length - 1;
      box.append(el("div", { class: "lrow era" }, el("span", { class: "n" }, String(i + 1)), inp, up, dn));
    });
    if (!list.length) box.append(el("p", { class: "dim" }, "No eras yet."));
    box.append(el("button", { type: "button", class: "quiet", onclick: () => { list.push({ id: uid("era_"), name: "" }); draw(); const ins = box.querySelectorAll("input"); ins[ins.length - 1].focus(); } }, "Add an era"));
  };
  draw();
  openModal("Eras", box, [
    { label: "Save eras", kind: "primary", onclick: async () => {
      const clean = list.map((e) => ({ id: e.id, name: e.name.trim() }));
      if (clean.some((e) => !e.name)) { toast("Every era needs a name.", true); return; }
      const r = await apiWrite("PUT", "/api/meta/eras", meta ? { data: { eras: clean }, base_rev: meta.rev } : { data: { eras: clean } });
      if (r.status === 200 && r.json && r.json.meta) { model.meta.set("eras", r.json.meta); closeModal(); refreshAll(false); toast("Eras saved."); }
      else if (r.status === 409 && r.json && r.json.current) { model.meta.set("eras", r.json.current); closeModal(); refreshAll(false); toast("Someone changed the eras first. Reloaded the latest, please redo your change.", true); }
      else writeFailure(r);
    } },
    { label: "Cancel", kind: "quiet", onclick: closeModal },
  ], { wide: true });
}
$("newNode").addEventListener("click", () => startEdit(null));
$("erasBtn").addEventListener("click", openErasEditor);
$("hiddenBtn").addEventListener("click", openHiddenList);

/* import: load nodes from a seed file, with a full preview first. Skips anything already there. */
const SEED_FORMAT = "throat-seed-v1", SEED_MAX = 300;
function parseSeed(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return { error: "That file is not valid JSON." }; }
  if (!obj || obj.format !== SEED_FORMAT || !Array.isArray(obj.nodes)) return { error: "That is not a Throat seed file (expected format \"" + SEED_FORMAT + "\")." };
  if (obj.nodes.length > SEED_MAX) return { error: "Too many nodes (" + obj.nodes.length + "). The limit is " + SEED_MAX + " per file." };
  const problems = [], seen = new Set(), items = [];
  obj.nodes.forEach((n, i) => {
    const where = "Node " + (i + 1) + (n && typeof n.name === "string" ? " (" + n.name.slice(0, 40) + ")" : "");
    if (!n || typeof n !== "object") return problems.push(where + ": not an object");
    if (typeof n.id !== "string" || !/^[0-9A-Za-z_\-]{1,64}$/.test(n.id)) return problems.push(where + ": id missing or invalid");
    if (seen.has(n.id)) return problems.push(where + ": duplicate id " + n.id);
    seen.add(n.id);
    if (typeof n.type !== "string" || !TYPES[n.type]) return problems.push(where + ": unknown type \"" + n.type + "\"");
    if (typeof n.name !== "string" || !n.name.trim() || n.name.length > LIM.name) return problems.push(where + ": name missing or over " + LIM.name + " characters");
    const summary = n.summary == null ? "" : n.summary;
    if (typeof summary !== "string" || summary.length > LIM.summary) return problems.push(where + ": summary is not text or is over " + LIM.summary + " characters");
    items.push({ id: n.id, type: n.type, name: n.name, summary, exists: model.rows.has(n.id) });
  });
  return { items, problems };
}
function openImport() {
  let items = [], running = false;
  const fileIn = el("input", { type: "file", accept: ".json,application/json", id: "imp-file", "aria-label": "Choose a seed file" });
  const out = el("div", { class: "imp" }, el("p", { class: "dim" }, "Choose a seed file (.json). You will see exactly what it contains before anything is saved. Nodes that already exist are skipped, so importing twice is safe."));
  fileIn.addEventListener("change", async () => {
    items = []; ui.btns.go.disabled = true;
    const f = fileIn.files[0];
    if (!f) return;
    let text = "";
    try { text = await f.text(); } catch (e) { out.replaceChildren(el("p", { class: "warn" }, "Could not read that file.")); return; }
    const r = parseSeed(text);
    if (r.error) { out.replaceChildren(el("p", { class: "warn" }, r.error)); return; }
    items = r.items;
    const fresh = items.filter((x) => !x.exists).length;
    const table = el("div", { class: "imptable" });
    for (const x of items) {
      table.append(el("div", { class: "improw" + (x.exists ? " skip" : "") },
        el("span", { class: "chip cin", style: "color:" + TYPES[x.type].hex }, TYPES[x.type].label),
        el("span", { class: "in", title: x.summary.slice(0, 200) }, x.name),
        el("small", null, x.summary.length + " chars"),
        el("small", { class: "st" }, x.exists ? "already there, skipped" : "new")));
    }
    // filter(Boolean): replaceChildren would print the word "null" for a missing child
    out.replaceChildren(...[
      el("p", null, items.length + " nodes in the file: " + fresh + " new, " + (items.length - fresh) + " already there."),
      r.problems.length ? el("div", { class: "warn" }, el("p", null, r.problems.length + " problem(s). These nodes will NOT be imported:"), el("ul", null, ...r.problems.slice(0, 8).map((p) => el("li", null, p)))) : null,
      table,
    ].filter(Boolean));
    ui.btns.go.disabled = fresh === 0;
  });
  async function run() {
    if (running) return;
    running = true; ui.btns.go.disabled = true; fileIn.disabled = true;
    const todo = items.filter((x) => !x.exists);
    let made = 0, skipped = 0;
    const failed = [], status = el("p", { role: "status" }, "");
    out.prepend(status);
    for (let i = 0; i < todo.length; i++) {
      const x = todo[i];
      status.textContent = "Importing " + (i + 1) + " of " + todo.length + ": " + x.name;
      const r = await apiWrite("PUT", "/api/nodes/" + x.id, { data: { type: x.type, name: x.name, summary: x.summary } });
      if (r.status === 200 && r.json && r.json.node) { model.rows.set(r.json.node.id, r.json.node); made++; }
      else if (r.status === 409) skipped++;
      else if (r.status === 401) { failed.push("Your sign-in ended. Sign in again in a new tab, then run the import again (nodes already imported are skipped)."); break; }
      else failed.push(x.name + ": " + ((r.json && r.json.message) || "the server refused it"));
    }
    refreshAll(false);
    if (made) { cam.dist = HOME.dist; goal.copy(centroid()); } // re-fit the view to the new nodes
    status.textContent = "Done. " + made + " imported" + (skipped ? ", " + skipped + " already there" : "") + (failed.length ? ", " + failed.length + " failed." : ".");
    if (failed.length) out.prepend(el("div", { class: "warn" }, el("ul", null, ...failed.map((p) => el("li", null, p)))));
    toast(made + " node(s) imported.", failed.length > 0);
    running = false;
  }
  const ui = openModal("Import nodes", el("div", null, fileIn, out), [
    { id: "go", label: "Import", kind: "primary", onclick: run },
    { label: "Close", kind: "quiet", onclick: () => { if (!running) closeModal(); } },
  ], { wide: true, sticky: true });
  ui.btns.go.disabled = true;
}
$("importBtn").addEventListener("click", openImport);

/* export: read-only copies of everything, made in the browser from what is already loaded.
 * Nothing here writes to the server. The readable copy (.md) is for reading and keeping;
 * the full backup (.json) is the server's own archive and is the one to restore from. */
const mdEsc = (s) => String(s == null ? "" : s).replace(/</g, "\\<").replace(/^(\s*)#/gm, "$1\\#"); // no stray HTML or headings from user text
const utcStamp = (d) => (isFinite(d) ? d.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "");
const todayStamp = () => new Date().toISOString().slice(0, 10);
function buildMarkdown() {
  const rows = [...model.rows.values()];
  const visible = rows.filter((r) => !r.hidden), hiddenRows = rows.filter((r) => r.hidden);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const dataOf = (r) => r.data || {};
  const nameOf = (r) => String(dataOf(r).name || r.id);
  const typeOf = (r) => (TYPES[dataOf(r).type] ? dataOf(r).type : "other");
  const linksOf = (r) => (Array.isArray(dataOf(r).links) ? dataOf(r).links.filter((l) => l && byId.has(l.to)) : []);
  const incoming = new Map();
  for (const r of rows) for (const l of linksOf(r)) { if (!incoming.has(l.to)) incoming.set(l.to, []); incoming.get(l.to).push({ from: r, label: l.label || "" }); }
  const tag = (r) => (r.hidden ? " (hidden)" : "");
  const byAlpha = (a, b) => nameOf(a).localeCompare(nameOf(b));
  const out = [];
  out.push("# THE THROAT: readable copy", "",
    "Saved: " + utcStamp(new Date()), "",
    visible.length + " nodes" + (hiddenRows.length ? ", plus " + hiddenRows.length + " hidden" : "") + ".", "",
    "This is a readable copy, not a restore point. To restore, use the full backup (.json) from the Export menu. Images are not included here; each node says how many it has.", "");
  out.push("## Eras", "");
  const eras = eraList();
  if (!eras.length) out.push("No eras defined yet.", "");
  else { eras.forEach((e, i) => out.push((i + 1) + ". " + mdEsc(e.name || "ERA_TBD"))); out.push(""); }
  const nodeMd = (r) => {
    const d = dataOf(r), L = [];
    L.push("### " + mdEsc(nameOf(r)), "", "- Type: " + TYPES[typeOf(r)].label);
    if (r.hidden) L.push("- Hidden: yes");
    if (hasTime(d)) {
      const parts = [];
      if (d.time.era != null) parts.push(mdEsc(eraName(d.time.era)));
      if (Number.isFinite(d.time.order)) parts.push("order " + d.time.order);
      L.push("- Story time: " + parts.join(", "));
    } else L.push("- Story time: none yet (outer ring)");
    L.push("- Last changed: " + utcStamp(new Date(r.updated_at)) + byText(r.updated_by));
    const to = linksOf(r);
    if (to.length) L.push("- Links to: " + to.map((l) => mdEsc(nameOf(byId.get(l.to))) + tag(byId.get(l.to)) + (l.label ? " (" + mdEsc(l.label) + ")" : "")).join("; "));
    const from = incoming.get(r.id) || [];
    if (from.length) L.push("- Linked from: " + from.map((x) => mdEsc(nameOf(x.from)) + tag(x.from) + (x.label ? " (" + mdEsc(x.label) + ")" : "")).join("; "));
    const ims = Array.isArray(d.images) ? d.images : [];
    if (ims.length) L.push("- Images: " + ims.length + " (not in this file; they are in the full backup). Captions: " + ims.map((i) => (i && i.caption ? "\"" + mdEsc(i.caption) + "\"" : "(none)")).join("; "));
    L.push("", d.summary ? mdEsc(d.summary) : "_No summary yet._", "");
    return L;
  };
  for (const k of TYPE_ORDER) {
    const group = visible.filter((r) => typeOf(r) === k).sort(byAlpha);
    if (!group.length) continue;
    out.push("## " + TYPES[k].label + " (" + group.length + ")", "");
    for (const r of group) out.push(...nodeMd(r));
  }
  if (hiddenRows.length) {
    out.push("## Hidden nodes (" + hiddenRows.length + ")", "", "These are hidden from the map but nothing was erased.", "");
    for (const r of hiddenRows.sort(byAlpha)) out.push(...nodeMd(r));
  }
  out.push("---", "End of copy: " + rows.length + " nodes in total.", "");
  return out.join("\n");
}
function downloadFile(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const kb = (n) => (n < 1024 * 100 ? Math.max(1, Math.round(n / 1024)) + " KB" : (n / 1048576).toFixed(1) + " MB");
function openExport() {
  const total = model.rows.size, hid = [...model.rows.values()].filter((r) => r.hidden).length;
  const status = el("p", { role: "status", class: "dim" }, "");
  openModal("Export a copy", el("div", { class: "expbody" },
    el("p", null, "Both copies are made from what is on the site right now (" + total + " nodes" + (hid ? ", " + hid + " hidden" : "") + "). Nothing on the site is changed."),
    el("p", null, el("strong", null, "Readable copy (.md): "), "one file you can read and search in any notes app. Every node with its text, story time, links and who changed it last. Images are listed by count and caption, not included. It cannot restore the map."),
    el("p", null, el("strong", null, "Full backup (.json): "), "everything, including images and every automatic backup, so it grows as you add images. This is the one to restore from."),
    status), [
    { id: "md", label: "Download readable copy (.md)", kind: "primary", onclick: () => {
      try {
        const md = buildMarkdown(), blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
        downloadFile("throat-copy-" + todayStamp() + ".md", blob);
        status.textContent = "Saved throat-copy-" + todayStamp() + ".md (" + kb(blob.size) + ", " + total + " nodes). Check your Downloads folder.";
      } catch (e) { status.textContent = "Could not make the copy: " + e.message; }
    } },
    { id: "json", label: "Download full backup (.json)", onclick: async () => {
      status.textContent = "Preparing the full backup...";
      try {
        const r = await fetch("/api/backups/archive", { headers: { Accept: "application/json" } });
        if (r.status === 401) { status.textContent = "Your sign-in ended. Sign in again in a new tab, then try again."; return; }
        if (!r.ok) { status.textContent = "The server could not make the backup (error " + r.status + "). Nothing was changed."; return; }
        const blob = await r.blob();
        downloadFile("throat-full-backup-" + todayStamp() + ".json", blob);
        status.textContent = "Saved throat-full-backup-" + todayStamp() + ".json (" + kb(blob.size) + "). Check your Downloads folder.";
      } catch (e) { status.textContent = "Could not reach the server. Nothing was changed."; }
    } },
    { label: "Close", kind: "quiet", onclick: closeModal },
  ], { wide: true });
}
$("exportBtn").addEventListener("click", openExport);

/* history: list the backups, preview one against the site right now, and restore either one
 * node or the whole map. Everything goes through the server's existing, tested backup and save
 * calls. A backup of the current state is always made first, and nothing is ever erased. */
const REASON_LABEL = { periodic: "Automatic", before_hide: "Before a hide", before_restore: "Before a restore", manual: "Made by hand" };
const backupWhen = (iso) => { const d = new Date(iso); return isFinite(d) ? d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : String(iso); };
function planMessage(r, what) {
  if (r.status === 401) return "Your sign-in ended. Sign in again in a new tab, then try again. Nothing was changed.";
  if (r.status === 404) return "That backup no longer exists. Nothing was changed.";
  if (r.status === 0) return "Could not reach the server. Nothing was changed.";
  return "The server could not " + what + " (error " + r.status + "). Nothing was changed.";
}
async function openHistory() {
  const list = el("div", { class: "hist" }, el("p", { class: "dim", style: "padding:10px 12px;margin:0" }, "Loading backups..."));
  const status = el("p", { role: "status", class: "dim" }, "");
  const ui = openModal("History", el("div", null,
    el("p", null, "Every backup of the whole map, newest first. Preview one to see exactly how it differs from the site right now before anything can be restored. Nothing here changes the story until you confirm."),
    list, status), [
    { id: "now", label: "Back up now", kind: "primary", onclick: async () => {
      ui.btns.now.disabled = true; status.textContent = "Making a backup...";
      const r = await apiWrite("POST", "/api/backups", {});
      if (r.status === 200) { status.textContent = "Backup saved."; await fill(); }
      else status.textContent = planMessage(r, "make a backup");
      ui.btns.now.disabled = false;
    } },
    { label: "Close", kind: "quiet", onclick: closeModal },
  ], { wide: true });
  async function fill() {
    const r = await apiRead("/api/backups");
    if (r.status !== 200 || !r.json) { list.replaceChildren(el("p", { class: "warn", style: "margin:8px" }, planMessage(r, "load the backups"))); return; }
    const rows = r.json.backups || [];
    if (!rows.length) { list.replaceChildren(el("p", { class: "dim", style: "padding:10px 12px;margin:0" }, "No backups yet. One is made automatically the first time something is saved after ten quiet minutes, or press Back up now.")); return; }
    list.replaceChildren(...rows.slice(0, 200).map((b) => el("div", { class: "hrow" + (b.reason === "before_restore" ? " undo" : "") },
      el("div", null, el("strong", null, backupWhen(b.created_at)), el("small", null, relTime(b.created_at) + (b.reason === "before_restore" ? ", use it to undo a restore" : ""))),
      el("div", null, REASON_LABEL[b.reason] || b.reason),
      el("div", null, byName(b.created_by) || ""),
      el("small", { class: "hc" }, b.node_count + " nodes"),
      el("button", { type: "button", "aria-label": "Preview the backup from " + backupWhen(b.created_at), onclick: () => openPreview(b) }, "Preview"))));
    if (rows.length > 200) list.append(el("p", { class: "dim", style: "padding:8px 12px;margin:0" }, "Showing the newest 200 of " + rows.length + " backups."));
  }
  fill();
}
// How a backup differs from the site right now. Nothing is ever erased, so every backed-up node still exists.
function diffAgainst(snap) {
  const snapIds = new Set(snap.nodes.map((n) => n.id));
  const changed = [], created = [];
  let same = 0;
  for (const n of snap.nodes) {
    const row = model.rows.get(n.id);
    if (!row) continue;
    const a = fieldsOf(n.data || {}), b = fieldsOf(row.data || {});
    const fields = FIELDS.filter((f) => a[f] !== b[f]);
    const hid = !!n.hidden !== !!row.hidden;
    if (fields.length || hid) changed.push({ id: n.id, then: n, now: row, fields, hid }); else same++;
  }
  for (const row of model.rows.values()) if (!snapIds.has(row.id)) created.push(row);
  const eras = (d) => JSON.stringify((d && Array.isArray(d.eras) ? d.eras : []).map((e) => [String(e.id), String(e.name || "")]));
  const sEras = (snap.meta || []).find((m) => m.key === "eras"), cEras = model.meta.get("eras");
  return { same, changed, created, erasChanged: eras(sEras && sEras.data) !== eras(cEras && cEras.data) };
}
const diffSig = (d) => JSON.stringify([d.changed.map((c) => [c.id, c.now.rev]), d.created.map((r) => [r.id, r.rev]), d.erasChanged]);
const nodeNameOf = (data, fallback) => String((data && data.name) || fallback);
async function openPreview(b) {
  const wrap = el("div", null, el("p", { class: "dim" }, "Loading this backup..."));
  openModal("Backup from " + backupWhen(b.created_at), wrap, [
    { label: "Back to the list", kind: "quiet", onclick: openHistory },
    { label: "Close", kind: "quiet", onclick: closeModal },
  ], { wide: true });
  const r = await apiRead("/api/backups/" + encodeURIComponent(b.id));
  if (r.status !== 200 || !r.json || !r.json.data || !Array.isArray(r.json.data.nodes)) { wrap.replaceChildren(el("p", { class: "warn" }, planMessage(r, "load that backup"))); return; }
  const snap = r.json.data;
  let shown = null; // signature of what the person is looking at, to catch the map changing under them
  const render = (note) => {
    const d = diffAgainst(snap);
    shown = diffSig(d);
    const parts = [];
    if (note) parts.push(el("p", { class: "warn" }, note));
    parts.push(el("p", { class: "sum" }, "Made " + backupWhen(b.created_at) + " (" + (REASON_LABEL[b.reason] || b.reason) + (byName(b.created_by) ? ", by " + byName(b.created_by) : "") + "). It holds " + snap.nodes.length + " nodes."));
    parts.push(el("p", { class: "sum" }, "Compared with the site right now: " + d.same + " identical, " + d.changed.length + " changed since, " + d.created.length + " created since" + (d.erasChanged ? ", and the eras differ." : ".")));
    parts.push(el("h3", null, "Changed since this backup (" + d.changed.length + ")"));
    if (!d.changed.length) parts.push(el("p", { class: "dim" }, "None. Every node in this backup matches the site right now."));
    for (const c of d.changed) {
      const grid = el("div", { class: "cgrid" }, el("div", { class: "ch" }, "Field"), el("div", { class: "ch" }, "In this backup"), el("div", { class: "ch" }, "Right now"));
      for (const f of c.fields) grid.append(el("div", { class: "cl" }, FIELD_LABEL[f]), el("div", { class: "cc" }, fieldDisplay(f, c.then.data || {})), el("div", { class: "cc" }, fieldDisplay(f, c.now.data || {})));
      if (c.hid) grid.append(el("div", { class: "cl" }, "Hidden"), el("div", { class: "cc" }, c.then.hidden ? "Hidden" : "Visible"), el("div", { class: "cc" }, c.now.hidden ? "Hidden" : "Visible"));
      const thenName = nodeNameOf(c.then.data, c.id), nowName = nodeNameOf(c.now.data, c.id);
      parts.push(el("div", { class: "pvrow" },
        el("div", { class: "top" },
          el("div", { class: "cn" }, nowName + (thenName !== nowName ? " (was \"" + thenName + "\")" : ""),
            el("div", { class: "chips" }, ...c.fields.map((f) => el("span", null, FIELD_LABEL[f])), c.hid ? el("span", null, "Hidden state") : null)),
          el("button", { type: "button", "aria-label": "Restore " + nowName + " to this backup's version", onclick: () => restoreOneNode(b, snap, c, render) }, "Restore this version")),
        el("details", null, el("summary", null, "Show the differences"), grid)));
    }
    parts.push(el("h3", null, "Created since this backup (" + d.created.length + ")"));
    if (!d.created.length) parts.push(el("p", { class: "dim" }, "None."));
    else parts.push(el("ul", { class: "pvnames" }, ...d.created.map((row) => el("li", null, nodeNameOf(row.data, row.id) + (row.hidden ? " (hidden)" : "")))));
    // whole-map restore, behind a typed word
    const input = el("input", { type: "text", id: "restore-word", "aria-label": "Type RESTORE to confirm", autocomplete: "off", placeholder: "RESTORE" });
    const go = el("button", { type: "button", disabled: "" }, "Restore the whole map");
    input.addEventListener("input", () => { go.disabled = input.value !== "RESTORE"; });
    go.addEventListener("click", () => restoreWholeMap(b, snap, shown, render));
    parts.push(el("div", { class: "pvbox" },
      el("strong", null, "Restore the whole map to this backup"),
      el("p", { class: "sum" }, "This puts " + d.changed.length + " changed node(s) back to the version in this backup" + (d.erasChanged ? ", restores the eras," : "") + " and hides " + d.created.length + " node(s) created since (hidden, never erased)."),
      el("p", { class: "sum" }, "A backup of the site right now is made first, labeled \"Before a restore\", so you can undo this from the History list."),
      el("p", { class: "sum" }, "To go ahead, type RESTORE:"), input, go));
    wrap.replaceChildren(...parts);
  };
  render("");
}
async function restoreOneNode(b, snap, c, rerender) {
  if (editing) { toast("Finish or cancel your open edit first, then try again.", true); return; }
  const cur = model.rows.get(c.id), name = nodeNameOf(c.now.data, c.id);
  if (!cur) return;
  if (!confirm("Restore \"" + name + "\" to the version from " + backupWhen(b.created_at) + "?\n\nA backup of the site right now is made first, so its current version is kept.")) return;
  const safe = await apiWrite("POST", "/api/backups", {});
  if (safe.status !== 200) { toast("Could not make the safety backup first, so nothing was changed.", true); return; }
  const r1 = await apiWrite("PUT", "/api/nodes/" + c.id, { data: deepCopy(c.then.data || {}), base_rev: cur.rev });
  if (r1.status === 409 && r1.json && r1.json.current) { model.rows.set(c.id, r1.json.current); refreshAll(false); toast("Someone changed this node first. The preview was refreshed. Review it and try again.", true); rerender(""); return; }
  if (r1.status !== 200 || !r1.json || !r1.json.node) { writeFailure(r1); return; }
  model.rows.set(c.id, r1.json.node);
  if (!!c.then.hidden !== !!r1.json.node.hidden) { // its hidden state comes back too
    const r2 = await apiWrite("POST", "/api/nodes/" + c.id + (c.then.hidden ? "/hide" : "/unhide"), { base_rev: r1.json.node.rev });
    if (r2.status === 200 && r2.json && r2.json.node) model.rows.set(c.id, r2.json.node);
    else toast("The text came back, but its hidden state could not be changed. Nothing was lost.", true);
  }
  refreshAll(false);
  toast("Restored \"" + name + "\" from the backup.");
  rerender("");
}
async function restoreWholeMap(b, snap, shownSig, rerender) {
  if (editing) { toast("Finish or cancel your open edit first, then try again.", true); return; }
  if (diffSig(diffAgainst(snap)) !== shownSig) { rerender("The map changed while you were reading. Please review the new comparison, then type RESTORE again. Nothing was restored."); return; }
  const r = await apiWrite("POST", "/api/backups/" + encodeURIComponent(b.id) + "/restore", {});
  if (r.status !== 200 || !r.json || !r.json.state) { toast(planMessage(r, "restore"), true); return; }
  applyState(r.json.state);
  refreshAll(false);
  openModal("Restored", el("div", null,
    el("p", null, "The whole map is back to the backup from " + backupWhen(b.created_at) + "."),
    el("p", { class: "dim" }, "Nothing was erased. Nodes created after that backup are hidden (see the Hidden list). A backup of how things were just before is saved as \"Before a restore\". To undo this, open History, preview that backup, and restore it.")), [
    { label: "Open History", kind: "primary", onclick: openHistory },
    { label: "Close", kind: "quiet", onclick: closeModal },
  ]);
  toast("Restored.");
}
$("historyBtn").addEventListener("click", openHistory);

/* story chat (stage 2): talk about the nodes you choose. Groq by default; OpenAI only after you confirm the cost.
 * Nothing here changes the map, and the conversation lives in this tab only. Keys never reach the browser (see ai.js). */
const CHAT_MAX_OUT = 1500, CHAT_ANSWER_MAX_OUT = 3000, PICK_MAX_OUT = 600, FULL_MAX_CHARS = 30000;
const ANSWER_SYSTEM = "You are a careful story analyst and editor's assistant for The Throat, a writer's collaborative worldbuilding map. " +
  "You are given an INDEX of every node (id, type, name, story time, links and a short snippet) and the FULL TEXT of some of the nodes. " +
  "Use only that and what the writer says in this conversation. Never invent facts, names, places, rules or events. If something is not in the text you were given, say so. " +
  "If you only have a snippet of a node, say that you only have a snippet instead of guessing what the rest says. When you quote, quote exactly. " +
  "Reply with ONLY a JSON object and no other text: {\"reply\":\"your answer to the writer, plain text, short paragraphs\",\"proposals\":[...]}. " +
  "Use proposals only when the writer asks you to create, add to or change something, or pastes material that belongs in the map. Otherwise proposals is []. " +
  "Proposals never change the map by themselves: the writer reviews and ticks each one. Kinds: " +
  "1) {\"kind\":\"create\",\"temp_id\":\"new1\",\"type\":\"character|place|rule|thread|question|faction|lore|chapter|other\",\"name\":\"...\",\"summary\":\"...\",\"links\":[{\"to\":\"<node id or temp_id>\",\"label\":\"...\"}],\"time\":null,\"quote\":\"...\"}. " +
  "2) {\"kind\":\"patch\",\"id\":\"<id>\",\"append\":\"<new information to add after the existing summary, or an empty string>\",\"add_links\":[{\"to\":\"<node id or temp_id>\",\"label\":\"...\"}],\"time\":null,\"quote\":\"...\"}. " +
  "3) {\"kind\":\"replace\",\"id\":\"<id>\",\"find\":\"<exact text copied from that node's summary>\",\"with\":\"<new wording>\",\"quote\":\"...\"}. " +
  "Rules: every proposal needs a \"quote\" copied exactly, word for word, from the writer's message or from a node's text, that supports it. " +
  "patch and replace may only target nodes whose FULL TEXT is shown below. A replace's \"find\" must be copied exactly from that node's summary and appear there once. Keep each replacement as small as possible. " +
  "Never rename or retype a node, and do not repeat what a node already says. Leave \"time\" as null unless the text clearly states where the node sits in the story; if it does, use {\"era\":\"<an era id from the list given>\",\"order\":<number>}. " +
  "If the writer asks you to change a node you only have a snippet of, say you need its full text and propose nothing. At most 25 proposals.";
const PICK_SYSTEM = "You help a story-map chat decide which nodes' full text is needed to answer the writer. Reply with ONLY a JSON object and no other text: {\"node_ids\":[\"id\", ...],\"why\":\"...\"}. " +
  "Choose ids from the index, at most 12: nodes the writer names or implies, nodes they want changed or linked to, and closely linked nodes when relevant. If the index alone is enough, return an empty list.";
const chat = { open: false, mode: "groq", tray: [], msgs: [], busy: false, status: null, ack: { set: new Set(), choice: "send" } };
const usd = (n) => "$" + (n < 0.01 ? n.toFixed(4) : n.toFixed(3));
const wordCount = (s) => (String(s).trim().match(/\S+/g) || []).length;

/* A rough local word check, run in this browser before anything is sent. It only warns: it never blocks and never edits on its own. */
const EXPLICIT_STRONG = /\b(?:orgasm\w*|intercourse|genital\w*|penis|vagina\w*|clitoris|erection|masturbat\w*|erotic\w*|porn\w*|blowjob\w*|fellatio|cunnilingus|cumming|ejaculat\w*)\b/gi;
const EXPLICIT_WEAK = /\b(?:naked|nude|nudity|breasts?|nipples?|moan\w*|arous\w*|undress\w*|lust\w*|thighs?|groan\w*)\b/gi;
function scanExplicit(text) {
  const out = [];
  for (const s of String(text).match(/[^.!?\n]+[.!?]*/g) || []) {
    const strong = (s.match(EXPLICIT_STRONG) || []).length, weak = (s.match(EXPLICIT_WEAK) || []).length;
    if (strong >= 1 || weak >= 2) out.push(s.trim());
  }
  return out;
}
const maskText = (text, sents) => sents.reduce((t, s) => t.split(s).join("[passage withheld]"), String(text));

function nodeBlock(n, mask) {
  const links = (Array.isArray(n.raw.links) ? n.raw.links : []).map((l) => { const t = l && graph.byId.get(l.to); return t ? t.name + (l.label ? " (" + l.label + ")" : "") : null; }).filter(Boolean);
  const body = mask ? maskText(n.name + "\n" + (n.summary || ""), scanExplicit(n.name + ". " + n.summary)) : n.name + "\n" + (n.summary || "");
  const [name, ...rest] = body.split("\n");
  return "[NODE id=" + n.id + "] " + TYPES[n.type].label + ": " + name + "\n" + (rest.join("\n").trim() || "(no summary)") +
    (n.u != null ? "\nStory time: " + whenText(n) : "") + (links.length ? "\nLinked to: " + links.join("; ") : "");
}
const trayNodes = () => chat.tray.map((id) => graph.byId.get(id)).filter(Boolean);
const nodeChars = (n) => n.name.length + (n.summary || "").length + 60;

// Resolves with the id of the button pressed, or "cancel" if the dialog is dismissed.
function choose(title, body, buttons) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (done) return; done = true; resolve(v); closeModal(); };
    openModal(title, body, buttons.map((b) => ({ id: b.id, label: b.label, kind: b.kind, onclick: () => fin(b.id) })),
      { wide: true, onClose: () => { if (!done) { done = true; resolve("cancel"); } } });
  });
}

const ANALYSES = {
  story: { label: "Story synthesis", focus: "the whole story",
    ask: "Write a story synthesis. Use these sections: Premise, World and rules, Threads and tensions, Gaps and open questions." },
  characters: { label: "Character analysis", focus: "the characters",
    ask: "Write a character synthesis and analysis. Give each character their own section with these findings where the text supports them: Role, What they want (as stated), Relationships (use the links and the text), Contradictions, Gaps in what is known. End with a section called How they connect." },
  conflict: { label: "Conflict analysis", focus: "the conflicts between the shared nodes",
    ask: "Analyse the conflicts between the shared nodes. Use these sections: Where they collide, What is at stake, What is unresolved, What the text does not say." },
  arc: { label: "Arc analysis", focus: "the arc of the story",
    ask: "Analyse the story's arc. The nodes with story time are listed in story order, then the nodes without. Use these sections: Setup, Rising tensions, Turning points the text states, Ticking clocks, Gaps in the sequence, Material without story time." },
};
const chatLog = el("div", { class: "clog", role: "log", "aria-live": "polite" });
const chatIn = el("textarea", { id: "chatIn", rows: "3", placeholder: "Ask about your map, or paste text for me to file in it...", "aria-label": "Message to the story chat" });
const chatSize = el("p", { class: "csize dim" });
const chatStatus = el("p", { class: "cstat dim", role: "status" });
const chatTray = el("div", { class: "ctray" });
const chatModes = el("div", { class: "cmodes", role: "group", "aria-label": "Which AI to use" });
const chatSendBtn = el("button", { type: "button", class: "primary", onclick: () => chatSend() }, "Send");
const chatAddSel = el("button", { type: "button", onclick: () => chatAdd(selectedId) }, "Add selected node");
const chatEl = el("aside", { class: "panel", id: "chat", hidden: "", "aria-label": "Story chat" },
  el("div", { class: "chead" }, el("h2", null, "Story chat"), el("button", { type: "button", class: "cx", "aria-label": "Close the chat", onclick: () => chatToggle(false) }, "×")),
  chatModes, chatStatus,
  el("div", { class: "cf" }, "Pinned (always sent in full)"), chatTray,
  el("div", { class: "cacts" }, chatAddSel),
  chatLog,
  el("div", { class: "can" }, el("span", { class: "cf" }, "Analyze"), ...Object.keys(ANALYSES).map((k) => el("button", { type: "button", title: ANALYSES[k].label, onclick: () => chatAnalyze(k) }, { story: "Story", characters: "Characters", conflict: "Conflict", arc: "Arc" }[k]))),
  el("div", { class: "ccomp" }, chatIn, chatSize, el("div", { class: "cacts" }, chatSendBtn, el("button", { type: "button", class: "quiet", onclick: () => { chat.msgs = []; renderLog(); } }, "Clear chat")),
    el("p", { class: "dim chint" }, "The chat sees an index of your whole map and reads full nodes when your question needs them. Ask it to add, link or change things and it shows proposals here. Nothing changes until you tick it and press Apply. A backup is made first. Edits to existing nodes are more accurate on OpenAI, which asks first.")));
document.body.append(chatEl);

function modeLabel(m) { return m === "openai" ? "OpenAI" : "Groq"; }
function chatSync() { // called when the selection or the map changes
  const before = chat.tray.length;
  chat.tray = chat.tray.filter((id) => graph.byId.has(id));
  if (before !== chat.tray.length || chat.open) renderChat();
}
function renderChat() {
  const st = chat.status;
  chatModes.replaceChildren(...["groq", "openai"].map((m) => {
    const p = st && st[m], on = !st || p.configured;
    return el("button", { type: "button", class: "cm" + (chat.mode === m ? " sel" : "") + (on ? "" : " off"), "aria-pressed": chat.mode === m ? "true" : "false",
      title: on ? "" : "Not set up on the server: " + (p ? p.reason : ""), onclick: () => { chat.mode = m; renderChat(); } }, modeLabel(m) + (m === "openai" ? " (costs money)" : " (cheapest)"));
  }));
  if (!st) chatStatus.textContent = "Checking the AI settings...";
  else {
    const p = st[chat.mode];
    chatStatus.textContent = p.configured
      ? modeLabel(chat.mode) + " is on, model " + (p.model) + ". This month: " + usd(p.spent_this_month_usd) + " of " + usd(p.monthly_cap_usd) + "."
      : modeLabel(chat.mode) + " is not set up on the server yet: " + p.reason + ". In Railway, add " + (chat.mode === "openai" ? "OPENAI_API_KEY" : "GROQ_API_KEY") + ".";
  }
  chatTray.replaceChildren(...(trayNodes().length ? trayNodes().map((n) => el("span", { class: "tchip", style: "color:" + TYPES[n.type].hex },
    el("span", { class: "tn" }, n.name), el("button", { type: "button", "aria-label": "Remove " + n.name + " from the chat", onclick: () => { chat.tray = chat.tray.filter((x) => x !== n.id); renderChat(); } }, "×")))
    : [el("span", { class: "dim" }, "Nothing pinned. The AI sees an index of the whole map and picks what it needs. The node you have selected is always included.")]));
  const sel = selectedId && graph.byId.get(selectedId);
  chatAddSel.disabled = !sel || chat.tray.includes(selectedId);
  chatAddSel.textContent = sel ? (chat.tray.includes(selectedId) ? "Selected node is added" : "Add “" + sel.name.slice(0, 22) + (sel.name.length > 22 ? "..." : "") + "”") : "Add selected node";
  updateSize();
  chatSendBtn.disabled = chat.busy || !chatIn.value.trim();
}
function updateSize() {
  const all = graph.nodes, pin = trayNodes();
  const words = all.reduce((a, n) => a + Math.min(30, wordCount(n.summary)), 0) + pin.reduce((a, n) => a + wordCount(n.name + " " + n.summary), 0) + wordCount(chatIn.value);
  chatSize.textContent = "Each message sends an index of " + all.length + " node" + (all.length === 1 ? "" : "s") + " (names and snippets), your message" + (pin.length ? ", and the full text of " + pin.length + " pinned" : "") + ", about " + words + " words so far. Full text of other nodes is added only when your question needs it.";
}
function renderLog() {
  chatLog.replaceChildren(...chat.msgs.map((m, i) => {
    const box = el("div", { class: "cmsg " + m.role }, el("div", { class: "who" }, m.role === "user" ? "You" : m.role === "error" ? "Problem" : m.role === "note" ? "Note" : modeLabel(m.mode) + (m.cost != null ? ", " + usd(m.cost) : "")),
      el("div", { class: "txt" }, m.content));
    if (m.raw) box.append(el("details", { class: "craw" }, el("summary", null, "What the AI actually said"), el("pre", null, m.raw)));
    if (m.report) box.append(el("button", { type: "button", class: "retry", onclick: () => openReport(m.report.rep, m.report.ctx, m.report.mode, m.report.model) }, "Open the report"));
    if (m.set && m.set.items.length) box.append(proposalBlock(m.set));
    else if (m.set && m.set.skipped && m.set.skipped.length) box.append(el("details", { class: "craw" }, el("summary", null, "The AI suggested changes that could not be used"), el("ul", null, ...m.set.skipped.map((x) => el("li", null, x)))));
    if (m.role === "assistant" && m.mode === "groq" && (m.payload || m.rerun)) {
      box.append(el("button", { type: "button", class: "retry", onclick: () => chatRetryOpenAI(i) }, "Not good enough? Retry with OpenAI (costs money, asks first)"));
    }
    return box;
  }));
  if (chat.busy) chatLog.append(el("div", { class: "cmsg thinking" }, el("div", { class: "txt" }, "Thinking...")));
  chatLog.scrollTop = chatLog.scrollHeight;
}
async function refreshAiStatus() {
  const r = await apiRead("/api/ai/status");
  chat.status = r.status === 200 ? r.json : null;
  if (r.status !== 200) chatStatus.textContent = r.status === 401 ? "Your sign-in ended. Sign in again in a new tab." : "Could not reach the AI settings.";
  else renderChat();
}
function chatToggle(open) {
  chat.open = open;
  chatEl.hidden = !open;
  document.body.classList.toggle("chat-open", open);
  if (open) { renderChat(); renderLog(); refreshAiStatus(); chatIn.focus(); }
}
function chatAdd(id) {
  const n = id && graph.byId.get(id);
  if (!n) return;
  if (!chat.tray.includes(id)) chat.tray.push(id);
  if (!chat.open) chatToggle(true); else renderChat();
}
function aiError(r, what) {
  const j = r.json || {};
  if (r.status === 0) return "Could not reach the server. Nothing was sent.";
  if (r.status === 401) return "Your sign-in ended. Sign in again in a new tab, then try again.";
  if (r.status === 402) return "That would pass this month's " + what + " spending cap (" + usd(j.spent_this_month_usd || 0) + " spent of " + usd(j.monthly_cap_usd || 0) + "). Nothing was sent.";
  if (r.status === 413) return (j.message || "That is too much text for one request.") + " Remove some nodes from the list above or shorten your message.";
  if (r.status === 429) return j.retry_after_seconds ? "You have sent a lot of messages. Try again in about " + Math.ceil(j.retry_after_seconds / 60) + " minute(s)." : "The AI service is rate limiting. Try again shortly.";
  if (r.status === 503) return j.message || "That AI is not set up on the server yet.";
  return j.message || "The AI service returned an error (" + r.status + "). Nothing was changed.";
}
// Runs one request. For OpenAI it asks for the cost first. Returns true when a reply was added.
async function chatRun(mode, messages, opts) {
  opts = opts || {};
  const maxOut = opts.maxOut || CHAT_MAX_OUT, purpose = opts.purpose || "chat", extra = { json: !!opts.json, tier: opts.tier || "fast" };
  chat.busy = true; renderChat(); renderLog();
  try {
    let confirm = null;
    if (mode === "openai" && opts.preConfirmed != null) confirm = opts.preConfirmed; // the writer already confirmed the cost of this whole exchange
    else if (mode === "openai") {
      const e = await apiWrite("POST", "/api/ai/estimate", { mode, messages, max_output_tokens: maxOut, purpose, ...extra });
      if (e.status !== 200) { chat.msgs.push({ role: "error", content: aiError(e, "OpenAI") }); return false; }
      const j = e.json;
      const c = await choose("Use OpenAI?", el("div", null,
        el("p", null, "OpenAI costs money. The worst case for this one message is " + usd(j.worst_case_usd) + ", and it is usually less."),
        el("p", null, "This month so far: " + usd(j.spent_this_month_usd) + " of " + usd(j.monthly_cap_usd) + ". Model: " + j.model + "."),
        el("p", { class: "dim" }, "The estimate counts 3 characters per token and the full reply allowance.")),
        [{ id: "go", label: "Send with OpenAI for up to " + usd(j.worst_case_usd), kind: "primary" }, { id: "cancel", label: "Cancel", kind: "quiet" }]);
      if (c !== "go") return false;
      confirm = j.worst_case_usd;
    }
    const r = await apiWrite("POST", "/api/ai/chat", { mode, messages, max_output_tokens: maxOut, purpose, ...extra, confirm_cost: confirm });
    if (r.status !== 200) { chat.msgs.push({ role: "error", content: aiError(r, modeLabel(mode)) }); return false; }
    if (!opts.raw) chat.msgs.push({ role: "assistant", content: r.json.text, mode, cost: r.json.usage.cost_usd, payload: messages });
    return r.json;
  } finally {
    chat.busy = false; renderLog(); refreshAiStatus();
  }
}
// The warn-only explicit check, shared by chat and proposals. Returns { nodes, mask, msgText } or null if cancelled.
async function screenForSend(text, nodes0) {
  let nodes = nodes0, mask = false, msgText = text;
  const hits = [];
  for (const n of nodes) { const h = scanExplicit(n.name + ". " + n.summary); if (h.length) hits.push({ label: n.name, node: n, sents: h }); }
  const mh = scanExplicit(text);
  if (mh.length) hits.push({ label: "your message", node: null, sents: mh });
  const ack = chat.ack;
  const fresh = hits.filter((h) => h.sents.some((x) => !ack.set.has(x)));
  if (fresh.length) {
    const list = el("ul", { class: "chits" }, ...fresh.map((h) => el("li", null, el("strong", null, h.label + ": "), "\u201c" + h.sents[0].slice(0, 140) + (h.sents[0].length > 140 ? "..." : "") + "\u201d" + (h.sents.length > 1 ? " and " + (h.sents.length - 1) + " more" : ""))));
    const buttons = [{ id: "send", label: "Send anyway", kind: "primary" }, { id: "mask", label: "Mask those passages" }];
    if (fresh.some((h) => h.node)) buttons.push({ id: "leave", label: "Leave those nodes out" });
    buttons.push({ id: "cancel", label: "Cancel", kind: "quiet" });
    const c = await choose("Possible explicit passages", el("div", null,
      el("p", null, "A rough word check in your browser found passages that may be explicit. Whatever you send goes to " + modeLabel(chat.mode) + ", a third party. You decide, and I will remember your choice for these passages until you clear the chat:"), list,
      el("p", { class: "dim" }, "This check is crude. It can miss things and flag innocent text. Nothing has been sent or changed.")), buttons);
    if (c === "cancel") return null;
    for (const h of hits) for (const x of h.sents) ack.set.add(x);
    ack.choice = c;
  }
  if (hits.length) {
    if (ack.choice === "mask") { mask = true; msgText = maskText(text, mh); }
    if (ack.choice === "leave") nodes = nodes.filter((n) => !hits.some((h) => h.node === n));
  }
  return { nodes, mask, msgText };
}
const estUsd = (price, chars, outTok) => (Math.ceil(chars / 3) * price[0] + outTok * price[1]) / 1e6;
function indexLines(nodes, mask) {
  const per = Math.max(0, Math.min(160, Math.floor(90000 / Math.max(1, nodes.length)) - 160));
  return nodes.map((n) => {
    const ms = mask ? maskText(n.name + "\n" + (n.summary || ""), scanExplicit(n.name + ". " + n.summary)) : n.name + "\n" + (n.summary || "");
    const [name, ...rest] = ms.split("\n");
    const sn = rest.join(" ").replace(/\s+/g, " ").trim();
    const links = (Array.isArray(n.raw.links) ? n.raw.links : []).map((l) => { const t = l && graph.byId.get(l.to); return t ? t.name + (l.label ? " (" + l.label + ")" : "") : null; }).filter(Boolean);
    return "- id=" + n.id + " | " + TYPES[n.type].label + " | " + name + " | " + (n.u != null ? whenText(n) : "no story time") + " | links: " + (links.length ? links.join("; ") : "none") + " | " + (per ? sn.slice(0, per) + (sn.length > per ? "..." : "") : "");
  }).join("\n");
}
// OpenAI costs money, so one confirmation covers the whole exchange (a small pick call, then the answer). Returns the confirmed amount, or null.
async function confirmOpenAiExchange(chars, needPick) {
  const st = chat.status && chat.status.openai;
  if (!st || !st.prices_per_million_usd) return 0;
  const pf = st.prices_per_million_usd.fast, pa = st.prices_per_million_usd.accurate;
  const total = Math.round(1.25 * 1e6 * ((needPick ? estUsd(pf, chars.index + chars.hist + chars.msg + PICK_SYSTEM.length + 1500, PICK_MAX_OUT) : 0) + estUsd(pa, chars.index + chars.full + chars.hist + chars.msg + ANSWER_SYSTEM.length + 3000, CHAT_ANSWER_MAX_OUT))) / 1e6;
  const c = await choose("Use OpenAI?", el("div", null,
    el("p", null, "OpenAI costs money. This message may use " + (needPick ? "two calls (a small one to choose which nodes to read, then the answer)" : "one call") + ". The worst case for all of it is " + usd(total) + ", and it is usually far less."),
    el("p", null, "This month so far: " + usd(st.spent_this_month_usd) + " of " + usd(st.monthly_cap_usd) + ". Model: " + st.accurate_model + "."),
    el("p", { class: "dim" }, "The estimate counts 3 characters per token and the full reply allowance, plus a safety margin.")),
    [{ id: "go", label: "Send with OpenAI for up to " + usd(total), kind: "primary" }, { id: "cancel", label: "Cancel", kind: "quiet" }]);
  return c === "go" ? total : null;
}
async function chatSend() {
  if (chat.busy) return;
  const text = chatIn.value.trim();
  if (!text) return;
  if (chat.status && !chat.status[chat.mode].configured) { toast(modeLabel(chat.mode) + " is not set up on the server yet.", true); return; }
  const scr = await screenForSend(text, graph.nodes);
  if (!scr) return;
  const { nodes, mask, msgText } = scr;
  const limit = chat.status ? chat.status.max_input_chars : 400000;
  const index = indexLines(nodes, mask);
  const byIdN = new Map(nodes.map((n) => [n.id, n]));
  const pinned = new Set(chat.tray.filter((id) => byIdN.has(id)));
  if (selectedId && byIdN.has(selectedId)) pinned.add(selectedId);
  const allFull = nodes.reduce((a, n) => a + nodeChars(n), 0);
  const needPick = allFull > FULL_MAX_CHARS;
  const hist = chat.msgs.filter((m) => m.role === "user" || m.role === "assistant").slice(-10).map((m) => ({ role: m.role, content: m.sent || m.content }));
  const histChars = hist.reduce((a, m) => a + m.content.length, 0);
  let pre = null;
  if (chat.mode === "openai") {
    pre = await confirmOpenAiExchange({ index: index.length, full: Math.min(allFull, limit * 0.6), hist: histChars, msg: msgText.length }, needPick);
    if (pre === null) return;
  }
  chat.msgs.push({ role: "user", content: text, sent: msgText });
  chatIn.value = "";
  renderLog(); renderChat();
  const ids = new Set(pinned);
  if (!needPick) for (const n of nodes) ids.add(n.id);
  else {
    const pm = [{ role: "system", content: PICK_SYSTEM + "\n\nINDEX:\n" + index },
      { role: "user", content: "Recent conversation:\n" + (hist.slice(-4).map((m) => m.role + ": " + m.content.slice(0, 300)).join("\n") || "(none)") + "\n\nWriter's message:\n" + msgText }];
    const pr = await chatRun(chat.mode, pm, { raw: true, json: true, tier: "fast", maxOut: PICK_MAX_OUT, purpose: "chat pick", preConfirmed: pre });
    if (!pr) { if (chat.msgs[chat.msgs.length - 1].role !== "error") { chat.msgs.pop(); chatIn.value = text; } renderLog(); renderChat(); return; }
    if (pr.json && Array.isArray(pr.json.node_ids)) { for (const id of pr.json.node_ids.slice(0, 12)) if (typeof id === "string" && byIdN.has(id)) ids.add(id); }
    else chat.msgs.push({ role: "note", content: "I could not choose nodes automatically, so I only used the index and the nodes you pinned or selected." });
  }
  // keep the full text within the request limit, pinned and selected nodes first
  let used = 0; const full = [];
  for (const id of [...pinned, ...[...ids].filter((x) => !pinned.has(x))]) {
    const n = byIdN.get(id); if (!n) continue;
    const c = nodeChars(n);
    if (used + c > limit * 0.6) { chat.msgs.push({ role: "note", content: "\u201c" + n.name + "\u201d was left out because the request would be too large." }); continue; }
    used += c; full.push(n);
  }
  const eras = eraList();
  const system = ANSWER_SYSTEM + "\n\n" + (eras.length ? "Eras (id: name):\n" + eras.map((e) => e.id + ": " + e.name).join("\n") : "No eras exist yet, so leave time null.") +
    "\n\nINDEX (every node):\n" + (index || "(the map is empty)") +
    "\n\nFULL TEXT of these nodes (" + (full.length ? full.map((n) => n.id).join(", ") : "none") + "):\n\n" + (full.map((n) => nodeBlock(n, mask)).join("\n\n") || "(none)");
  const ctx = { ids: new Set(full.map((n) => n.id)), linkIds: new Set(nodes.map((n) => n.id)), eras: new Set(eras.map((e) => String(e.id))),
    sourceNorm: normQ(msgText + "\n" + index + "\n" + full.map((n) => n.name + "\n" + n.summary).join("\n")),
    messages: [{ role: "system", content: system }, ...hist, { role: "user", content: msgText }] };
  const ok = await chatAnswer(ctx, chat.mode, pre);
  if (!ok && chat.msgs[chat.msgs.length - 1].role !== "error") { chat.msgs.pop(); chatIn.value = text; }
  renderLog(); renderChat();
}
// The answer call. Replies are JSON: { reply, proposals }. If the model did not keep to that, its plain text is shown as the reply.
async function chatAnswer(ctx, mode, pre) {
  const reply = await chatRun(mode, ctx.messages, { raw: true, json: true, tier: "accurate", maxOut: CHAT_ANSWER_MAX_OUT, purpose: "chat", preConfirmed: pre });
  if (!reply) { renderLog(); renderChat(); return false; }
  const j = reply.json;
  let text, set = null;
  if (j && typeof j.reply === "string") {
    text = j.reply.trim() || "(the AI gave no reply text)";
    if (Array.isArray(j.proposals) && j.proposals.length) set = readProposals({ json: { proposals: j.proposals } }, ctx);
  } else text = (reply.text || "").trim() || "(the AI returned no text)";
  if (reply.truncated) text += "\n\n(The reply hit the length limit and may be cut off.)";
  chat.msgs.push({ role: "assistant", mode, cost: reply.usage.cost_usd, content: text, set, rerun: (m2) => chatAnswer(ctx, m2) });
  renderLog(); renderChat();
  return true;
}
async function chatRetryOpenAI(i) {
  if (chat.busy) return;
  const m = chat.msgs[i];
  if (m && m.rerun) { await m.rerun("openai"); return; }
  if (!m || !m.payload) return;
  await chatRun("openai", m.payload);
  renderLog(); renderChat();
}

/* proposals (stage 3): turn text into suggested new nodes and ADD-ONLY patches to existing nodes. The AI never writes.
 * Every proposal quotes the writer's words, is checked here, and is applied only when ticked, after a safety backup. */
const ANALYZE_MAX_OUT = 8000, MAX_PROPOSALS = 25;
const normQ = (s) => String(s).toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

// Checks the AI's reply. Returns { items, skipped }. Nothing in here touches the map.
function readProposals(reply, ctx) {
  const skipped = [], items = [];
  let obj = reply && reply.json && typeof reply.json === "object" ? reply.json : null;
  if (!obj) return { items, skipped, bad: "The AI's answer was not in the expected format, so nothing was proposed." };
  const list = Array.isArray(obj.proposals) ? obj.proposals : null;
  if (!list) return { items, skipped, bad: "The AI's answer had no list of proposals, so nothing was proposed." };
  const temp = new Set();
  const soft = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
  for (const p of list.slice(0, MAX_PROPOSALS)) if (p && p.kind === "create" && typeof p.temp_id === "string" && /^[A-Za-z0-9_]{1,30}$/.test(p.temp_id) && !(ctx.linkIds || ctx.ids).has(p.temp_id)) temp.add(p.temp_id);
  const linkOk = (to, self) => typeof to === "string" && to !== self && ((ctx.linkIds || ctx.ids).has(to) || temp.has(to));
  const cleanLinks = (arr, self) => (Array.isArray(arr) ? arr : []).filter((l) => l && linkOk(l.to, self)).map((l) => ({ to: l.to, label: soft(l.label, LIM.label).trim() })).slice(0, 12);
  const cleanTime = (t) => {
    if (!t || typeof t !== "object") return null;
    const era = typeof t.era === "string" && ctx.eras.has(t.era) ? t.era : null, order = Number.isFinite(t.order) ? t.order : null;
    return era === null && order === null ? null : { era, order };
  };
  if (list.length > MAX_PROPOSALS) skipped.push("The AI returned " + list.length + " proposals. Only the first " + MAX_PROPOSALS + " are shown.");
  for (const p of list.slice(0, MAX_PROPOSALS)) {
    if (!p || typeof p !== "object") { skipped.push("One entry was not a proposal."); continue; }
    const quote = soft(p.quote, 600).trim(), nq = normQ(quote);
    const grounded = nq.length >= 12 && ctx.sourceNorm.includes(nq);
    if (p.kind === "create") {
      const name = soft(p.name, LIM.name).trim();
      if (!name) { skipped.push("A new node had no name."); continue; }
      const type = TYPES[p.type] && p.type !== "other" ? p.type : "other";
      const tid = temp.has(p.temp_id) ? p.temp_id : "t" + items.length;
      items.push({ kind: "create", tid, type, name, summary: soft(p.summary, LIM.summary), links: cleanLinks(p.links, tid), time: cleanTime(p.time), quote, grounded, checked: grounded });
    } else if (p.kind === "patch") {
      const n = typeof p.id === "string" && ctx.ids.has(p.id) ? graph.byId.get(p.id) : null;
      if (!n) { skipped.push("A change named a node that was not shared with the AI, so it was ignored."); continue; }
      const app = soft(p.append, LIM.summary).trim();
      const dup = app && normQ(n.summary).includes(normQ(app));
      const links = cleanLinks(p.add_links, n.id).filter((l) => !(n.raw.links || []).some((x) => x && x.to === l.to));
      const time = hasTime(n.raw) ? null : cleanTime(p.time);
      if (dup && !links.length && !time) { skipped.push("A change to “" + n.name + "” only repeated text that is already there."); continue; }
      if (!app && !links.length && !time) { skipped.push("A change to “" + n.name + "” had nothing new in it."); continue; }
      if (n.summary.length + app.length + 2 > LIM.summary) { skipped.push("The addition to “" + n.name + "” would make its summary too long."); continue; }
      items.push({ kind: "patch", id: n.id, append: dup ? "" : app, links, time, quote, grounded, checked: grounded });
    } else if (p.kind === "replace") {
      const n = typeof p.id === "string" && ctx.ids.has(p.id) ? graph.byId.get(p.id) : null;
      if (!n) { skipped.push("A replacement named a node whose full text was not shown to the AI, so it was ignored."); continue; }
      const find = typeof p.find === "string" ? p.find.slice(0, 4000) : "", neu = typeof p.with === "string" ? p.with.slice(0, LIM.summary) : "";
      if (!find || n.summary.split(find).length - 1 !== 1) { skipped.push("A replacement in \u201c" + n.name + "\u201d quoted text that is not in the node exactly once, so it was ignored."); continue; }
      if (find === neu) { skipped.push("A replacement in \u201c" + n.name + "\u201d changed nothing."); continue; }
      if (n.summary.length - find.length + neu.length > LIM.summary) { skipped.push("A replacement in \u201c" + n.name + "\u201d would make the summary too long."); continue; }
      items.push({ kind: "replace", id: n.id, find, with: neu, quote, grounded, checked: false }); // replacements always start unticked
    } else skipped.push("An entry had an unknown kind and was ignored.");
  }
  return { items, skipped };
}

// What to tell the writer when a reply could not be read: the reason, and the start of what the AI actually said.
const badReply = (reason, reply) => ({ content: reason + (reply.truncated ? " The reply hit the length limit and was cut off before it finished." : ""),
  raw: typeof reply.text === "string" && reply.text.trim() ? reply.text.trim().slice(0, 1500) + (reply.text.trim().length > 1500 ? "..." : "") : "(the AI returned no text)" });
const itemTitle = (it) => (it.kind === "create" ? it.name : (graph.byId.get(it.id) || { name: it.id }).name);
const linkTarget = (to, items) => { const n = graph.byId.get(to); if (n) return n.name; const c = items.find((x) => x.kind === "create" && x.tid === to); return c ? c.name + " (new)" : to; };
const timeText = (t) => (t.era ? eraName(t.era) : "no era") + (t.order !== null ? ", order " + t.order : "");

// Shows what was proposed. Applying needs a tick and a press of the Apply button.
const KIND_LABEL = { create: "New node", patch: "Add to", replace: "Replace in" };
function buildCard(it, items, sync, locked) {
  const box = el("input", { type: "checkbox", "aria-label": "Apply this proposal: " + itemTitle(it) });
  box.checked = it.checked; box.disabled = !!locked; box.addEventListener("change", () => { it.checked = box.checked; sync(); });
  const card = el("div", { class: "pcard" + (it.grounded ? "" : " ungrounded") });
  card.append(el("label", { class: "ph" }, box, el("span", { class: "pk" }, KIND_LABEL[it.kind]), el("strong", null, itemTitle(it)), it.kind === "create" ? el("span", { class: "pt" }, TYPES[it.type].label) : null));
  if (!it.grounded) card.append(el("p", { class: "warn" }, "Not found in your text. This may be invented. It is unticked."));
  if (it.kind === "replace") card.append(el("p", { class: "warn" }, "This replaces existing text. It starts unticked, and applying it only works if that exact passage is still there."));
  card.append(el("div", { class: "pq" }, el("small", null, "Quote the AI relied on"), el("blockquote", null, it.quote || "(none given)")));
  if (it.kind === "create") {
    card.append(el("div", { class: "padd" }, it.summary || el("span", { class: "dim" }, "(no summary)")));
  } else if (it.kind === "replace") {
    card.append(el("div", { class: "pold" }, el("small", null, "Old text"), el("div", { class: "pstrike" }, it.find)));
    card.append(el("div", { class: "padd note" }, el("small", null, "New text"), el("div", null, it.with || "(removed)")));
  } else {
    const n = graph.byId.get(it.id), tail = n.summary.length > 140 ? "..." + n.summary.slice(-140) : n.summary;
    card.append(el("div", { class: "pold" }, el("small", null, "Stays exactly as it is"), el("div", null, tail || "(empty)")));
    if (it.append) card.append(el("div", { class: "padd note" }, el("small", null, "Added at the end"), el("div", null, it.append)));
  }
  for (const l of it.links || []) card.append(el("div", { class: "padd" }, "Link to " + linkTarget(l.to, items) + (l.label ? " (" + l.label + ")" : "")));
  if (it.time) card.append(el("div", { class: "padd" }, "Story time: " + timeText(it.time)));
  return card;
}
// The proposals shown inside the AI's reply in the chat. Nothing is applied until the writer ticks it and presses Apply.
function proposalBlock(set) {
  const wrap = el("div", { class: "pblock" });
  const btn = el("button", { type: "button", class: "primary" }, "");
  const sync = () => { const n = set.items.filter((x) => x.checked).length; btn.disabled = !!set.applied || !n; btn.textContent = set.applied ? "Applied" : n ? "Apply " + n + " selected (a backup is made first)" : "Nothing selected"; };
  wrap.append(el("p", { class: "dim" }, set.applied ? "These proposals were applied." : set.items.length + " proposal" + (set.items.length === 1 ? "" : "s") + ". Nothing has been changed. Tick what you want."));
  for (const it of set.items) wrap.append(buildCard(it, set.items, sync, set.applied));
  btn.addEventListener("click", () => applyItems(set, btn, () => { set.applied = true; renderLog(); }));
  wrap.append(btn);
  if (set.skipped && set.skipped.length) wrap.append(el("details", { class: "craw" }, el("summary", null, set.skipped.length + " thing" + (set.skipped.length === 1 ? "" : "s") + " could not be used"), el("ul", null, ...set.skipped.map((x) => el("li", null, x)))));
  sync();
  return wrap;
}

// Add-only merge against the node as it is NOW. Returns the new data, or null when there is nothing to add.
function mergePatch(data, it) {
  const d = deepCopy(data), old = String(d.summary || "");
  if (it.kind === "replace") { // only if that exact passage is still in the node, exactly once
    if (old.split(it.find).length - 1 !== 1) return "gone";
    const i = old.indexOf(it.find);
    d.summary = old.slice(0, i) + it.with + old.slice(i + it.find.length);
    return d.summary === old ? null : d;
  }
  let changed = false;
  if (it.append && !normQ(old).includes(normQ(it.append))) {
    if (old.length + it.append.length + 2 > LIM.summary) return "too_long";
    d.summary = old + (old ? (old.endsWith("\n") ? "\n" : "\n\n") : "") + it.append; changed = true;
  }
  const have = new Set((Array.isArray(d.links) ? d.links : []).map((l) => l && l.to));
  const add = it.links.filter((l) => !have.has(l.to));
  if (add.length) { d.links = [...(Array.isArray(d.links) ? d.links : []), ...add.map((l) => ({ to: l.to, label: l.label }))]; changed = true; }
  if (it.time && !hasTime(d)) { d.time = { era: it.time.era, order: it.time.order }; changed = true; }
  return changed ? d : null;
}
async function applyPatch(it) {
  let row = model.rows.get(it.id);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!row) return { ok: false, why: "that node no longer exists" };
    if (row.hidden) return { ok: false, why: "that node is hidden now" };
    const d = mergePatch(row.data || {}, it);
    if (d === "too_long") return { ok: false, why: "the summary would be too long" };
    if (d === "gone") return { ok: false, why: "that passage has changed or is no longer there" };
    if (!d) return { ok: true, note: "already there, nothing to add" };
    const r = await apiWrite("PUT", "/api/nodes/" + it.id, { data: d, base_rev: row.rev });
    if (r.status === 200 && r.json && r.json.node) { model.rows.set(it.id, r.json.node); return { ok: true }; }
    if (r.status === 409 && r.json && r.json.current) { row = r.json.current; model.rows.set(it.id, row); continue; } // someone saved first: merge onto their version
    return { ok: false, why: r.status === 401 ? "your sign-in ended" : "the server refused it (" + r.status + ")" };
  }
  return { ok: false, why: "it kept changing while saving" };
}
async function applyItems(set, btn, onDone) {
  const chosen = set.items.filter((x) => x.checked);
  if (!chosen.length) return;
  if (editing) { toast("Finish or cancel the node you are editing first, then apply.", true); return; }
  btn.disabled = true; btn.textContent = "Making a backup...";
  const b = await apiWrite("POST", "/api/backups", {});
  if (b.status !== 200) { btn.disabled = false; btn.textContent = "Apply " + chosen.length + " selected"; toast(planMessage(b, "make the safety backup") + " Nothing was applied.", true); return; }
  btn.textContent = "Applying...";
  const report = [];
  const idOf = new Map();
  for (const it of chosen) if (it.kind === "create") idOf.set(it.tid, uid("n_"));
  for (const it of chosen) {
    if (it.kind !== "create") continue;
    const links = it.links.map((l) => ({ to: idOf.get(l.to) || l.to, label: l.label })).filter((l) => idOf.has(l.to) || graph.byId.has(l.to));
    const data = { type: it.type, name: it.name, summary: it.summary, links };
    if (it.time) data.time = { era: it.time.era, order: it.time.order };
    let id = idOf.get(it.tid), r = await apiWrite("PUT", "/api/nodes/" + id, { data });
    if (r.status === 409) { const old = id; id = uid("n_"); for (const [k, v] of idOf) if (v === old) idOf.set(k, id); r = await apiWrite("PUT", "/api/nodes/" + id, { data }); }
    if (r.status === 200 && r.json && r.json.node) { model.rows.set(id, r.json.node); report.push("Created “" + it.name + "”."); }
    else report.push("Could not create “" + it.name + "” (" + (r.status === 401 ? "your sign-in ended" : "error " + r.status) + ").");
  }
  for (const kind of ["patch", "replace"]) for (const it of chosen) {
    if (it.kind !== kind) continue;
    const nm = itemTitle(it);
    const links = (it.links || []).map((l) => ({ to: idOf.get(l.to) || l.to, label: l.label })).filter((l) => model.rows.has(l.to) || graph.byId.has(l.to));
    const res = await applyPatch({ ...it, links });
    report.push(res.ok ? (kind === "replace" ? "Replaced a passage in \u201c" : "Added to \u201c") + nm + "\u201d" + (res.note ? " (" + res.note + ")." : ".") : "Skipped \u201c" + nm + "\u201d: " + res.why + ". Nothing was changed there.");
  }
  onDone();
  refreshAll(false);
  const okCount = report.filter((x) => /^(Created|Added|Replaced)/.test(x)).length;
  await choose("Done", el("div", null, el("p", null, okCount + " of " + chosen.length + " applied. A backup of the map from just before is in History (the newest “Made by hand”)."),
    el("ul", { class: "chits" }, ...report.map((x) => el("li", null, x)))), [{ id: "ok", label: "Close", kind: "primary" }]);
}

/* analyses (stage 4): four read-only reports about the nodes you choose. Each finding is labeled Stated, Inference or
 * Not in the text, names its nodes, and quotes the text. Quotes are checked here. Nothing here changes the map. */
const ANALYZE_SYSTEM = "You are a careful story analyst for a writer's collaborative worldbuilding map. Reply with ONLY a JSON object and no other text: " +
  "{\"title\":\"...\",\"sections\":[{\"heading\":\"...\",\"findings\":[{\"label\":\"stated|inference|not_in_text\",\"text\":\"...\",\"nodes\":[\"node name\"],\"quote\":\"...\"}]}],\"open_questions\":[\"...\"]}. " +
  "Labels: \"stated\" means the text says it directly, and needs an exact quote. \"inference\" means you reasoned it from the text, and the quote is the evidence. \"not_in_text\" means a gap, something the text does not say, and the quote may be empty. " +
  "Every quote must be copied exactly, word for word, from a shared node or from the writer's focus note. Use only the shared nodes. Never invent facts, names, places, rules or events, and never supply missing lore. " +
  "Phrase suggestions as questions in open_questions, because the writer decides the story. At most 8 sections and 8 findings per section, and keep each finding to one or two sentences so the whole answer stays short. ";
const LABELS = { stated: "Stated in the text", inference: "Inference", not_in_text: "Not in the text" };

function readAnalysis(reply, ctx) {
  const o = reply && reply.json && typeof reply.json === "object" ? reply.json : null;
  if (!o || !Array.isArray(o.sections)) return { bad: "The AI's answer was not in the expected format, so there is no report." };
  const str = (v, n) => (typeof v === "string" ? v.slice(0, n).trim() : "");
  const sections = [];
  let flagged = 0, total = 0;
  for (const s of o.sections.slice(0, 10)) {
    if (!s || typeof s !== "object") continue;
    const findings = [];
    for (const f of (Array.isArray(s.findings) ? s.findings : []).slice(0, 12)) {
      if (!f || typeof f !== "object") continue;
      const text = str(f.text, 2000);
      if (!text) continue;
      const label = LABELS[f.label] ? f.label : "inference", quote = str(f.quote, 600), nq = normQ(quote);
      const grounded = label === "not_in_text" ? true : nq.length >= 12 && ctx.sourceNorm.includes(nq);
      const nodes = (Array.isArray(f.nodes) ? f.nodes : []).filter((x) => typeof x === "string").map((x) => x.slice(0, 200)).slice(0, 8);
      findings.push({ label, text, nodes, quote, grounded }); total++; if (!grounded) flagged++;
    }
    if (findings.length) sections.push({ heading: str(s.heading, 200) || "Findings", findings });
  }
  const questions = (Array.isArray(o.open_questions) ? o.open_questions : []).filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 500)).slice(0, 12);
  if (!sections.length && !questions.length) return { bad: "The AI's answer had no usable findings, so there is no report." };
  return { title: str(o.title, 200) || ctx.kind.label, sections, questions, flagged, total };
}

function reportMarkdown(rep, ctx, mode, model) {
  const L = [];
  L.push("# " + rep.title, "", "Kind: " + ctx.kind.label, "Made: " + new Date().toISOString().slice(0, 10), "Made by: " + modeLabel(mode) + (model ? " (" + model + ")" : ""),
    "Nodes included (" + ctx.nodeNames.length + "): " + ctx.nodeNames.join("; "), ctx.focusNote ? "Focus note: " + ctx.focusNote : "", "",
    "This report was written by an AI from the nodes above. It is not canon. Check every finding against your own text. Findings marked with a warning have a quote that was not found in the text that was sent.", "");
  for (const s of rep.sections) {
    L.push("## " + s.heading, "");
    for (const f of s.findings) {
      L.push("- [" + LABELS[f.label] + "] " + f.text + (f.nodes.length ? " (Nodes: " + f.nodes.join(", ") + ")" : "") + (f.grounded ? "" : " (WARNING: the quote was not found in the text)"));
      if (f.quote) L.push("  > " + f.quote.replace(/\n+/g, " "));
    }
    L.push("");
  }
  if (rep.questions.length) { L.push("## Questions for the writer", ""); for (const q of rep.questions) L.push("- " + q); L.push(""); }
  return L.filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n");
}

function openReport(rep, ctx, mode, model) {
  const body = el("div", { class: "prev" });
  body.append(el("p", { class: "dim" }, "Written by " + modeLabel(mode) + " from " + ctx.nodeNames.length + " node" + (ctx.nodeNames.length === 1 ? "" : "s") + ". It is not canon and it has changed nothing. " +
    (rep.flagged ? rep.flagged + " of " + rep.total + " findings have a quote that was not found in your text, shown in red." : "Every quote was found in your text.")));
  for (const s of rep.sections) {
    body.append(el("h3", null, s.heading));
    for (const f of s.findings) {
      body.append(el("div", { class: "pcard rf " + f.label + (f.grounded ? "" : " ungrounded") },
        el("div", { class: "ph" }, el("span", { class: "pk lab-" + f.label }, LABELS[f.label]), f.nodes.length ? el("span", { class: "pt" }, f.nodes.join(", ")) : null),
        el("div", { class: "rtext" }, f.text),
        !f.grounded ? el("p", { class: "warn" }, f.quote ? "The quote was not found in your text. Treat this finding with care." : "No quote was given for this finding. Treat it with care.") : null,
        f.quote ? el("blockquote", null, f.quote) : null));
    }
  }
  if (rep.questions.length) { body.append(el("h3", null, "Questions for you")); body.append(el("ul", null, ...rep.questions.map((q) => el("li", null, q)))); }
  openModal(rep.title, body, [
    { id: "dl", label: "Download as .md", kind: "primary", onclick: () => downloadFile("throat-analysis-" + ctx.kindKey + "-" + todayStamp() + ".md", new Blob([reportMarkdown(rep, ctx, mode, model)], { type: "text/markdown" })) },
    { id: "close", label: "Close", kind: "quiet", onclick: closeModal },
  ], { wide: true });
}

async function chatAnalyze(kindKey, retryCtx, retryMode) {
  if (chat.busy) return;
  let ctx = retryCtx, mode = retryMode || chat.mode;
  if (!ctx) {
    const kind = ANALYSES[kindKey], focus = chatIn.value.trim();
    if (chat.status && !chat.status[chat.mode].configured) { toast(modeLabel(chat.mode) + " is not set up on the server yet.", true); return; }
    let nodes = trayNodes(), ask = "";
    if (kindKey === "conflict" && nodes.length < 2) { toast("Conflict analysis needs at least two nodes. Add them to the list above first.", true); return; }
    if (kindKey === "characters" && !nodes.some((n) => n.type === "character")) {
      const all = graph.nodes.filter((n) => n.type === "character");
      if (!all.length) { toast("There are no character nodes to analyse yet.", true); return; }
      nodes = [...nodes, ...all]; ask = "all the character nodes in the map";
    } else if (!nodes.length && (kindKey === "story" || kindKey === "arc")) { nodes = graph.nodes.slice(); ask = "the whole map"; }
    if (!nodes.length) { toast("The map is empty.", true); return; }
    const chars = nodes.reduce((a, n) => a + nodeChars(n), 0) + ANALYZE_SYSTEM.length + focus.length + 1200, words = nodes.reduce((a, n) => a + wordCount(n.name + " " + n.summary), 0);
    const limit = chat.status ? chat.status.max_input_chars : 400000;
    if (chars > limit * 0.9) {
      await choose("Too large for one request", el("div", null, el("p", null, "That is " + nodes.length + " nodes, about " + words + " words (about " + chars + " characters). One request can carry at most " + limit + " characters. Add fewer nodes to the list above and try again.")), [{ id: "ok", label: "Close" }]);
      return;
    }
    if (ask) {
      const c = await choose("Analyse " + ask + "?", el("div", null, el("p", null, kind.label + " will send " + nodes.length + " node" + (nodes.length === 1 ? "" : "s") + ", about " + words + " words (up to about " + Math.ceil(chars / 3) + " tokens)."),
        el("p", { class: "dim" }, "Your list above is empty or has no characters, so this uses " + ask + ". On OpenAI you would see the worst-case cost before anything is sent.")),
        [{ id: "go", label: "Analyse " + ask, kind: "primary" }, { id: "cancel", label: "Cancel", kind: "quiet" }]);
      if (c !== "go") return;
    }
    if (kindKey === "arc") {
      const timed = nodes.filter((n) => n.u != null).length;
      if (timed < 3) {
        const c = await choose("Few nodes have story time", el("div", null, el("p", null, "Only " + timed + " of these " + nodes.length + " nodes have a place in story time, so the arc analysis will say little about order. Continue anyway?")),
          [{ id: "go", label: "Continue anyway", kind: "primary" }, { id: "cancel", label: "Cancel", kind: "quiet" }]);
        if (c !== "go") return;
      }
    }
    const scr = await screenForSend(focus, nodes);
    if (!scr) return;
    const used = scr.nodes;
    if (!used.length) { toast("Every node was left out, so there is nothing to analyse.", true); return; }
    let blocks;
    if (kindKey === "arc") {
      const timed = used.filter((n) => n.u != null).sort((a, b) => a.beat - b.beat), rest = used.filter((n) => n.u == null);
      blocks = "Nodes in story order:\n\n" + (timed.length ? timed.map((n, i) => "(Position " + (i + 1) + ") " + nodeBlock(n, scr.mask)).join("\n\n") : "(none)") +
        "\n\nNodes without story time:\n\n" + (rest.length ? rest.map((n) => nodeBlock(n, scr.mask)).join("\n\n") : "(none)");
    } else blocks = "Shared nodes:\n\n" + used.map((n) => nodeBlock(n, scr.mask)).join("\n\n");
    const system = ANALYZE_SYSTEM + kind.ask + "\n\n" + blocks;
    ctx = { kindKey, kind, nodeNames: used.map((n) => n.name), focusNote: scr.msgText,
      sourceNorm: normQ(scr.msgText + "\n" + used.map((n) => n.name + "\n" + n.summary).join("\n")),
      messages: [{ role: "system", content: system }, { role: "user", content: scr.msgText ? "Focus note from the writer: " + scr.msgText : "No focus note. Analyse " + kind.focus + "." }] };
    chat.msgs.push({ role: "user", content: "(" + kind.label + ") " + (focus || "no focus note"), sent: scr.msgText });
    chatIn.value = "";
  }
  const reply = await chatRun(mode, ctx.messages, { raw: true, json: true, tier: "accurate", maxOut: ANALYZE_MAX_OUT, purpose: "analyze " + ctx.kindKey });
  if (!reply) {
    if (!retryCtx && chat.msgs[chat.msgs.length - 1].role !== "error") { chat.msgs.pop(); chatIn.value = ctx.focusNote; }
    renderLog(); renderChat(); return;
  }
  const rep = readAnalysis(reply, ctx);
  chat.msgs.push({ role: "assistant", mode, cost: reply.usage.cost_usd, rerun: (m2) => chatAnalyze(ctx.kindKey, ctx, m2), report: rep.bad ? null : { rep, ctx, mode, model: reply.model }, ...(rep.bad ? badReply(rep.bad, reply) : {}),
    content: (rep.bad ? badReply(rep.bad, reply).content : null) || ctx.kind.label + " ready: " + rep.total + " findings, " + rep.flagged + " with a quote not found in your text. Nothing has been changed." });
  renderLog(); renderChat();
  if (!rep.bad) openReport(rep, ctx, mode, reply.model);
}
chatIn.addEventListener("input", () => { updateSize(); chatSendBtn.disabled = chat.busy || !chatIn.value.trim(); });
chatIn.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); chatSend(); } });
$("chatBtn").addEventListener("click", () => chatToggle(!chat.open));


/* ---------- labels ---------- */
const labelPool = [], NEAR_PX = 80;
function labelAt(i) {
  if (!labelPool[i]) { const d = el("div", { class: "lb" }); $("labels").append(d); labelPool[i] = d; }
  return labelPool[i];
}
const tmp = new THREE.Vector3(), tmpE = new THREE.Vector3();
function toScreen(v) {
  tmp.copy(v).project(camera);
  if (tmp.z > 1 || tmp.z < -1) return null;
  return { x: (tmp.x * .5 + .5) * W, y: (-tmp.y * .5 + .5) * H };
}
function pxPerUnit(pos) { return H / (2 * Math.tan(camera.fov * Math.PI / 360) * camera.position.distanceTo(pos)); }

/* ---------- loop ---------- */
let last = performance.now(), time = 0;
let swayPrev = 0;
function frame(now) {
  const dt = Math.min(.05, (now - last) / 1000); last = now; time += dt;
  const sp = (keys.has("shift") ? 2 : 1) * 320 * dt;
  if (keys.has("w") || keys.has("s")) { const dir = keys.has("w") ? -1 : 1; goal.x += Math.sin(cam.yaw) * sp * dir; goal.z += Math.cos(cam.yaw) * sp * dir; }
  if (keys.has("a")) cam.yaw += 1.4 * dt;
  if (keys.has("d")) cam.yaw -= 1.4 * dt;
  if (!calm) { ringAngle += dt * .012; placeRing(); }
  const sn = selectedId && graph.byId.get(selectedId);
  if (sn && sn.ring && !keys.size) goal.set(sn.x, sn.y, sn.z); // keep following a drifting ring node
  target.lerp(goal, 1 - Math.pow(.001, dt));
  // a soft sway (about 7 degrees each way) instead of a full spin, applied as a change so manual orbiting is kept
  const sway = calm || dragging ? swayPrev : Math.sin(time * .15) * .12;
  cam.yaw += sway - swayPrev; swayPrev = sway;
  const cp = Math.cos(cam.pit), dd = cam.dist * Math.min(1.8, Math.max(1, .85 / camera.aspect)); // pull back on portrait screens
  camera.position.set(target.x + Math.sin(cam.yaw) * cp * dd, target.y + Math.sin(cam.pit) * dd, target.z + Math.cos(cam.yaw) * cp * dd);
  camera.lookAt(target);
  camera.updateMatrixWorld();
  if (dust && !calm) dust.rotation.y += dt * .004;

  // hover by screen distance
  hoverId = null;
  let best = 1e9;
  for (const o of objs) {
    if (!o.sprite.visible) continue;
    const s = toScreen(o.sprite.position); if (!s) continue;
    const dpx = Math.hypot(mx - s.x, my - s.y), r = o.R * pxPerUnit(o.sprite.position) + 9;
    if (dpx <= r && dpx < best) { best = dpx; hoverId = o.n.id; }
  }
  cv.style.cursor = dragging ? "grabbing" : hoverId ? "pointer" : "grab";

  // node glow and breathing
  const nbrIds = new Set(selectedId ? (graph.nbrs.get(selectedId) || []).map((x) => x.node.id) : []);
  for (const o of objs) {
    const isSel = o.n.id === selectedId, isHov = o.n.id === hoverId;
    const k = isSel ? 4.6 : isHov ? 3.9 : 3.1, tgtOp = isSel ? .9 : isHov ? .7 : .42;
    o.gk += (k - o.gk) * Math.min(1, dt * 8); o.op += (tgtOp - o.op) * Math.min(1, dt * 8);
    const br = calm ? 1 : 1 + .04 * Math.sin(time * 1.3 + o.ph);
    o.sprite.scale.setScalar(o.R * 3.05 * br);
    if (o.glow) { o.glow.scale.setScalar(o.R * 2 * o.gk * br); o.glow.material.opacity = o.op; }
  }
  // links: emphasis and pulses
  let pi = 0;
  for (const l of linkObjs) {
    const tgt = l.sel ? .95 : .3;
    l.op += (tgt - l.op) * Math.min(1, dt * 8); l.line.material.opacity = l.op;
    if (l.sel && l.line.visible && pulses.length && !calm && pi < pulses.length) {
      const p = pulses[pi++], t = (time * .28 + (hash(l.link.a.id + l.link.b.id) % 100) / 100) % 1;
      p.position.copy(l.curve.getPoint(t)); p.visible = true; p.material.opacity = .9;
    }
  }
  for (; pi < pulses.length; pi++) { pulses[pi].visible = false; }

  // selected ring
  const so = selectedId && objs.byId && objs.byId.get(selectedId);
  if (so && so.sprite.visible) {
    const pr = calm ? 0 : (time * .6) % 1;
    selRing.visible = true; selRing.position.copy(so.sprite.position);
    selRing.scale.setScalar(so.R * (3.4 + pr * 2.2)); selRing.material.opacity = calm ? .6 : .75 * (1 - pr * .85);
  } else selRing.visible = false;

  // rings for the other writers, on whatever node each is looking at
  const presShow = [];
  if (me) for (const p of peers) {
    if (p.id === me.writer.id || !p.focus || presShow.length >= presRings.length) continue;
    const po = objs.byId && objs.byId.get(p.focus);
    if (po && po.sprite.visible) presShow.push({ p, o: po });
  }
  presRings.forEach((s, i) => {
    const e = presShow[i];
    if (!e) { s.visible = false; return; }
    const ph = calm ? .5 : (time * .5 + i * .31) % 1;
    s.visible = true; s.position.copy(e.o.sprite.position); s.scale.setScalar(e.o.R * (3.1 + ph * 1.6));
    s.material.color.set(e.p.color); s.material.opacity = .85 * (1 - ph * .7);
  });

  renderer.render(scene, camera);

  // labels
  let li = 0;
  const showLabel = (txt, pos, cls, dy, color, alpha) => {
    const s = toScreen(pos); if (!s || li >= 24) return;
    const d = labelAt(li++); d.textContent = txt; d.className = "lb" + (cls ? " " + cls : "");
    d.style.color = color || "";
    d.style.opacity = alpha == null ? "" : alpha.toFixed(2);
    d.style.display = "block";
    d.style.transform = `translate(${Math.round(s.x)}px,${Math.round(s.y + dy)}px) translateX(-50%)`;
  };
  const want = new Set();
  if (selectedId) want.add(selectedId);
  if (hoverId) want.add(hoverId);
  for (const id of nbrIds) want.add(id);
  for (const id of want) { const o = objs.byId && objs.byId.get(id); if (o && o.sprite.visible) showLabel(o.n.name, o.sprite.position, "", o.R * pxPerUnit(o.sprite.position) * 1.5 + 8); }
  // Desktop mouse only: a name fades in as the pointer nears a node (within NEAR_PX of its edge) and fades out as it leaves.
  for (const o of objs) {
    let target = 0;
    if (mouseOn && !dragging && o.sprite.visible) {
      const s = toScreen(o.sprite.position);
      if (s) { const gap = Math.hypot(mx - s.x, my - s.y) - o.R * pxPerUnit(o.sprite.position); target = gap <= 0 ? 1 : Math.max(0, 1 - gap / NEAR_PX); }
    }
    o.near = (o.near || 0) + (target - (o.near || 0)) * (1 - Math.exp(-dt * (calm ? 5 : 9)));
    if (o.near < .03) o.near = 0;
    if (o.near > 0 && !want.has(o.n.id)) showLabel(o.n.name, o.sprite.position, "", o.R * pxPerUnit(o.sprite.position) * 1.5 + 8, "", o.near);
  }
  for (const l of linkObjs) if (l.sel && l.line.visible && l.link.label) showLabel(l.link.label, l.curve.getPoint(.5), "lk", -6);
  if (graph.lay.hasHelix) {
    // era names float above the flow, centered on their zone
    const lay = graph.lay;
    for (const b of lay.bands) if (b.name) showLabel(b.name, tmpE.set(xOfU((b.u0 + b.u1) / 2, lay), 170, 0), "era", 0);
  }
  for (const e of presShow) showLabel(e.p.name + (e.p.editing ? " is editing" : ""), e.o.sprite.position, "pres", -(e.o.R * pxPerUnit(e.o.sprite.position) * 2.3 + 12), e.p.color);
  for (; li < labelPool.length; li++) labelPool[li].style.display = "none";

  drawMini();
  drawStrip();
  requestAnimationFrame(frame);
}

/* ---------- timeline strip: the flow flattened, click or drag to fly along it ---------- */
const strip = $("strip"), st = $("st"), sctx = st.getContext("2d"), stTip = $("stTip");
let stTicks = [], stGeom = null, stDown = false, stMode = "";
function stripGeometry(w) {
  const tc = graph.lay.timed.length, rc = graph.lay.ringNodes.length, padX = 12;
  const inner = w - padX * 2, gap = tc && rc ? 18 : 0;
  const timedW = tc ? (rc ? Math.round((inner - gap) * .78) : inner) : 0;
  return { padX, timedW, ringX0: padX + timedW + gap, ringW: rc ? inner - timedW - gap : 0 };
}
const stX = (u, g) => g.padX + ((u + .5) / (graph.lay.U + 1)) * g.timedW;
function drawStrip() {
  const lay = graph.lay;
  strip.style.display = graph.nodes.length ? "block" : "none";
  const cssW = st.clientWidth, cssH = st.clientHeight;
  if (!graph.nodes.length || !cssW || !cssH) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  if (st.width !== Math.round(cssW * dpr) || st.height !== Math.round(cssH * dpr)) { st.width = Math.round(cssW * dpr); st.height = Math.round(cssH * dpr); }
  const c = sctx, g = stripGeometry(cssW), base = cssH * .68;
  stGeom = g; stTicks = [];
  const oth = othersFocus();
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, cssW, cssH);
  c.textAlign = "left"; c.font = '10px "Cinzel", Georgia, serif';
  if (lay.timed.length) {
    lay.bands.forEach((b, i) => {
      const x0 = stX(b.u0 - .45, g), x1 = stX(b.u1 + .45, g);
      c.fillStyle = i % 2 ? "rgba(75,79,168,.22)" : "rgba(142,92,143,.18)";
      c.beginPath(); c.roundRect(x0, 4, Math.max(2, x1 - x0), cssH - 8, 6); c.fill();
      if (b.name) {
        let s = b.name.toUpperCase();
        while (s.length > 1 && c.measureText(s).width > x1 - x0 - 8) s = s.slice(0, -1);
        c.fillStyle = "rgba(185,166,214,.9)"; c.fillText(s, x0 + 5, 17);
      }
    });
    c.strokeStyle = "rgba(185,166,214,.35)"; c.lineWidth = 1;
    c.beginPath(); c.moveTo(g.padX, base); c.lineTo(g.padX + g.timedW, base); c.stroke();
  }
  if (lay.ringNodes.length) {
    c.fillStyle = "rgba(169,155,196,.85)"; c.fillText("NO DATE", g.ringX0 + 2, 17);
    c.strokeStyle = "rgba(185,166,214,.18)"; c.beginPath(); c.moveTo(g.ringX0, base); c.lineTo(g.ringX0 + g.ringW, base); c.stroke();
  }
  const dot = (n, x) => {
    const t = TYPES[n.type], sel = n.id === selectedId, off = hidden.has(n.type);
    stTicks.push({ x, n });
    c.globalAlpha = off ? .18 : 1;
    c.globalCompositeOperation = "lighter"; c.fillStyle = rgba(t.rgb, sel ? .55 : .3);
    c.beginPath(); c.arc(x, base, sel ? 9 : 6, 0, TAU); c.fill();
    c.globalCompositeOperation = "source-over"; c.fillStyle = sel ? "#fff" : t.hex;
    c.beginPath(); c.arc(x, base, sel ? 4.6 : 3.2, 0, TAU); c.fill();
    c.globalAlpha = 1;
    const ows = oth.get(n.id); // rings in the other writers' colors
    if (ows) ows.forEach((col, k) => { c.strokeStyle = col; c.lineWidth = 1.8; c.beginPath(); c.arc(x, base, 8.5 + k * 3, 0, TAU); c.stroke(); });
  };
  for (const n of lay.timed) dot(n, stX(n.u, g));
  lay.ringNodes.forEach((n, i) => dot(n, g.ringX0 + ((i + .5) / lay.ringNodes.length) * g.ringW));
  if (lay.timed.length) {
    const u = Math.max(-.5, Math.min(lay.U + .5, target.x / lay.dx + lay.U / 2)), x = stX(u, g);
    c.strokeStyle = "rgba(233,222,247,.85)"; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(x, 5); c.lineTo(x, cssH - 5); c.stroke();
    c.fillStyle = "#E6DDF3"; c.beginPath(); c.moveTo(x - 4, 3); c.lineTo(x + 4, 3); c.lineTo(x, 9); c.closePath(); c.fill();
  }
}
function stHit(x) {
  let best = null, bd = 10;
  for (const t of stTicks) { const d = Math.abs(t.x - x); if (d < bd) { bd = d; best = t.n; } }
  return best;
}
function stSeek(x) {
  const lay = graph.lay, g = stGeom;
  if (!g || !lay.timed.length || x < g.padX - 6 || x > g.padX + g.timedW + 6) return;
  const u = Math.max(0, Math.min(lay.U, ((x - g.padX) / g.timedW) * (lay.U + 1) - .5));
  goal.set(xOfU(u, lay), 0, 0);
}
st.addEventListener("pointerdown", (e) => {
  st.setPointerCapture(e.pointerId); stDown = true;
  const x = e.clientX - st.getBoundingClientRect().left, hit = stHit(x);
  if (hit) { stMode = "node"; select(hit.id); } else { stMode = "seek"; stSeek(x); }
});
st.addEventListener("pointermove", (e) => {
  const r = st.getBoundingClientRect(), x = e.clientX - r.left, hit = stHit(x);
  if (hit) { stTip.textContent = hit.name; stTip.style.left = Math.max(0, Math.min(r.width - 8, x)) + "px"; stTip.style.display = "block"; }
  else stTip.style.display = "none";
  if (stDown && stMode === "seek") stSeek(x);
});
st.addEventListener("pointerup", () => { stDown = false; });
st.addEventListener("pointerleave", () => { stTip.style.display = "none"; });

/* minimap: top-down view */
const mm = $("mm"), mctx = mm.getContext("2d");
let miniSide = false; // false: top-down (X across, Z down). true: side view (X across, height up)
$("mmView").addEventListener("click", () => { miniSide = !miniSide; $("mmView").textContent = miniSide ? "Side" : "Top"; });
function drawMini() {
  const w = 200, h = 100, ox = w / 2, oy = h / 2, lay = graph.lay;
  const vOf = (x, y, z) => (miniSide ? -y : z); // vertical screen axis
  mctx.clearRect(0, 0, w, h);
  let extX = 200, extV = 100;
  for (const n of graph.nodes) { extX = Math.max(extX, Math.abs(n.x)); extV = Math.max(extV, Math.abs(vOf(n.x, n.y, n.z))); }
  const sc = Math.min((w * .46) / extX, (h * .44) / extV); // one scale for both axes, so shapes are not stretched
  mctx.strokeStyle = "rgba(185,166,214,.14)"; mctx.lineWidth = 1;
  mctx.beginPath(); mctx.moveTo(4, oy); mctx.lineTo(w - 4, oy); mctx.stroke(); // center line of the flow
  if (lay.hasHelix) {
    // era boundaries as faint ticks
    mctx.strokeStyle = "rgba(109,114,214,.28)";
    const edges = lay.bands.map((b, i) => xOfU(b.u0 - (i === 0 ? .5 : HX.GAP / 2), lay));
    edges.push(xOfU(lay.bands[lay.bands.length - 1].u1 + .5, lay));
    if (lay.bands.some((b) => b.key !== "")) for (const ex of edges) { mctx.beginPath(); mctx.moveTo(ox + ex * sc, 6); mctx.lineTo(ox + ex * sc, h - 6); mctx.stroke(); }
    // one faint leyline per type, in its tint
    const p = new THREE.Vector3(), x0 = xOfU(-.8, lay), x1 = xOfU(lay.U + .8, lay);
    for (const type of lay.lanes) {
      if (hidden.has(type)) continue;
      mctx.strokeStyle = rgba(TYPES[type].rgb, .38); mctx.beginPath();
      for (let x = x0, first = true; x <= x1 + 1e-6; x += 30, first = false) {
        streamPoint(lay, type, x, p);
        const px = ox + p.x * sc, py = oy + vOf(p.x, p.y, p.z) * sc;
        if (first) mctx.moveTo(px, py); else mctx.lineTo(px, py);
      }
      mctx.stroke();
    }
  }
  for (const n of graph.nodes) {
    if (hidden.has(n.type)) continue;
    const t = TYPES[n.type], sel = n.id === selectedId;
    mctx.fillStyle = sel ? "#fff" : rgba(t.rgb, .9); mctx.shadowColor = t.hex; mctx.shadowBlur = sel ? 8 : 3;
    mctx.beginPath(); mctx.arc(ox + n.x * sc, oy + vOf(n.x, n.y, n.z) * sc, sel ? 3.2 : 2, 0, TAU); mctx.fill();
  }
  mctx.shadowBlur = 0;
  const cx = Math.max(4, Math.min(w - 4, ox + camera.position.x * sc)), cv2 = Math.max(4, Math.min(h - 4, oy + vOf(camera.position.x, camera.position.y, camera.position.z) * sc));
  mctx.strokeStyle = "rgba(233,222,247,.5)"; mctx.beginPath(); mctx.moveTo(cx, cv2); mctx.lineTo(ox + target.x * sc, oy + vOf(target.x, target.y, target.z) * sc); mctx.stroke();
  mctx.fillStyle = "#E6DDF3"; mctx.beginPath(); mctx.arc(cx, cv2, 3, 0, TAU); mctx.fill();
}

/* ---------- identity and presence ---------- */
const byName = (id) => {
  if (!id || !me || me.mode !== "writers") return "";
  if (id === "shared") return "Shared access";
  const w = me.writers.find((x) => x.id === id);
  return w ? w.name : "a former writer";
};
const byText = (id) => (byName(id) ? " by " + byName(id) : "");
async function loadMe() {
  try {
    const r = await fetch("/api/me", { headers: { Accept: "application/json" } });
    if (r.status === 401) { location.replace("/login.html"); return new Promise(() => {}); } // stay put while we leave
    if (r.ok) me = await r.json();
  } catch (e) { /* offline: the first state load will show the error */ }
}
// node id -> colors of the other writers currently looking at it
function othersFocus() {
  const m = new Map();
  if (me) for (const p of peers) if (p.id !== me.writer.id && p.focus) { if (!m.has(p.focus)) m.set(p.focus, []); m.get(p.focus).push(p.color); }
  return m;
}
function renderPresence() {
  const box = $("presence");
  if (!me || me.mode !== "writers") { box.hidden = true; return; }
  box.hidden = false;
  const on = new Map(peers.map((p) => [p.id, p]));
  const people = [...me.writers];
  if (!people.some((w) => w.id === me.writer.id)) people.unshift(me.writer); // the emergency "Shared access" session
  const kids = people.map((w) => {
    const isMe = w.id === me.writer.id, p = on.get(w.id), live = isMe || !!p;
    const note = isMe ? "you" : p && p.editing ? "editing" : "";
    return el("div", { class: "pw" + (live ? "" : " off"), style: "color:" + w.color, title: w.name + (isMe ? " (you)" : live ? " is online" : " is offline") },
      el("i"), el("span", { style: "color:var(--text)" }, w.name), note ? el("small", null, note) : null);
  });
  kids.push(el("button", { type: "button", onclick: signOut }, "Sign out"));
  box.replaceChildren(...kids);
}
async function signOut() {
  await apiWrite("POST", "/api/logout", {});
  location.replace("/login.html");
}
let pingTimer = 0;
async function sendPresence() {
  if (!me || me.mode !== "writers") return;
  const focus = editing && !editing.isNew ? editing.id : selectedId;
  const r = await apiWrite("POST", "/api/presence", { focus: focus || null, editing: !!editing });
  if (r.status === 200 && r.json) { peers = r.json.online || []; renderPresence(); }
  else if (r.status === 401) location.replace("/login.html");
}
function pingSoon() { clearTimeout(pingTimer); pingTimer = setTimeout(sendPresence, 350); }
function startPresence() {
  if (!me || me.mode !== "writers") return;
  renderPresence();
  sendPresence();
  setInterval(() => { if (!document.hidden) sendPresence(); }, 5000); // a hidden tab goes quiet and drops off after about 25 seconds
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sendPresence(); });
}

/* ---------- start and sync ---------- */
function refreshAll(first) {
  const keep = selectedId;
  rebuildGraph();
  buildLegend();
  buildScene();
  selectedId = keep && graph.byId.has(keep) ? keep : null;
  refreshLinkEmphasis();
  showDetail();
  chatSync();
  HOME.dist = graph.homeDist;
  scene.fog.density = Math.min(0.00042, 0.00042 * 1100 / graph.homeDist); // keep the far end of a long flow visible
  if (first) { cam.dist = HOME.dist; goal.copy(centroid()); target.copy(goal); }
  const nHidden = [...model.rows.values()].filter((r) => r.hidden).length;
  $("hiddenBtn").style.display = nHidden ? "" : "none";
  $("hiddenBtn").textContent = "Hidden (" + nHidden + ")";
  hideState();
}
async function poll(first) {
  try {
    const s = await fetchState(first ? 0 : Math.max(0, model.seq - POLL_OVERLAP));
    const changed = applyState(s);
    online = true; lastSync = Date.now();
    if (first || changed) refreshAll(first);
  } catch (e) {
    if (e.status === 401 && me && me.mode === "writers") { location.replace("/login.html"); return; }
    online = false;
    if (first) {
      showState("Could not load the map", e.status === 401 ? "Sign in with the shared password, then reload." : "The server did not answer. Check your connection and reload.", true);
    }
  }
  setSync();
}

setCalm(mq.matches);
resize(); buildDust();
loadMe().then(() => poll(true)).then(() => {
  setInterval(() => { if (!document.hidden) poll(false); }, POLL_MS);
  setInterval(setSync, 15000);
  startPresence();
});
requestAnimationFrame(frame);
})();
