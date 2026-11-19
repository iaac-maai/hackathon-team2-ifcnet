// IFC Check: page logic (upload, verdict, similar elements, saved results) + the 3D stage and the example shelf.
// three.js is loaded with a dynamic import: if the CDN fails, upload and results still work.
// Every value coming from the server or from a file name is written with textContent, never innerHTML.

window.__ifcAppStarted = true;

const $ = (id) => document.getElementById(id);
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const WAKING = "The model server is waking up. This takes about a minute, please wait…";

const statusLine = $("status");
let busy = false;
let pendingFile = null;
let lastResult = null;
let examples = [];
let galleryPoints = null;      // { file_name: [[x,y,z] x256] }, loaded lazily
let galleryPromise = null;
let stage = null;              // 3D stage API (null until three.js is loaded, or if it failed)
let thumbs = null;             // shared offscreen renderer for shelf + similar thumbnails

// ---------------------------------------------------------------- small helpers
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const wait = (ms) => new Promise((r) => setTimeout(r, REDUCED ? 0 : ms));
const hexRgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
const EL_COL = hexRgb(0x3E5A49);   // --sage-deep: your element
const REC_COL = hexRgb(0xC9932F);  // --mustard: the reconstruction
const CMP_COL = hexRgb(0xB5562E);  // --rust: a gallery element in Compare
const HEAT = [hexRgb(0x3E5A49), hexRgb(0xC9932F), hexRgb(0xB5562E)];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tween(duration, onUpdate, ease = easeOutCubic) {
  return new Promise((resolve) => {
    if (REDUCED || duration <= 0) { onUpdate(1); resolve(); return; }
    const start = performance.now();
    (function step(now) {
      const t = Math.min(1, (now - start) / duration);
      onUpdate(ease(t));
      if (t < 1) requestAnimationFrame(step); else resolve();
    })(start);
  });
}

function setPill(state, text) {
  $("pill").dataset.state = state;
  $("pill-text").textContent = text;
}

// ---------------------------------------------------------------- upload flow
const form = $("upload");
const input = $("ifc");

function chooseFile(file) {
  pendingFile = file || null;
  $("chosen").textContent = file ? file.name : "";
  $("send").disabled = !file || busy;
}

input.addEventListener("change", () => chooseFile(input.files[0]));
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (pendingFile) analyse(pendingFile);
});

// Drag and drop: on the upload card and on the 3D stage
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
document.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  form.classList.add("is-over");
  $("stage").classList.add("is-over");
});
document.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) { form.classList.remove("is-over"); $("stage").classList.remove("is-over"); }
});
document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); // never let the browser open the file itself
  dragDepth = 0;
  form.classList.remove("is-over");
  $("stage").classList.remove("is-over");
  const file = e.dataTransfer.files[0];
  if (file) { chooseFile(file); analyse(file); }
});

async function analyse(file) {
  if (busy) return;
  busy = true;
  chooseFile(file);
  $("send").disabled = true;
  clearResult();
  statusLine.className = "status";
  statusLine.textContent = "Sending to the model…";
  setPill("busy", "Analysing…");
  // A normal answer takes a few seconds; if it takes longer, the free Render server is probably asleep
  const wakingTimer = setTimeout(() => {
    statusLine.className = "status waking";
    statusLine.textContent = WAKING;
    setPill("waking", "Waking up…");
  }, 5000);

  try {
    const body = new FormData();
    body.append("ifc", file);
    const response = await fetch("/api/predict", { method: "POST", body });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`Unexpected answer from the server (HTTP ${response.status}). If you were logged out, reload the page.`);
    }
    if (!response.ok) {
      const error = new Error(result.error || response.statusText);
      error.waking = result.waking;
      throw error;
    }
    showResult(result);
    statusLine.className = "status";
    statusLine.textContent = "Saved.";
    setPill("ready", "Ready");
    loadHistory();
  } catch (error) {
    statusLine.className = "status " + (error.waking ? "waking" : "error");
    statusLine.textContent = error.message;
    setPill(error.waking ? "waking" : "error", error.waking ? "Waking up…" : "Error");
  } finally {
    clearTimeout(wakingTimer);
    busy = false;
    $("send").disabled = !pendingFile;
  }
}

