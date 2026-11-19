// IFC Check: "Whole-model check" section (top of the page).
// A small Revit house, split into elements and scored offline by 03_app/scripts/build_house.py
// (same model, same preprocessing as the live server). Files: /house/house.json, /house/house.glb, /house/elements/*.ifc.
// Self-contained: if house.json is missing or anything fails, the section stays hidden and the rest of the page is untouched.
// "Run live analysis" puts the element's own IFC file into the normal upload form, so the real server analyses it.

const BASE = "/house/";
const $ = (id) => document.getElementById(id);
const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const BORDER = 0.8; // ratio from which an element counts as "borderline"
const TOP_N = 8;     // "Highest scores" list length
// Score mode: 0x -> 1x the threshold, light sage -> mustard -> rust (relative to the threshold, not a verdict)
const SCORE_STOPS = [[0xD6, 0xE1, 0xD9], [0xE3, 0xC2, 0x7A], [0xCF, 0x76, 0x50]];
function scoreHex(ratio) {
  const t = Math.max(0, Math.min(1, ratio || 0));
  const [a, b, u] = t < 0.5 ? [SCORE_STOPS[0], SCORE_STOPS[1], t * 2] : [SCORE_STOPS[1], SCORE_STOPS[2], (t - 0.5) * 2];
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * u));
  return (c[0] << 16) | (c[1] << 8) | c[2];
}

const VERDICT_COL = { normal: 0xD6E1D9, border: 0xE3C27A, unusual: 0xCF7650, none: 0xC4CAC6 };
const TYPE_COL = {
  // "Realistic": material-like colours (plaster, oak, glass, porcelain, fabric...)
  Wall: 0xF1EEE8, Door: 0xA67B55, Window: 0xA9C8D4, Floor: 0xE6D8C4, Stair: 0xB9A58A,
  Railing: 0x5F6563, Furniture: 0x8FA597, Sanitary: 0xFAFAF8,
};

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}
const label = (e) => `${e.category} · ${String(e.name).split(":")[0]}`;
const state = (e) => (e.status !== "ok" ? "none" : e.unusual ? "unusual" : e.ratio >= BORDER ? "border" : "normal");

start().catch((e) => console.warn("Whole-model check unavailable:", e));

