/* The Throat client, slice 2a: read-only 3D map.
 * Signed Maridizzle
 *
 * Sections: constants, model and API, layout (temporary), scene, UI, loop.
 * Node record (data field): { type, name, summary, links:[{to, label}] }.
 * Links live on the source node. User text is only ever inserted with
 * textContent, never innerHTML.
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
  other: { label: "Untyped", hex: "#9A8FB5", shape: "circle" },
};
const TYPE_ORDER = ["character", "place", "rule", "thread", "question", "other"];
const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
for (const k in TYPES) TYPES[k].rgb = hex2rgb(TYPES[k].hex);
const mixc = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const PLUM = [26, 15, 38], WHITE = [255, 255, 255];
const POLL_MS = 8000, POLL_OVERLAP = 8;

/* ---------- model and API ---------- */
const model = { rows: new Map(), seq: 0 };
let lastSync = 0, online = true;

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
  model.seq = Math.max(model.seq, s.seq || 0);
  return changed;
}

/* ---------- graph derived from rows ---------- */
let graph = { nodes: [], byId: new Map(), links: [], nbrs: new Map() };
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
// TEMPORARY layout: clusters by type. Slice 2b replaces this with the story-time helix.
const CENTERS = {
  character: [-230, 30, -20], place: [210, -70, 50], rule: [-10, 170, -190],
  thread: [-70, -180, 170], question: [80, 40, 270], other: [0, 0, 0],
};
function layoutFor(id, type) {
  const r = rng(hash(id)), g = () => (r() + r() + r() - 1.5) * 2, c = CENTERS[type];
  return { x: c[0] + g() * 85, y: c[1] + g() * 85, z: c[2] + g() * 85 };
}
function rebuildGraph() {
  const nodes = [], byId = new Map();
  for (const row of model.rows.values()) {
    if (row.hidden) continue;
    const d = row.data || {};
    const type = TYPES[d.type] ? d.type : "other";
    const p = d.pos && isFinite(d.pos.x) && isFinite(d.pos.y) && isFinite(d.pos.z) ? d.pos : layoutFor(row.id, type);
    const n = { id: row.id, type, name: String(d.name || row.id), summary: String(d.summary || ""),
      x: p.x, y: p.y, z: p.z, deg: 0, updated_at: row.updated_at, raw: d };
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
  graph = { nodes, byId, links, nbrs };
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
const camera = new THREE.PerspectiveCamera(50, 1, 5, 4000);
let W = 0, H = 0;

let quality = 2, calm = false;
const cam = { yaw: 0.5, pit: 0.32, dist: 780 };
const HOME = { yaw: 0.5, pit: 0.32, dist: 780 };
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
  const n = { diamond: 4, hexagon: 6, triangle: 3 }[shape], rot = shape === "hexagon" ? 0 : -Math.PI / 2;
  const k = shape === "diamond" ? 1.2 : 1.08;
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
function clearGroup() {
  for (const o of objs) { o.sprite.material.dispose(); if (o.glow) o.glow.material.dispose(); }
  for (const l of linkObjs) { l.line.geometry.dispose(); l.line.material.dispose(); }
  for (const p of pulses) p.material.dispose();
  pulses.length = 0;
  while (group.children.length) group.remove(group.children[0]);
  objs = []; linkObjs = [];
}
const radiusOf = (n) => 16 + Math.min(n.deg, 7) * 2.2;
function buildScene() {
  clearGroup();
  const byId = new Map();
  for (const l of graph.links) {
    const A = new THREE.Vector3(l.a.x, l.a.y, l.a.z), B = new THREE.Vector3(l.b.x, l.b.y, l.b.z);
    const mid = A.clone().add(B).multiplyScalar(.5);
    const perp = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3(0, 1, 0));
    if (perp.lengthSq() < 1e-6) perp.set(1, 0, 0);
    perp.normalize().multiplyScalar(A.distanceTo(B) * l.bend);
    const curve = new THREE.QuadraticBezierCurve3(A, mid.add(perp), B);
    const pts = curve.getPoints(28), col = new Float32Array(pts.length * 3);
    const ca = TYPES[l.a.type].rgb, cb = TYPES[l.b.type].rgb;
    pts.forEach((_, i) => { const t = i / (pts.length - 1); col[i * 3] = (ca[0] + (cb[0] - ca[0]) * t) / 255; col[i * 3 + 1] = (ca[1] + (cb[1] - ca[1]) * t) / 255; col[i * 3 + 2] = (ca[2] + (cb[2] - ca[2]) * t) / 255; });
    const geo = new THREE.BufferGeometry().setFromPoints(pts); geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .3,
      blending: THREE.AdditiveBlending, depthWrite: false }));
    line.renderOrder = 0; group.add(line);
    linkObjs.push({ link: l, line, curve, op: .3 });
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
  applyVisibility();
}
const selRing = new THREE.Sprite(new THREE.SpriteMaterial({ map: selRingTex, color: 0xE9DEF7, transparent: true,
  depthWrite: false, blending: THREE.AdditiveBlending, opacity: .7 }));