// ---------------------------------------------------------------- verdict + gauge
const G = { x: 100, y: 100, r: 80 };
function gaugePoint(f) {
  const a = Math.PI * (1 - f);
  return [G.x + G.r * Math.cos(a), G.y - G.r * Math.sin(a)];
}
function gaugeArc(f0, f1) {
  if (f1 - f0 < 0.001) return "";
  const [x0, y0] = gaugePoint(f0);
  const [x1, y1] = gaugePoint(f1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${G.r} ${G.r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
$("g-track").setAttribute("d", gaugeArc(0, 1));

function clearResult() {
  lastResult = null;
  const card = $("verdict-card");
  card.classList.add("is-empty");
  $("verdict").className = "verdict";
  $("verdict").textContent = "—";
  $("file").textContent = "Waiting for an element";
  for (const id of ["m-score", "m-threshold", "m-ratio"]) $(id).textContent = "—";
  showSimilar([], "");
  $("similar-empty").hidden = false;
  if (stage) stage.clearResult();
}

function showResult(result) {
  lastResult = result;
  const card = $("verdict-card");
  card.classList.remove("is-empty", "pop");
  void card.offsetWidth; // restart the entry animation
  card.classList.add("pop");

  const verdict = $("verdict");
  verdict.textContent = result.unusual ? "Unusual" : "Normal";
  verdict.className = "verdict " + (result.unusual ? "anomaly" : "normal");
  $("file").textContent = result.file_name;
  animateGauge(result.score, result.threshold);

  showSimilar(result.similar || [], result.gallery_warning);

  // 3D view (only if the model server sent the points; older servers send null)
  if (stage) {
    if (result.points && result.reconstruction) {
      try { stage.showResult(result.points, result.reconstruction); }
      catch (e) { console.error(e); stage.message("The 3D view could not draw this result."); }
    } else {
      stage.message("This answer has no 3D points (older model server).");
    }
  }
}

function animateGauge(score, threshold) {
  const max = Math.max(threshold * 2, score * 1.12);
  const fT = threshold / max;
  const fS = Math.min(1, score / max);
  const ratio = score / threshold;
  const tick = [gaugePoint(fT), [G.x + (G.r - 14) * Math.cos(Math.PI * (1 - fT)), G.y - (G.r - 14) * Math.sin(Math.PI * (1 - fT))]];
  const t = $("g-tick");
  t.setAttribute("x1", tick[0][0] + (tick[0][0] - G.x) * 0.12);
  t.setAttribute("y1", tick[0][1] + (tick[0][1] - G.y) * 0.12);
  t.setAttribute("x2", tick[1][0]);
  t.setAttribute("y2", tick[1][1]);
  tween(1300, (p) => {
    $("g-ok").setAttribute("d", gaugeArc(0, fT * p));
    $("g-bad").setAttribute("d", gaugeArc(fT, fT + (1 - fT) * p));
    $("g-needle").setAttribute("transform", `rotate(${(-90 + 180 * fS * p).toFixed(2)} 100 100)`);
    $("m-score").textContent = (score * p).toFixed(4);
    $("m-threshold").textContent = (threshold * p).toFixed(4);
    $("m-ratio").textContent = (ratio * p).toFixed(2) + "×";
  });
}

// ---------------------------------------------------------------- similar elements
function ensureGallery() {
  if (!galleryPromise) {
    galleryPromise = fetch("/gallery_points.json")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((data) => { galleryPoints = data && typeof data === "object" ? data : null; return galleryPoints; });
  }
  return galleryPromise;
}

function showSimilar(similar, warning) {
  const list = $("similar");
  if (thumbs) thumbs.removeIn(list);
  list.replaceChildren();
  $("gallery-warning").textContent = warning || "";
  $("similar-empty").hidden = similar.length > 0 || !!warning;
  if (!similar.length) { updateCompareButton(); return; }

  similar.forEach((item, i) => {
    const li = el("li", "enter");
    li.style.setProperty("--i", i);
    const button = el("button", "sim");
    button.type = "button";
    button.dataset.index = String(i);
    const thumb = el("canvas", "sim-thumb");
    thumb.width = 112; thumb.height = 112;
    const body = el("span", "sim-body");
    const top = el("span", "sim-top");
    top.append(el("span", "sim-class", item.ifc_class), el("span", "sim-val", Number(item.similarity).toFixed(3)));
    const bar = el("span", "sim-bar");
    const fill = el("i");
    bar.append(fill);
    body.append(top, bar, el("span", "sim-file", item.file_name));
    button.append(el("span", "sim-rank", String(i + 1).padStart(2, "0")), thumb, body);
    button.addEventListener("click", () => selectCompare(i));
    li.append(button);
    list.append(li);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      fill.style.width = `${Math.max(0, Math.min(1, item.similarity)) * 100}%`;
    }));
  });

  const forResult = lastResult;
  ensureGallery().then(() => {
    if (lastResult !== forResult) return;
    list.querySelectorAll(".sim").forEach((button) => {
      const item = similar[Number(button.dataset.index)];
      const pts = galleryPoints && galleryPoints[item.file_name];
      const canvas = button.querySelector("canvas");
      if (pts && thumbs) {
        thumbs.add(canvas, pts, {});
      } else {
        const none = el("span", "sim-thumb none", "No\npreview");
        none.style.whiteSpace = "pre";
        canvas.replaceWith(none);
        if (!pts) { button.disabled = true; button.title = "No point preview for this element"; }
      }
    });
    updateCompareButton();
  });
}