async function start() {
  const section = $("house");
  if (!section) return;
  let data;
  try {
    const r = await fetch(BASE + "house.json", { cache: "no-store" });
    if (!r.ok) return;
    data = await r.json();
  } catch { return; }
  if (!data || !Array.isArray(data.elements) || !data.elements.length) return;

  const THREE = await import("three");
  const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");
  const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
  section.hidden = false;
  fillPanel(data);

  // ---------- 3D scene
  const host = $("house-canvas");
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 500);
  camera.up.set(0, 0, 1); // IFC world coordinates: z is up
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = !REDUCED;
  controls.autoRotateSpeed = 0.5;
  controls.maxPolarAngle = Math.PI * 0.49;
  scene.add(new THREE.HemisphereLight(0xFFFFFF, 0xC9D2CA, 2.0));
  scene.add(new THREE.AmbientLight(0xFFFFFF, 0.6));
  const key = new THREE.DirectionalLight(0xFFFFFF, 1.4);
  key.position.set(0.6, 1.2, 0.8);
  camera.add(key);
  scene.add(camera);

  const gltf = await new GLTFLoader().loadAsync(BASE + "house.glb");
  const root = gltf.scene;
  scene.add(root);

  const byIdx = new Map(data.elements.map((e) => [e.idx, e]));
  const parts = []; // { e, mesh, mat, edges }
  root.traverse((o) => {
    if (!o.isMesh) return;
    const m = (o.name.match(/^e(\d+)/) || (o.parent && o.parent.name.match(/^e(\d+)/)));
    const e = m && byIdx.get(Number(m[1]));
    if (!e) return;
    const mat = new THREE.MeshStandardMaterial({
      color: VERDICT_COL[state(e)], roughness: 0.9, metalness: 0, side: THREE.DoubleSide, flatShading: true, // the GLB has no normals: without this every face renders black
      transparent: true, opacity: 1, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    if (e.category === "Window") { mat.roughness = 0.15; mat.metalness = 0.1; }
    o.material = mat;
    o.castShadow = true;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry, 30),
      new THREE.LineBasicMaterial({ color: 0x3E5A49, transparent: true, opacity: 0.35 }));
    o.add(edges);
    o.userData.part = parts.length;
    parts.push({ e, mesh: o, mat, edges });
  });
  if (!parts.length) throw new Error("house.glb has no element meshes");

  // floor grid + camera fit
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.62;
  const grid = new THREE.GridHelper(radius * 6, 36, 0xC9D2CA, 0xD9E0DA);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(centre.x, centre.y, box.min.z - 0.01);
  scene.add(grid);
  // soft shadow on the ground: a fixed "sun" and an invisible plane that only shows the shadow
  const sun = new THREE.DirectionalLight(0xFFFFFF, 0.5);
  sun.position.set(centre.x + radius * 0.8, centre.y - radius * 0.6, box.max.z + radius * 2.5);
  sun.target.position.copy(centre);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.radius = 6;
  sun.shadow.bias = -0.0005;
  Object.assign(sun.shadow.camera, { left: -radius * 1.6, right: radius * 1.6, top: radius * 1.6, bottom: -radius * 1.6, near: 0.1, far: radius * 8 });
  scene.add(sun, sun.target);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(radius * 8, radius * 8), new THREE.ShadowMaterial({ opacity: 0.16 }));
  ground.position.set(centre.x, centre.y, box.min.z - 0.005);
  ground.receiveShadow = true;
  scene.add(ground);
  const home = { pos: null, target: centre.clone() };

  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(host);
  resize();
  function fitTo(target, r, smooth) {
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * Math.max(0.3, camera.aspect));
    const dist = (r / Math.sin(Math.min(vfov, hfov) / 2)) * 1.05;
    const goal = target.clone().add(new THREE.Vector3(1, -1.15, 0.95).normalize().multiplyScalar(dist));
    if (!smooth || REDUCED) { camera.position.copy(goal); controls.target.copy(target); controls.update(); return; }
    const p0 = camera.position.clone(), t0 = controls.target.clone(), start = performance.now();
    (function step(now) {
      const t = Math.min(1, (now - start) / 800), k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      camera.position.lerpVectors(p0, goal, k);
      controls.target.lerpVectors(t0, target, k);
      if (t < 1) requestAnimationFrame(step);
    })(start);
  }
  fitTo(centre, radius, false);
  home.pos = camera.position.clone();

  // ---------- colours
  let mode = "type";
  let selected = -1;
  let hovered = -1;
  function paint() {
    parts.forEach((p, i) => {
      const base = mode === "score" ? (p.e.status === "ok" ? scoreHex(p.e.ratio) : VERDICT_COL.none)
        : mode === "verdict" ? VERDICT_COL[state(p.e)] : (TYPE_COL[p.e.category] || 0xCCCCCC);
      p.mat.color.setHex(base);
      const dim = selected >= 0 && i !== selected;
      const glass = mode === "type" && p.e.category === "Window";
      p.mat.opacity = dim ? 0.14 : glass ? 0.4 : 1;
      p.mat.depthWrite = !dim && !glass;
      p.mat.emissive.setHex(i === hovered && !dim ? 0x2B3A30 : 0x000000);
      p.edges.material.opacity = dim ? 0.06 : (i === selected ? 0.9 : 0.35);
      p.edges.material.color.setHex(i === selected ? 0x2F4A3A : 0x3E5A49);
    });
    $("house-legend-score").hidden = mode !== "score";
    $("house-legend-verdict").hidden = mode !== "verdict";
    $("house-legend-type").hidden = mode !== "type";
  }
  paint();
  document.querySelectorAll("[data-hmode]").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.hmode;
    document.querySelectorAll("[data-hmode]").forEach((x) => {
      x.classList.toggle("is-on", x === b); x.setAttribute("aria-pressed", String(x === b));
    });
    paint();
  }));

  // ---------- hover + click (raycast)
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tip = $("house-tip");
  const meshes = parts.map((p) => p.mesh);
  function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(meshes, false).find((h) => {
      const i = h.object.userData.part;
      return selected < 0 || i === selected || parts[i].mat.opacity > 0.5;
    });
    return hit ? hit.object.userData.part : -1;
  }
  renderer.domElement.addEventListener("pointermove", (ev) => {
    const i = pick(ev);
    if (i !== hovered) { hovered = i; paint(); }
    renderer.domElement.style.cursor = i >= 0 ? "pointer" : "grab";
    if (i < 0) { tip.hidden = true; return; }
    const e = parts[i].e, r = host.getBoundingClientRect();
    tip.textContent = e.status === "ok"
      ? `${label(e)} · ${e.ratio.toFixed(2)}× threshold · ${e.unusual ? "Unusual" : "Normal"}`
      : `${label(e)} · could not be read`;
    tip.style.left = `${ev.clientX - r.left + 14}px`;
    tip.style.top = `${ev.clientY - r.top + 14}px`;
    tip.hidden = false;
  });
  renderer.domElement.addEventListener("pointerleave", () => { hovered = -1; tip.hidden = true; paint(); });
  let down = null;
  renderer.domElement.addEventListener("pointerdown", (ev) => { down = [ev.clientX, ev.clientY]; controls.autoRotate = false; });
  renderer.domElement.addEventListener("pointerup", (ev) => {
    if (!down || Math.hypot(ev.clientX - down[0], ev.clientY - down[1]) > 5) return; // it was a drag
    const i = pick(ev);
    i >= 0 ? select(i) : clearSel();
  });

  function select(i) {
    selected = i;
    controls.autoRotate = false;
    paint();
    const b = new THREE.Box3().setFromObject(parts[i].mesh);
    const c = b.getCenter(new THREE.Vector3());
    const r = Math.max(b.getSize(new THREE.Vector3()).length() * 0.6, radius * 0.25);
    fitTo(c, r, true);
    showCard(parts[i].e);
    document.querySelectorAll(".hflag").forEach((x) => x.classList.toggle("is-active", Number(x.dataset.part) === i));
  }
  function clearSel() {
    if (selected < 0) return;
    selected = -1;
    paint();
    fitTo(centre, radius, true);
    $("house-card").hidden = true;
    document.querySelectorAll(".hflag").forEach((x) => x.classList.remove("is-active"));
  }
  $("house-reset").addEventListener("click", () => { clearSel(); controls.autoRotate = !REDUCED; });

  // "Highest scores" list -> select in 3D
  const flagged = parts.map((p, i) => ({ p, i }))
    .filter(({ p }) => p.e.status === "ok")
    .sort((a, b) => b.p.e.ratio - a.p.e.ratio)
    .slice(0, TOP_N);
  const list = $("house-flagged");
  list.replaceChildren();
  if (!flagged.length) list.append(el("li", "muted-box", "No scored elements."));
  flagged.forEach(({ p, i }) => {
    const li = el("li");
    const b = el("button", "hflag");
    b.type = "button";
    b.dataset.part = String(i);
    const dot = el("span", "hdot");
    dot.style.background = "#" + scoreHex(p.e.ratio).toString(16).padStart(6, "0");
    b.append(dot, el("span", "hname", label(p.e)), el("span", "hratio", `${p.e.ratio.toFixed(2)}×`));
    b.addEventListener("click", () => select(i));
    li.append(b);
    list.append(li);
  });

  // ---------- render loop (pauses when the tab is hidden)
  let raf = 0;
  const loop = () => { raf = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); };
  const go = () => { if (!raf) raf = requestAnimationFrame(loop); };
  const stop = () => { cancelAnimationFrame(raf); raf = 0; };
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : go()));
  if (!document.hidden) go();
}