selRing.renderOrder = 3;
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
    lg.append(el("label", { style: "color:" + t.hex }, cb, svg, el("span", { style: "color:var(--text)" }, t.label), el("span", { class: "n" }, counts[k] || 0)));
  }
}
function relTime(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (!isFinite(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return Math.floor(s / 86400) + " d ago";
}
function showDetail() {
  const d = $("detail"), n = selectedId && graph.byId.get(selectedId);
  if (!n) {
    d.replaceChildren(el("h2", null, graph.nodes.length ? "Nothing selected" : "Empty map"),
      el("p", { class: "dim" }, graph.nodes.length ? "Click a node to fly to it." : "Nodes will appear here as you and your co-writer add them."));
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
    el("div", { class: "f" }, "Connected to (" + nb.length + ")"),
    nb.length ? list : el("p", { class: "dim" }, "No links yet."),
    el("div", { class: "f" }, "Last changed"), el("p", null, relTime(n.updated_at)));
}
function setSync() {
  const p = $("sync");
  p.className = online ? "" : "off";
  p.textContent = online ? (lastSync ? "Synced " + relTime(new Date(lastSync).toISOString()) : "Connecting...") : "Offline, retrying";
}

/* ---------- selection and camera ---------- */
function select(id) {
  selectedId = id && graph.byId.has(id) ? id : null;
  const n = selectedId && graph.byId.get(selectedId);
  if (n) goal.set(n.x, n.y, n.z);
  refreshLinkEmphasis();
  showDetail();
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
let dragging = false, px = 0, py = 0, moved = 0, mx = -999, my = -999;
cv.addEventListener("pointerdown", (e) => { cv.setPointerCapture(e.pointerId); dragging = true; cv.classList.add("drag"); px = e.clientX; py = e.clientY; moved = 0; });
cv.addEventListener("pointermove", (e) => {
  mx = e.clientX; my = e.clientY;
  if (!dragging) return;
  const dx = e.clientX - px, dy = e.clientY - py; px = e.clientX; py = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
  cam.yaw -= dx * .0052; cam.pit = Math.max(-1.25, Math.min(1.25, cam.pit + dy * .0052));
});
cv.addEventListener("pointerup", () => { dragging = false; cv.classList.remove("drag"); if (moved < 6) select(hoverId); });
cv.addEventListener("pointerleave", () => { mx = my = -999; });
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

/* ---------- labels ---------- */
const labelPool = [];
function labelAt(i) {
  if (!labelPool[i]) { const d = el("div", { class: "lb" }); $("labels").append(d); labelPool[i] = d; }
  return labelPool[i];
}
const tmp = new THREE.Vector3();
function toScreen(v) {
  tmp.copy(v).project(camera);
  if (tmp.z > 1 || tmp.z < -1) return null;
  return { x: (tmp.x * .5 + .5) * W, y: (-tmp.y * .5 + .5) * H };
}
function pxPerUnit(pos) { return H / (2 * Math.tan(camera.fov * Math.PI / 360) * camera.position.distanceTo(pos)); }

/* ---------- loop ---------- */
let last = performance.now(), time = 0;
function frame(now) {
  const dt = Math.min(.05, (now - last) / 1000); last = now; time += dt;
  const sp = (keys.has("shift") ? 2 : 1) * 320 * dt;
  if (keys.has("w") || keys.has("s")) { const dir = keys.has("w") ? -1 : 1; goal.x += Math.sin(cam.yaw) * sp * dir; goal.z += Math.cos(cam.yaw) * sp * dir; }
  if (keys.has("a")) cam.yaw += 1.4 * dt;
  if (keys.has("d")) cam.yaw -= 1.4 * dt;
  target.lerp(goal, 1 - Math.pow(.001, dt));
  if (!calm && !dragging) cam.yaw += dt * .035;
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

  renderer.render(scene, camera);

  // labels
  let li = 0;
  const showLabel = (txt, pos, cls, dy) => {
    const s = toScreen(pos); if (!s || li >= 24) return;
    const d = labelAt(li++); d.textContent = txt; d.className = "lb" + (cls ? " " + cls : "");
    d.style.display = "block";
    d.style.transform = `translate(${Math.round(s.x)}px,${Math.round(s.y + dy)}px) translateX(-50%)`;
  };
  const want = new Set();
  if (selectedId) want.add(selectedId);
  if (hoverId) want.add(hoverId);
  for (const id of nbrIds) want.add(id);
  for (const id of want) { const o = objs.byId && objs.byId.get(id); if (o && o.sprite.visible) showLabel(o.n.name, o.sprite.position, "", o.R * pxPerUnit(o.sprite.position) * 1.5 + 8); }
  for (const l of linkObjs) if (l.sel && l.line.visible && l.link.label) showLabel(l.link.label, l.curve.getPoint(.5), "lk", -6);
  for (; li < labelPool.length; li++) labelPool[li].style.display = "none";

  drawMini();
  requestAnimationFrame(frame);
}

/* minimap: top-down view */
const mm = $("mm"), mctx = mm.getContext("2d");
function drawMini() {
  const w = 150, h = 150, ox = w / 2, oy = h / 2;
  mctx.clearRect(0, 0, w, h);
  let ext = 200;
  for (const n of graph.nodes) ext = Math.max(ext, Math.abs(n.x - 0), Math.abs(n.z - 0));
  const sc = (w * .44) / ext;
  mctx.strokeStyle = "rgba(185,166,214,.12)"; mctx.lineWidth = 1;
  mctx.beginPath(); mctx.arc(ox, oy, w * .45, 0, TAU); mctx.stroke();
  mctx.beginPath(); mctx.arc(ox, oy, w * .22, 0, TAU); mctx.stroke();
  for (const n of graph.nodes) {
    if (hidden.has(n.type)) continue;
    const t = TYPES[n.type], sel = n.id === selectedId;
    mctx.fillStyle = sel ? "#fff" : rgba(t.rgb, .9); mctx.shadowColor = t.hex; mctx.shadowBlur = sel ? 8 : 3;
    mctx.beginPath(); mctx.arc(ox + n.x * sc, oy + n.z * sc, sel ? 3.2 : 2, 0, TAU); mctx.fill();
  }
  mctx.shadowBlur = 0;
  const cx = Math.max(4, Math.min(w - 4, ox + camera.position.x * sc)), cz = Math.max(4, Math.min(h - 4, oy + camera.position.z * sc));
  mctx.strokeStyle = "rgba(233,222,247,.5)"; mctx.beginPath(); mctx.moveTo(cx, cz); mctx.lineTo(ox + target.x * sc, oy + target.z * sc); mctx.stroke();
  mctx.fillStyle = "#E6DDF3"; mctx.beginPath(); mctx.arc(cx, cz, 3, 0, TAU); mctx.fill();
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
  if (first) { goal.copy(centroid()); target.copy(goal); }
  if (!graph.nodes.length) showState("Empty map", "No nodes yet. They will appear here as you and your co-writer add them.", false); else hideState();
}
async function poll(first) {
  try {
    const s = await fetchState(first ? 0 : Math.max(0, model.seq - POLL_OVERLAP));
    const changed = applyState(s);
    online = true; lastSync = Date.now();
    if (first || changed) refreshAll(first);
  } catch (e) {
    online = false;
    if (first) {
      showState("Could not load the map", e.status === 401 ? "Sign in with the shared password, then reload." : "The server did not answer. Check your connection and reload.", true);
    }
  }
  setSync();
}

setCalm(mq.matches);
resize(); buildDust();
poll(true).then(() => {
  setInterval(() => { if (!document.hidden) poll(false); }, POLL_MS);
  setInterval(setSync, 15000);
});
requestAnimationFrame(frame);
})();