function selectCompare(i) {
  if (!lastResult || !stage || !galleryPoints) return;
  const item = (lastResult.similar || [])[i];
  const pts = item && galleryPoints[item.file_name];
  if (!pts || !stage.hasResult()) return;
  document.querySelectorAll(".sim").forEach((b) => b.classList.toggle("is-active", b.dataset.index === String(i)));
  stage.setCompare(pts, item.ifc_class, Number(item.similarity));
  stage.setView("compare");
}

function firstComparable() {
  if (!lastResult || !galleryPoints) return -1;
  return (lastResult.similar || []).findIndex((s) => galleryPoints[s.file_name]);
}

function updateCompareButton() {
  const b = document.querySelector('[data-view="compare"]');
  b.disabled = !(stage && stage.hasResult() && firstComparable() >= 0);
  b.title = b.disabled ? "Analyse an element first: then pick a similar element on the right" : "";
}

// ---------------------------------------------------------------- saved results
async function loadHistory() {
  let rows;
  try {
    const response = await fetch("/api/history");
    if (!response.ok) return;
    rows = await response.json();
  } catch { return; }
  const tbody = $("history");
  tbody.replaceChildren();
  if (!rows.length) {
    const tr = el("tr");
    const td = el("td", "empty", "No saved results yet.");
    td.colSpan = 5;
    tr.append(td);
    tbody.append(tr);
    return;
  }
  rows.forEach((row, i) => {
    const tr = el("tr", "enter");
    tr.style.setProperty("--i", Math.min(i, 12));
    tr.append(
      el("td", "num", String(row.created_at).replace("T", " ").slice(0, 19)),
      el("td", "file-cell", row.file_name || ""),   // textContent: a file name can't inject HTML
      el("td", "num", Number(row.score).toFixed(4)),
      el("td", "num", Number(row.threshold).toFixed(4)),
    );
    const verdict = el("td");
    verdict.append(el("span", "chip " + (row.is_anomaly ? "anomaly" : "normal"), row.is_anomaly ? "Unusual" : "Normal"));
    tr.append(verdict);
    tbody.append(tr);
  });
}

// ---------------------------------------------------------------- example shelf
async function loadExamples() {
  try {
    const r = await fetch("/examples/examples.json");
    if (!r.ok) return;
    const data = await r.json();
    examples = Array.isArray(data) ? data.filter((e) => e && e.file && Array.isArray(e.points) && e.points.length) : [];
  } catch { examples = []; }
  if (!examples.length) return; // shelf stays hidden

  $("shelf-section").hidden = false;
  const shelf = $("shelf");
  examples.forEach((ex, i) => {
    const book = el("button", "book enter");
    book.type = "button";
    book.style.setProperty("--i", i);
    book.setAttribute("aria-label", `Analyse example ${ex.label || ex.file}`);
    const canvas = el("canvas");
    const label = el("span", "book-label");
    label.append(el("span", "label", String(ex.label || "IFC element")),
                 el("span", "label", `${ex.points.length} points`));
    book.append(canvas, el("span", "book-num", String(i + 1).padStart(2, "0")), label);
    if (!REDUCED) {
      book.addEventListener("pointermove", (e) => {
        const r = book.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        book.style.setProperty("--ry", `${(x * 16).toFixed(2)}deg`);
        book.style.setProperty("--rx", `${(-y * 10).toFixed(2)}deg`);
      });
    }
    book.addEventListener("pointerenter", () => { if (canvas.__thumb) canvas.__thumb.hover = true; });
    book.addEventListener("pointerleave", () => {
      book.style.removeProperty("--ry"); book.style.removeProperty("--rx");
      if (canvas.__thumb) canvas.__thumb.hover = false;
    });
    book.addEventListener("click", () => runExample(ex, book));
    shelf.append(book);
  });
  if (thumbs) attachShelfThumbs();
}

function attachShelfThumbs() {
  $("shelf").querySelectorAll(".book").forEach((book, i) => {
    const canvas = book.querySelector("canvas");
    if (!canvas.__thumb) thumbs.add(canvas, examples[i].points, { shelf: true });
  });
}

async function runExample(ex, book) {
  if (busy) return;
  book.classList.add("is-loading");
  try {
    const r = await fetch(`/examples/${encodeURIComponent(ex.file)}`);
    if (!r.ok) throw new Error(`Could not load the example file (HTTP ${r.status}).`);
    const blob = await r.blob();
    const file = new File([blob], ex.file, { type: "application/octet-stream" });
    $("workspace").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
    await analyse(file);
  } catch (error) {
    statusLine.className = "status error";
    statusLine.textContent = error.message;
  } finally {
    book.classList.remove("is-loading");
  }
}