// ---------- side panel
function fillPanel(data) {
  const s = data.summary || {};
  $("hs-total").textContent = String(s.scored ?? data.elements.length);
  $("hs-unusual").textContent = String(s.unusual ?? 0);
  $("hs-border").textContent = String(s.borderline ?? 0);
  if (s.note) $("house-note").textContent = s.note;
  // average ratio per element type, highest first
  const groups = {};
  data.elements.filter((e) => e.status === "ok").forEach((e) => (groups[e.category] ||= []).push(e.ratio));
  const rows = Object.entries(groups).map(([c, v]) => [c, v.reduce((a, b) => a + b, 0) / v.length, v.length])
    .sort((a, b) => b[1] - a[1]);
  const ul = $("house-types");
  ul.replaceChildren();
  rows.forEach(([c, avg, n]) => {
    const li = el("li");
    li.title = `${n} element${n > 1 ? "s" : ""}`;
    const bar = el("span", "tbar"), fill = el("i");
    fill.style.width = `${Math.min(100, avg * 100)}%`;
    fill.style.background = "#" + scoreHex(avg).toString(16).padStart(6, "0");
    bar.append(fill);
    li.append(el("span", "", c), bar, el("b", "", `${avg.toFixed(2)}×`));
    ul.append(li);
  });
}

function showCard(e) {
  const card = $("house-card");
  card.hidden = false;
  $("hc-name").textContent = label(e);
  const v = $("hc-verdict");
  if (e.status !== "ok") {
    v.textContent = "Not readable";
    v.className = "chip";
    $("hc-ratio").textContent = "—";
    $("hc-bar").style.width = "0%";
    $("hc-note").hidden = true;
    $("hc-similar").replaceChildren(el("li", "", e.message || "IfcOpenShell could not build this element."));
  } else {
    v.textContent = e.unusual ? "Unusual" : "Normal";
    v.className = "chip " + (e.unusual ? "anomaly" : "normal");
    $("hc-ratio").textContent = `${e.ratio.toFixed(2)}× threshold · score ${e.score.toFixed(4)}`;
    $("hc-bar").style.width = `${Math.min(100, (e.ratio / 2) * 100)}%`;
    $("hc-bar").dataset.state = state(e);
    $("hc-note").hidden = false;
    $("hc-note").textContent = e.unusual ? "Above the threshold: the model could not rebuild this shape well."
      : e.ratio < 0.3 ? "Simple shape: the model rebuilds it easily."
      : e.ratio < 0.6 ? "Medium complexity: some details get lost in the rebuild."
      : "Complex shape: the hardest kind to rebuild, so the score is higher.";
    const ul = $("hc-similar");
    ul.replaceChildren();
    (e.similar || []).slice(0, 3).forEach((s) => ul.append(el("li", "", `${s.ifc_class} · ${Number(s.similarity).toFixed(3)}`)));
  }
  const btn = $("hc-live");
  btn.disabled = e.status !== "ok";
  btn.onclick = () => runLive(e, btn);
}

// Put the element's own IFC file into the normal upload form: the live server analyses it like any upload
async function runLive(e, btn) {
  const before = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Loading the element…";
  try {
    const r = await fetch(BASE + e.file);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    const file = new File([blob], e.file.split("/").pop(), { type: "application/octet-stream" });
    const input = $("ifc");
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true })); // app.js picks the file up
    $("workspace").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
    $("upload").requestSubmit();                                   // app.js sends it to /api/predict
  } catch (err) {
    console.warn("Live analysis could not start:", err);
    btn.textContent = "Could not load the element";
    setTimeout(() => { btn.textContent = before; btn.disabled = false; }, 2500);
    return;
  }
  btn.textContent = before;
  btn.disabled = false;
}