// ---------------------------------------------------------------- 3D: shared shader for glowing points
const POINT_VERT = /* glsl */`
  attribute vec3 aColor;
  uniform float uSize;
  uniform float uScale;
  uniform float uNear;
  uniform float uFar;
  varying vec3 vColor;
  varying float vFade;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    float depth = max(0.05, -mv.z);
    gl_PointSize = uSize * uScale / depth;
    vFade = 1.0 - 0.45 * smoothstep(uNear, uFar, depth);
    vColor = aColor;
  }`;
const POINT_FRAG = /* glsl */`
  uniform float uOpacity;
  uniform vec3 uTint;
  uniform float uTintMix;
  varying vec3 vColor;
  varying float vFade;
  void main() {
    // Normal blending on a light background: a solid soft-edged disc + a faint halo
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float core = 1.0 - smoothstep(0.40, 0.55, d);
    float halo = (1.0 - smoothstep(0.45, 1.0, d)) * 0.18;
    float a = max(core * 0.92, halo) * uOpacity * vFade;
    gl_FragColor = vec4(mix(vColor, uTint, uTintMix), a);
  }`;

function pointMaterial(THREE) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: 0.05 }, uScale: { value: 500 }, uOpacity: { value: 1 },
      uNear: { value: 2 }, uFar: { value: 5 },
      uTint: { value: new THREE.Vector3(1, 1, 1) }, uTintMix: { value: 0 },
    },
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });
}

function toF32(points) {
  const out = new Float32Array(points.length * 3);
  points.forEach((p, i) => { out[i * 3] = +p[0]; out[i * 3 + 1] = +p[1]; out[i * 3 + 2] = +p[2]; });
  return out;
}
function fillColor(n, rgb) {
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) out.set(rgb, i * 3);
  return out;
}
function sphereOf(pos) {
  const n = pos.length / 3;
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
    const v = pos[i * 3 + k];
    if (v < min[k]) min[k] = v;
    if (v > max[k]) max[k] = v;
  }
  const c = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let r = 0;
  for (let i = 0; i < n; i++) {
    const dx = pos[i * 3] - c[0], dy = pos[i * 3 + 1] - c[1], dz = pos[i * 3 + 2] - c[2];
    r = Math.max(r, Math.hypot(dx, dy, dz));
  }
  return { c, r: Math.max(r, 0.05), minZ: min[2] };
}
function heat(t) {
  const [a, b] = t < 0.5 ? [HEAT[0], HEAT[1]] : [HEAT[1], HEAT[2]];
  const u = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

// A point cloud that can flow (positions + colours) and fade
class Cloud {
  constructor(THREE, cap = 2048) {
    this.cap = cap;
    this.n = 0;
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.from = { pos: new Float32Array(cap * 3), col: new Float32Array(cap * 3) };
    this.to = { pos: new Float32Array(cap * 3), col: new Float32Array(cap * 3) };
    this.geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("position", this.posAttr);
    this.geo.setAttribute("aColor", this.colAttr);
    this.geo.setDrawRange(0, 0);
    this.mat = pointMaterial(THREE);
    this.obj = new THREE.Points(this.geo, this.mat);
    this.obj.frustumCulled = false;
    this.anim = null;
    this.fade = null;
  }
  setCount(n) { this.n = Math.min(n, this.cap); this.geo.setDrawRange(0, this.n); }
  set(pos, col) {
    this.setCount(pos.length / 3);
    this.pos.set(pos.subarray(0, this.n * 3));
    if (col) this.col.set(col.subarray(0, this.n * 3));
    this.posAttr.needsUpdate = true; this.colAttr.needsUpdate = true;
    if (this.anim) this.anim.resolve(false);
    this.anim = null;
  }
  // Flow to new positions/colours. Arrays of a different length are matched by index (i mod length).
  flow(pos, col, ms, delay = 0, ease = easeInOutCubic) {
    if (this.anim) this.anim.resolve(false);
    const n = pos ? pos.length / 3 : this.n;
    if (pos && n !== this.n) {
      const old = this.n || 1;
      for (let i = this.n; i < n; i++) for (let k = 0; k < 3; k++) {
        this.pos[i * 3 + k] = this.pos[(i % old) * 3 + k];
        this.col[i * 3 + k] = this.col[(i % old) * 3 + k];
      }
      this.setCount(n);
    }
    this.from.pos.set(this.pos.subarray(0, n * 3));
    this.from.col.set(this.col.subarray(0, n * 3));
    this.to.pos.set((pos || this.pos).subarray(0, n * 3));
    this.to.col.set((col || this.col).subarray(0, n * 3));
    if (REDUCED || ms <= 0) {
      this.pos.set(this.to.pos.subarray(0, n * 3)); this.col.set(this.to.col.subarray(0, n * 3));
      this.posAttr.needsUpdate = true; this.colAttr.needsUpdate = true;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      this.anim = { start: performance.now() + delay, ms, ease, resolve };
    });
  }
  opacity(v, ms = 400) {
    const u = this.mat.uniforms.uOpacity;
    if (REDUCED || ms <= 0) { u.value = v; this.fade = null; return; }
    this.fade = { start: performance.now(), ms, from: u.value, to: v };
  }
  update(now) {
    if (this.anim && now >= this.anim.start) {
      const t = Math.min(1, (now - this.anim.start) / this.anim.ms);
      const e = this.anim.ease(t);
      const m = this.n * 3;
      for (let i = 0; i < m; i++) {
        this.pos[i] = this.from.pos[i] + (this.to.pos[i] - this.from.pos[i]) * e;
        this.col[i] = this.from.col[i] + (this.to.col[i] - this.from.col[i]) * e;
      }
      this.posAttr.needsUpdate = true; this.colAttr.needsUpdate = true;
      if (t >= 1) { const done = this.anim.resolve; this.anim = null; done(true); }
    }
    if (this.fade) {
      const t = Math.min(1, (now - this.fade.start) / this.fade.ms);
      this.mat.uniforms.uOpacity.value = this.fade.from + (this.fade.to - this.fade.from) * easeOutCubic(t);
      if (t >= 1) this.fade = null;
    }
  }
}

// Random cloud around a centre, used by the intro "scatter in" animation (decoration only, not data)
function scatterFrom(pos, s) {
  const n = pos.length / 3;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, rr = s.r * (2.2 + Math.random() * 1.6);
    const q = Math.sqrt(1 - u * u);
    out[i * 3] = s.c[0] + rr * q * Math.cos(th);
    out[i * 3 + 1] = s.c[1] + rr * q * Math.sin(th);
    out[i * 3 + 2] = s.c[2] + rr * u;
  }
  return out;
}

// ---------------------------------------------------------------- 3D: the stage (ONE WebGL renderer)
function createStage(THREE, OrbitControls) {
  const stageEl = $("stage");
  const host = $("stage-canvas");
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xE3EAE4, 3, 9);   // fades the grid into the --mist background
  const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 100);
  camera.up.set(0, 0, 1); // z is up (IFC world coordinates); set before the controls are made
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = !REDUCED;
  controls.autoRotateSpeed = 0.8;
  controls.minDistance = 0.6;
  controls.maxDistance = 14;

  // Floor: light grid in the XY plane + a soft sage contact shadow under the object
  const grid = new THREE.GridHelper(10, 40, 0xC9D2CA, 0xD3DBD4);
  grid.rotation.x = Math.PI / 2;
  grid.material.transparent = true;
  grid.material.opacity = 1;
  scene.add(grid);
  const glowCanvas = document.createElement("canvas");
  glowCanvas.width = glowCanvas.height = 128;
  const gctx = glowCanvas.getContext("2d");
  const grad = gctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(62,90,73,0.16)");
  grad.addColorStop(1, "rgba(62,90,73,0)");
  gctx.fillStyle = grad;
  gctx.fillRect(0, 0, 128, 128);
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(glowCanvas), transparent: true, depthWrite: false, fog: false }));
  glow.visible = false; // only under a result
  scene.add(glow);

  const A = new Cloud(THREE);   // your element
  const B = new Cloud(THREE);   // the reconstruction
  const C = new Cloud(THREE);   // compare: a gallery element
  for (const c of [A, B]) { c.obj.layers.set(1); scene.add(c.obj); }
  C.obj.layers.set(2); scene.add(C.obj);
  B.opacity(0, 0); C.opacity(0, 0);

  let sizeMul = 1;
  let sphere = { c: [0, 0, 0], r: 1, minZ: -0.6 };
  let R = null;            // current result data
  let compare = null;      // { pos, label, sim }
  let cmode = "side";
  let view = null;
  let token = 0;
  let autoRotateOn = !REDUCED;
  let msgEl = null;
  let lastSide = false;

  function fit(s, smooth, aspectOverride) {
    sphere = s;
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const aspect = Math.max(0.3, aspectOverride || camera.aspect);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
    const dist = (s.r / Math.sin(Math.min(vfov, hfov) / 2)) * 1.12;
    const dir = new THREE.Vector3(1, -1.25, 0.72).normalize();
    const target = new THREE.Vector3(...s.c);
    const goal = target.clone().addScaledVector(dir, dist);
    grid.position.set(s.c[0], s.c[1], s.minZ - 0.04 * s.r);
    glow.position.set(s.c[0], s.c[1], s.minZ - 0.035 * s.r);
    glow.scale.setScalar(s.r * 3.2);
    scene.fog.near = dist * 0.9;
    scene.fog.far = dist + s.r * 6;
    if (!smooth || REDUCED) {
      controls.target.copy(target); camera.position.copy(goal); controls.update(); return;
    }
    const fromPos = camera.position.clone(), fromT = controls.target.clone();
    tween(900, (p) => {
      camera.position.lerpVectors(fromPos, goal, p);
      controls.target.lerpVectors(fromT, target, p);
    }, easeInOutCubic);
  }

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
  }
  new ResizeObserver(resize).observe(host);
  resize();
  camera.aspect = host.clientWidth / Math.max(1, host.clientHeight);
  fit(sphere, false);

  function caption(main, sub) { $("cap-main").textContent = main; $("cap-sub").textContent = sub || ""; }

  // ----- result
  function showResult(points, recon) {
    if (msgEl) { msgEl.remove(); msgEl = null; }
    const inp = toF32(points), rec = toF32(recon);
    const n = inp.length / 3, m = rec.length / 3;
    const pair = new Float32Array(n * 3), dist = new Float32Array(n);
    let dmin = Infinity, dmax = 0;
    for (let i = 0; i < n; i++) {          // pair each input point with its nearest rebuilt point
      let best = Infinity, bj = 0;
      for (let j = 0; j < m; j++) {
        const dx = inp[i * 3] - rec[j * 3], dy = inp[i * 3 + 1] - rec[j * 3 + 1], dz = inp[i * 3 + 2] - rec[j * 3 + 2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < best) { best = d; bj = j; }
      }
      pair.set(rec.subarray(bj * 3, bj * 3 + 3), i * 3);
      dist[i] = Math.sqrt(best);
      dmin = Math.min(dmin, dist[i]); dmax = Math.max(dmax, dist[i]);
    }
    const heatCol = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) heatCol.set(heat(dmax > dmin ? (dist[i] - dmin) / (dmax - dmin) : 0), i * 3);
    R = { inp, rec, pair, heatCol, dmin, dmax, n };
    compare = null;
    lastSide = false;
    C.opacity(0, 0);
    B.set(rec, fillColor(m, REC_COL));
    B.opacity(0, 0);
    $("lg-min").textContent = dmin.toFixed(3);
    $("lg-max").textContent = dmax.toFixed(3);
    stageEl.classList.add("has-result");
    glow.visible = true;
    document.querySelectorAll("[data-view]").forEach((b) => { if (b.dataset.view !== "compare") b.disabled = false; });
    updateCompareButton();
    fit(sphereOf(inp), true);
    setView("rebuild", { intro: true });
  }

  function clearResult() {
    if (msgEl) { msgEl.remove(); msgEl = null; }
    if (!R) { stageEl.classList.remove("has-result"); return; }
    R = null; compare = null; view = null; token++;
    stageEl.classList.remove("has-result", "side-by-side");
    document.querySelectorAll("[data-view]").forEach((b) => { b.disabled = true; b.classList.remove("is-on"); });
    $("compare-mode").hidden = true; $("legend").hidden = true; $("replay").hidden = true; $("cmp-labels").hidden = true;
    caption("", "");
    B.opacity(0, 300); C.opacity(0, 300);
    A.opacity(0, 300);
    glow.visible = false;
  }

  function message(text) {
    if (!msgEl) { msgEl = el("div", "stage-msg"); stageEl.append(msgEl); }
    msgEl.textContent = text;
    stageEl.classList.add("has-result"); // hides "Drop an IFC element to begin"
  }

  // ----- views
  function setView(next, opts = {}) {
    if (!R) return;
    if (next === "compare" && !compare) {
      const i = firstComparable();
      if (i < 0) return;
      selectCompare(i); // calls setView("compare") again with compare set
      return;
    }
    const my = ++token;
    view = next;
    document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("is-on", b.dataset.view === next));
    $("compare-mode").hidden = next !== "compare";
    $("legend").hidden = next !== "fails";
    $("replay").hidden = next !== "rebuild";
    $("cmp-labels").hidden = next !== "compare";
    const side = next === "compare" && cmode === "side";
    stageEl.classList.toggle("side-by-side", side);
    if (side !== lastSide) {   // half-width viewports need the camera further back (and back again after)
      lastSide = side;
      const s = sphereOf(R.inp);
      if (side && compare) s.r = Math.max(s.r, sphereOf(compare.pos).r);
      const w = host.clientWidth || 1, h = host.clientHeight || 1;
      fit(s, true, (side ? w / 2 : w) / h);
    }
    const white = fillColor(R.n, EL_COL);

    if (next === "element") {
      A.opacity(1, 400); B.opacity(0, 300); C.opacity(0, 300);
      A.flow(R.inp, white, 900);
      caption(`Your element · ${R.n} points`, "Points taken from the surface of your element: this is what the model sees.");
    } else if (next === "rebuild") {
      playRebuild(my, opts.intro, white);
    } else if (next === "overlay") {
      A.opacity(0.8, 400); B.opacity(0.95, 500); C.opacity(0, 300);
      A.flow(R.inp, white, 800);
      caption("Overlay", "Green: your element. Mustard: the model's reconstruction. The score measures the gap between them.");
    } else if (next === "fails") {
      A.opacity(1, 400); B.opacity(0, 300); C.opacity(0, 300);
      A.flow(R.inp, R.heatCol, 800);
      caption("Where it fails", "Each point of your element, coloured by its distance to the nearest rebuilt point. Red parts are what the model could not rebuild.");
    } else if (next === "compare") {
      A.opacity(1, 400); B.opacity(0, 300);
      A.flow(R.inp, white, 700);
      C.opacity(cmode === "ghost" ? 0.6 : 1, 500);
      $("cmp-labels").classList.toggle("ghost", cmode === "ghost");
      $("cmp-right").textContent = `${compare.label} · ${compare.sim.toFixed(3)}`;
      caption("Compare", cmode === "side"
        ? "Left: your element. Right: the gallery element. Both views turn together."
        : "Green: your element. Rust: the gallery element, drawn as a ghost on top.");
    }
  }

  async function playRebuild(my, intro, white) {
    B.opacity(0, 250); C.opacity(0, 250);
    caption("Rebuild · from 32 numbers", "The model squeezes the shape into 32 numbers and rebuilds it. Each point flows to its nearest rebuilt point.");
    if (intro) {
      A.set(scatterFrom(R.inp, sphereOf(R.inp)), white);
      A.opacity(1, 600);
      await A.flow(R.inp, white, 1300);
    } else {
      A.set(R.inp, white);
      A.opacity(1, 0);
    }
    await wait(450);
    if (my !== token) return;
    await A.flow(R.pair, fillColor(R.n, REC_COL), 1500);
    if (my !== token) return;
    B.opacity(1, 700); A.opacity(0, 700);
    caption("Rebuilt from 32 numbers", "Mustard: the model's reconstruction. Compare it with your element in Overlay, or see the gaps in Where it fails.");
  }

  function setCompare(points, label, sim) {
    const pos = toF32(points);
    compare = { pos, label: String(label || ""), sim };
    C.set(scatterFrom(pos, sphereOf(pos)), fillColor(pos.length / 3, CMP_COL));
    C.flow(pos, fillColor(pos.length / 3, CMP_COL), 1100);
  }

  // ----- controls
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  document.querySelectorAll("[data-cmode]").forEach((b) => b.addEventListener("click", () => {
    cmode = b.dataset.cmode;
    document.querySelectorAll("[data-cmode]").forEach((x) => x.classList.toggle("is-on", x === b));
    if (view === "compare") setView("compare");
  }));
  $("replay").addEventListener("click", () => setView("rebuild"));
  const rot = $("autorotate");
  const setRot = (on) => { autoRotateOn = on; rot.classList.toggle("is-on", on); rot.setAttribute("aria-pressed", String(on)); };
  setRot(!REDUCED);
  rot.addEventListener("click", () => setRot(!autoRotateOn));
  $("resetview").addEventListener("click", () => fit(R ? sphereOf(R.inp) : sphere, true));
  $("psize").addEventListener("input", (e) => { sizeMul = Number(e.target.value); });

  // ----- render
  function render(now) {
    for (const c of [A, B, C]) c.update(now);
    controls.autoRotate = autoRotateOn && !!R; // the empty stage stays still
    controls.update();
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    const pr = renderer.getPixelRatio();
    const camDist = camera.position.distanceTo(controls.target);
    const scale = (h * pr) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    for (const c of [A, B, C]) {
      const u = c.mat.uniforms;
      u.uScale.value = scale;
      u.uSize.value = 0.05 * sizeMul;
      u.uNear.value = camDist - sphere.r;
      u.uFar.value = camDist + sphere.r * 1.2;
    }
    const side = R && view === "compare" && cmode === "side" && compare;
    if (side) {
      const hw = Math.floor(w / 2);
      camera.aspect = hw / h;
      camera.updateProjectionMatrix();
      renderer.setScissorTest(true);
      for (const [x, layer] of [[0, 1], [hw, 2]]) {
        renderer.setViewport(x, 0, x ? w - hw : hw, h);
        renderer.setScissor(x, 0, x ? w - hw : hw, h);
        camera.layers.set(0); camera.layers.enable(layer);
        renderer.render(scene, camera);
      }
      renderer.setScissorTest(false);
    } else {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setViewport(0, 0, w, h);
      camera.layers.enableAll();
      renderer.render(scene, camera);
    }
  }

  return { render, showResult, clearResult, message, setView, setCompare, hasResult: () => !!R };
}

// ---------------------------------------------------------------- 3D: ONE shared renderer for all small cards
function createThumbs(THREE) {
  const W = 420, H = 560;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const mat = pointMaterial(THREE);
  const pts = new THREE.Points(new THREE.BufferGeometry(), mat);
  pts.frustumCulled = false;
  scene.add(pts);
  const cam = new THREE.PerspectiveCamera(32, 1, 0.01, 50);
  cam.up.set(0, 0, 1);
  const items = [];
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.target.__thumb) e.target.__thumb.visible = e.isIntersecting;
  });
  const mustard = new THREE.Vector3(...REC_COL);
  let frame = 0;

  function add(canvas, points, opts) {
    const pos = toF32(points);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aColor", new THREE.BufferAttribute(fillColor(pos.length / 3, EL_COL), 3));
    const it = {
      canvas, ctx: canvas.getContext("2d"), geo, s: sphereOf(pos), lift: opts.lift || 0,
      angle: Math.random() * Math.PI * 2, last: performance.now(), hover: false, visible: false, dirty: true,
    };
    canvas.__thumb = it;
    items.push(it);
    io.observe(canvas);
    return it;
  }
  function drop(it) {
    io.unobserve(it.canvas);
    it.geo.dispose();
    delete it.canvas.__thumb;
    items.splice(items.indexOf(it), 1);
  }
  function removeIn(container) {
    for (const it of items.slice()) if (container.contains(it.canvas) || !it.canvas.isConnected) drop(it);
  }

  function render(now) {
    frame++;
    for (const it of items.slice()) {
      if (!it.canvas.isConnected) { drop(it); continue; }
      if (!it.visible && !it.dirty) { it.last = now; continue; } // off-screen: draw once, then wait
      const active = it.hover || it.canvas.closest(".is-active");
      if (REDUCED ? !it.dirty : (frame % 2 && !it.hover && !it.dirty)) continue; // ~30 fps for idle cards
      const dt = Math.min(0.1, (now - it.last) / 1000);
      it.last = now;
      if (!REDUCED) it.angle += dt * (it.hover ? 1.4 : 0.45);
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const cw = Math.min(W, Math.round(it.canvas.clientWidth * dpr));
      const ch = Math.min(H, Math.round(it.canvas.clientHeight * dpr));
      if (!cw || !ch) continue;
      if (it.canvas.width !== cw || it.canvas.height !== ch) { it.canvas.width = cw; it.canvas.height = ch; }
      cam.aspect = cw / ch;
      cam.updateProjectionMatrix();
      const vfov = THREE.MathUtils.degToRad(cam.fov);
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * cam.aspect);
      const dist = (it.s.r / Math.sin(Math.min(vfov, hfov) / 2)) * 1.2;
      const [cx, cy, cz] = it.s.c;
      cam.position.set(cx + Math.cos(it.angle) * dist * 0.86, cy + Math.sin(it.angle) * dist * 0.86, cz + dist * 0.5);
      cam.lookAt(cx, cy, cz - it.lift * it.s.r * 2);
      pts.geometry = it.geo;
      const u = mat.uniforms;
      u.uScale.value = ch / (2 * Math.tan(vfov / 2));
      u.uSize.value = 0.07;
      u.uNear.value = dist - it.s.r;
      u.uFar.value = dist + it.s.r;
      u.uTint.value.copy(mustard);
      u.uTintMix.value = active ? 1 : 0;
      renderer.setViewport(0, 0, cw, ch);
      renderer.setScissor(0, 0, cw, ch);
      renderer.setScissorTest(true);
      renderer.clear();
      renderer.render(scene, cam);
      it.ctx.clearRect(0, 0, cw, ch);
      it.ctx.drawImage(renderer.domElement, 0, H - ch, cw, ch, 0, 0, cw, ch);
      it.dirty = false;
    }
  }
  return { add, removeIn, render };
}

// ---------------------------------------------------------------- 3D boot + one animation loop
async function boot3D() {
  let THREE, OrbitControls;
  try {
    THREE = await import("three");
    ({ OrbitControls } = await import("three/addons/controls/OrbitControls.js"));
  } catch (e) {
    console.error("three.js could not be loaded", e);
    const msg = el("div", "stage-msg", "3D view unavailable: three.js could not be loaded from the CDN. Upload and results still work.");
    $("stage").append(msg);
    return;
  }
  try {
    stage = createStage(THREE, OrbitControls);
    thumbs = createThumbs(THREE);
  } catch (e) {
    console.error("WebGL setup failed", e);
    $("stage").append(el("div", "stage-msg", "3D view unavailable: WebGL could not start in this browser."));
    return;
  }
  if (examples.length) attachShelfThumbs();
  if (lastResult) showResult(lastResult);

  let raf = 0;
  const loop = (now) => {
    raf = requestAnimationFrame(loop);
    stage.render(now);
    thumbs.render(now);
  };
  const start = () => { if (!raf) raf = requestAnimationFrame(loop); };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  if (!document.hidden) start();
}

// ---------------------------------------------------------------- start
loadHistory();
loadExamples();
boot3D();
