// Колесо! — AR-игра: колёса катятся по полу на игрока, их надо разломать пальцем.
// Режим 1 (Android Chrome): WebXR immersive-ar + hit-test — настоящий пол из камеры.
// Режим 2 (iPhone/всё остальное): видео с камеры + гироскоп, пол на заданной высоте под телефоном.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const $ = id => document.getElementById(id);
const V3 = THREE.Vector3;
const UP = new V3(0, 1, 0);

// ---------- рендер ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
$('stage').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.03, 80);
scene.add(new THREE.HemisphereLight(0xfff4e6, 0x4a3a2a, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
sun.position.set(1.5, 4, 2);
scene.add(sun);

addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- состояние ----------
const S = {
  mode: null,           // 'xr' | 'cam'
  phase: 'menu',        // menu | placing | play | over
  floorY: 0,
  floorFound: false,
  spawn: new V3(),
  lives: 3, score: 0, level: 1,
  wheels: [], debris: [],
  nextSpawn: 0, t: 0,
  camH: 1.4,
};
window.__koleso = S;

// ---------- звук ----------
let AC = null;
function audio() { if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } if (AC && AC.state === 'suspended') AC.resume(); return AC; }
function noise(dur, freq, q, gain) {
  const ac = audio(); if (!ac) return;
  const n = ac.sampleRate * dur, buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
  const src = ac.createBufferSource(); src.buffer = buf;
  const f = ac.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  const g = ac.createGain(); g.gain.value = gain;
  src.connect(f).connect(g).connect(ac.destination); src.start();
}
function tone(f0, f1, dur, type = 'sine', gain = 0.25) {
  const ac = audio(); if (!ac) return;
  const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
  o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(ac.destination); o.start(t); o.stop(t + dur);
}
const sfx = {
  crack() { noise(0.18, 1800 + Math.random() * 900, 1.2, 1.4); tone(220, 90, 0.12, 'square', 0.08); },
  smash() { noise(0.5, 700, 0.7, 2.2); tone(160, 40, 0.4, 'sawtooth', 0.15); },
  crush() { noise(0.6, 120, 0.5, 3); tone(90, 30, 0.6, 'sine', 0.6); },
  level() { tone(440, 880, 0.25, 'triangle', 0.2); setTimeout(() => tone(660, 1320, 0.3, 'triangle', 0.2), 120); },
};
const buzz = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };

// ---------- шаблон колеса: куски-обломки ----------
// Колесо всегда состоит из кусков (сектора обода + сектора ступицы/спиц),
// поэтому при ударе кусок просто отваливается и летит.
// Два типа колёс: деревянное тележное (большое, медленное) и автомобильное (меньше, быстрее, крепче)
const TYPES = [
  { id: 'derevo', file: 'koleso_derevo.glb', R: 0.45, speed: 0.85, hp: 0, chip: 0xb07a45, parts: null },
  { id: 'avto',   file: 'koleso_avto.glb',   R: 0.34, speed: 1.25, hp: 1, chip: 0x222224, parts: null },
];
let ready = false;

function buildTemplate(root, R) {
  root.updateMatrixWorld(true);
  const src = [];
  root.traverse(o => {
    if (!o.isMesh) return;
    let g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    src.push({ g, m: Array.isArray(o.material) ? o.material[0] : o.material });
  });
  const box = new THREE.Box3();
  src.forEach(s => { s.g.computeBoundingBox(); box.union(s.g.boundingBox); });
  const size = box.getSize(new V3()), c = box.getCenter(new V3());
  const dims = [size.x, size.y, size.z];
  const ax = dims.indexOf(Math.min(...dims));          // ось колеса — самый тонкий размер
  const diam = Math.max(...dims);
  const M = new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z);
  const rot = new THREE.Matrix4();
  if (ax === 1) rot.makeRotationZ(Math.PI / 2);
  if (ax === 2) rot.makeRotationY(Math.PI / 2);
  const sc = new THREE.Matrix4().makeScale(2 * R / diam, 2 * R / diam, 2 * R / diam);
  const T = sc.multiply(rot).multiply(M);

  const parts = [];
  // кольца: шина / диск / ступица. Если у модели нет текстуры — красим сами.
  const RINGS = [
    { from: 0.74, n: 10, mat: new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.92 }) },             // резина
    { from: 0.30, n: 8,  mat: new THREE.MeshStandardMaterial({ color: 0xc9ccd2, roughness: 0.28, metalness: 0.9 }) }, // диск
    { from: 0,    n: 2,  mat: new THREE.MeshStandardMaterial({ color: 0x8d9096, roughness: 0.35, metalness: 0.9 }) }, // ступица
  ];
  src.forEach(({ g, m }) => {
    const textured = !!(m && m.map);
    g.applyMatrix4(T);
    const pos = g.attributes.position, n = pos.count / 3;
    const names = Object.keys(g.attributes);
    const buckets = new Map();
    const a = new V3(), b = new V3(), cc = new V3();
    for (let t = 0; t < n; t++) {
      a.fromBufferAttribute(pos, t * 3); b.fromBufferAttribute(pos, t * 3 + 1); cc.fromBufferAttribute(pos, t * 3 + 2);
      const y = (a.y + b.y + cc.y) / 3, z = (a.z + b.z + cc.z) / 3;
      const r = Math.hypot(y, z) / R, ang = Math.atan2(y, z) + Math.PI;
      const ri = RINGS.findIndex(q => r >= q.from);
      const k = ri * 100 + Math.floor(ang / (2 * Math.PI) * RINGS[ri].n) % RINGS[ri].n;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(t);
    }
    for (const [k, tris] of buckets) {
      const ng = new THREE.BufferGeometry();
      for (const name of names) {
        const at = g.attributes[name], is = at.itemSize;
        const arr = new at.array.constructor(tris.length * 3 * is);
        let w = 0;
        for (const t of tris) for (let v = 0; v < 3; v++) for (let i = 0; i < is; i++) arr[w++] = at.array[(t * 3 + v) * is + i];
        ng.setAttribute(name, new THREE.BufferAttribute(arr, is, at.normalized));
      }
      ng.computeBoundingBox();
      const center = ng.boundingBox.getCenter(new V3());
      ng.translate(-center.x, -center.y, -center.z);
      ng.computeBoundingSphere();
      if (!ng.attributes.normal) ng.computeVertexNormals();
      parts.push({ geo: ng, mat: textured ? m : RINGS[Math.floor(k / 100)].mat, center });
    }
  });
  return parts;
}

function proceduralWheel() {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x9a6232, roughness: 0.85 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.5, metalness: 0.7 });
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.09, 10, 48), wood); g.add(rim);
  const tyre = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.04, 6, 64), iron); tyre.scale.z = 2.6; g.add(tyre);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.32, 20), wood); hub.rotation.x = Math.PI / 2; g.add(hub);
  for (let i = 0; i < 10; i++) {
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.055, 0.72, 8), wood);
    const a = i / 10 * Math.PI * 2;
    s.position.set(Math.cos(a) * 0.55, Math.sin(a) * 0.55, 0); s.rotation.z = a - Math.PI / 2; g.add(s);
  }
  return g;
}

async function loadWheel() {
  const loader = new GLTFLoader();
  let ok = 0;
  await Promise.all(TYPES.map(async t => {
    try { t.parts = buildTemplate((await loader.loadAsync(t.file)).scene, t.R); ok++; }
    catch (e) { console.warn(t.file + ' не загрузился, рисую своё колесо', e); t.parts = buildTemplate(proceduralWheel(), t.R); }
  }));
  ready = true;
  $('loadNote').textContent = ok === TYPES.length ? 'Колёса загружены ✓' : 'Часть колёс — запасные модели';
}

// тень-пятно под колесом
const shadowTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false });
const shadowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

function makeWheel(pos, dir, type) {
  const R = type.R;
  const outer = new THREE.Group(), tilt = new THREE.Group(), spin = new THREE.Group();
  outer.add(tilt); tilt.add(spin);
  tilt.position.y = R;
  const mats = new Map();
  for (const p of type.parts) {
    if (!mats.has(p.mat)) { const m = p.mat.clone(); if (m.emissive) m.emissive.setHex(0); mats.set(p.mat, m); }
    const mesh = new THREE.Mesh(p.geo, mats.get(p.mat));
    mesh.position.copy(p.center);
    spin.add(mesh);
  }
  const sh = new THREE.Mesh(shadowGeo, shadowMat);
  sh.scale.set(R, 1, R * 2.5); sh.position.y = 0.004; sh.renderOrder = -1;
  outer.add(sh);
  scene.add(outer);
  const w = {
    outer, tilt, spin, mats: [...mats.values()],
    pos: pos.clone(), dir: dir.clone().normalize(),
    type, R, nParts: type.parts.length, speed: (0.45 + S.level * 0.1) * type.speed, slow: 1, roll: 0, phase: Math.random() * 6,
    hp: 2 + Math.floor(S.level / 2) + type.hp, flash: 0, dead: false,
  };
  w.maxHp = w.hp;
  S.wheels.push(w);
  return w;
}

// ---------- обломки и щепки ----------
const chipGeo = new THREE.BoxGeometry(0.035, 0.02, 0.05);
const chipMats = {};
const chipMat = c => chipMats[c] || (chipMats[c] = new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }));

function throwPart(mesh, from, push) {
  mesh.updateMatrixWorld(true);
  const p = new V3(), q = new THREE.Quaternion(), s = new V3();
  mesh.matrixWorld.decompose(p, q, s);
  mesh.removeFromParent();
  scene.add(mesh);
  mesh.position.copy(p); mesh.quaternion.copy(q); mesh.scale.copy(s);
  const out = p.clone().sub(from); out.y = Math.max(out.y, 0); out.normalize();
  const v = out.multiplyScalar(1.2 + Math.random() * 1.6).add(push.clone().multiplyScalar(1.5));
  v.y += 1.5 + Math.random() * 1.8;
  S.debris.push({ m: mesh, v, w: new V3(Math.random() - .5, Math.random() - .5, Math.random() - .5).multiplyScalar(14), life: 2.6 + Math.random(), s0: s.x });
}
function chips(at, n, color = 0x777777) {
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(chipGeo, chipMat(color)); m.position.copy(at); scene.add(m);
    const v = new V3(Math.random() - .5, Math.random() * 0.8 + 0.3, Math.random() - .5).multiplyScalar(4);
    S.debris.push({ m, v, w: new V3(Math.random(), Math.random(), Math.random()).multiplyScalar(20), life: 0.9 + Math.random() * 0.6, s0: 1 });
  }
}

function hitWheel(w, mesh, point, rayDir) {
  if (w.dead) return;
  w.hp--; w.flash = 0.12; w.slow = 0.15;
  sfx.crack(); buzz(25);
  chips(point, 6, w.type.chip);
  const center = w.spin.getWorldPosition(new V3());
  const push = rayDir.clone().setY(0).normalize();
  if (w.hp <= 0 || w.spin.children.length <= 3) { breakWheel(w, push); return; }
  // выбиваем кусок, в который попали, и ещё соседний
  throwPart(mesh, center, push);
  const rest = w.spin.children;
  if (rest.length > 4) {
    let best = null, bd = 1e9;
    for (const m of rest) { const d = m.getWorldPosition(new V3()).distanceTo(point); if (d < bd) { bd = d; best = m; } }
    if (best) throwPart(best, center, push);
  }
}
function breakWheel(w, push = new V3()) {
  w.dead = true;
  const center = w.spin.getWorldPosition(new V3());
  for (const m of [...w.spin.children]) throwPart(m, center, push);
  chips(center, 18, w.type.chip);
  removeWheel(w);
  sfx.smash(); buzz([40, 30, 60]);
  S.score++;
  $('score').textContent = S.score;
  if (S.score % 5 === 0) { S.level++; $('lvl').textContent = 'Уровень ' + S.level; sfx.level(); pop('Уровень ' + S.level + '!'); }
  else pop(['Хрясь!', 'Бах!', 'В щепки!', 'Есть!', 'Готово!'][Math.floor(Math.random() * 5)]);
}
function removeWheel(w) {
  scene.remove(w.outer);
  S.wheels = S.wheels.filter(x => x !== w);
}

let popT = null;
function pop(text) {
  const el = $('pop'); el.textContent = text; el.style.opacity = 1; el.style.transform = 'translate(-50%,-60%)';
  clearTimeout(popT); popT = setTimeout(() => { el.style.opacity = 0; el.style.transform = 'translate(-50%,-50%)'; }, 650);
}

// ---------- игровой цикл ----------
const raycaster = new THREE.Raycaster();
function shoot(origin, dir) {
  if (S.phase !== 'play') return false;
  raycaster.set(origin, dir); raycaster.far = 30;
  const targets = S.wheels.filter(w => !w.dead).map(w => w.spin);
  const hits = raycaster.intersectObjects(targets, true);
  if (!hits.length) {
    // поблажка для пальца: если промахнулись совсем чуть-чуть — засчитываем
    let best = null, bd = 0.22;
    for (const w of S.wheels) {
      if (w.dead) continue;
      const c = w.spin.getWorldPosition(new V3());
      const d = raycaster.ray.distanceToPoint(c) - w.R;
      if (d < bd && w.spin.children.length) { bd = d; best = w; }
    }
    if (!best) return false;
    const c = best.spin.getWorldPosition(new V3());
    let near = null, nd = 1e9;
    for (const m of best.spin.children) { const d = raycaster.ray.distanceToPoint(m.getWorldPosition(new V3())); if (d < nd) { nd = d; near = m; } }
    hitWheel(best, near, raycaster.ray.closestPointToPoint(c, new V3()), dir);
    return true;
  }
  const h = hits[0];
  const w = S.wheels.find(w => h.object.parent === w.spin);
  if (w) hitWheel(w, h.object, h.point, dir);
  return !!w;
}

function viewCam() { return renderer.xr.isPresenting ? renderer.xr.getCamera() : camera; }
function playerFloorPos() {
  const p = viewCam().getWorldPosition(new V3()); p.y = S.floorY; return p;
}

function spawnWheel() {
  const player = playerFloorPos();
  const base = S.spawn.clone(); base.y = S.floorY;
  const side = new V3().subVectors(player, base).setY(0);
  const dist = side.length();
  side.normalize();
  const lat = new V3(-side.z, 0, side.x).multiplyScalar((Math.random() - 0.5) * Math.min(1.6, dist * 0.5));
  const p = base.add(lat);
  // заходит по дуге: стартовое направление отклонено на 35–60°, потом доворачивает на игрока
  const d = new V3().subVectors(player, p).setY(0).normalize();
  d.applyAxisAngle(UP, (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.45));
  // в начале чаще деревянные, дальше — поровну
  const type = Math.random() < Math.max(0.5, 0.85 - S.level * 0.1) ? TYPES[0] : TYPES[1];
  makeWheel(p, d, type);
}

function crushed(w) {
  S.lives--;
  sfx.crush(); buzz([120, 50, 200]);
  const f = $('flash'); f.style.transition = 'none'; f.style.opacity = 0.6;
  requestAnimationFrame(() => { f.style.transition = 'opacity .6s'; f.style.opacity = 0; });
  w.dead = true;
  const center = w.spin.getWorldPosition(new V3());
  for (const m of [...w.spin.children]) throwPart(m, center, w.dir);
  removeWheel(w);
  updateLives();
  if (S.lives <= 0) gameOver();
}
function updateLives() { $('lives').textContent = '❤️'.repeat(Math.max(0, S.lives)) + '🖤'.repeat(Math.max(0, 3 - S.lives)); }

const tmpQ = new THREE.Quaternion();
function step(dt) {
  S.t += dt;
  if (S.phase === 'play') {
    const player = playerFloorPos();
    // появление
    if (S.t >= S.nextSpawn && S.wheels.length < Math.min(1 + Math.floor(S.level / 2), 4)) {
      spawnWheel();
      S.nextSpawn = S.t + Math.max(1.3, 3.6 - S.level * 0.3);
    }
    for (const w of [...S.wheels]) {
      // колесо слегка доворачивает на игрока — можно увернуться шагом в сторону
      const want = new V3().subVectors(player, w.pos).setY(0);
      const dist = want.length();
      want.normalize();
      const turn = (0.35 + S.level * 0.05) * dt;
      const cross = w.dir.x * want.z - w.dir.z * want.x;
      const ang = Math.atan2(cross, w.dir.dot(want));
      const da = Math.max(-turn, Math.min(turn, ang));
      w.dir.applyAxisAngle(UP, -da).normalize();
      w.slow = Math.min(1, w.slow + dt * 1.2);
      const v = w.speed * w.slow;
      // вихляет из стороны в сторону, показывая бок
      const weave = Math.sin(S.t * 1.6 + w.phase) * 0.45;
      const mv = w.dir.clone().applyAxisAngle(UP, weave);
      w.pos.addScaledVector(mv, v * dt);
      w.pos.y = S.floorY;
      w.roll += v * dt / w.R;
      w.outer.position.copy(w.pos);
      w.outer.rotation.y = Math.atan2(mv.x, mv.z);
      const lost = 1 - w.spin.children.length / w.nParts;   // чем больше выбито — тем сильнее шатает
      w.tilt.rotation.z = Math.sin(S.t * 3 + w.phase) * (0.04 + lost * 0.25) + (w.flash > 0 ? 0.08 : 0);
      w.spin.rotation.x = w.roll;
      if (w.flash > 0) { w.flash -= dt; for (const m of w.mats) m.emissive && m.emissive.setHex(w.flash > 0 ? 0x661100 : 0); }
      if (dist < w.R * 0.7 + 0.25) crushed(w);
      else if (dist > 25) removeWheel(w);
    }
  }
  // обломки
  for (const d of [...S.debris]) {
    d.life -= dt;
    d.v.y -= 9.8 * dt;
    d.m.position.addScaledVector(d.v, dt);
    tmpQ.setFromEuler(new THREE.Euler(d.w.x * dt, d.w.y * dt, d.w.z * dt));
    d.m.quaternion.multiply(tmpQ);
    const floor = S.floorY + 0.03;
    if (d.m.position.y < floor) { d.m.position.y = floor; d.v.y *= -0.3; d.v.x *= 0.6; d.v.z *= 0.6; d.w.multiplyScalar(0.6); }
    if (d.life < 0.5) d.m.scale.setScalar(Math.max(0.001, d.s0 * d.life / 0.5));
    if (d.life <= 0) { scene.remove(d.m); S.debris.splice(S.debris.indexOf(d), 1); }
  }
}

// ---------- метка пола и «ворота» ----------
const reticle = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.16, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0.9 }));
reticle.matrixAutoUpdate = false; reticle.visible = false; scene.add(reticle);
const gate = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.5, 48).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xff7a2e, transparent: true, opacity: 0.5, depthWrite: false }));
gate.visible = false; scene.add(gate);

// ---------- режим WebXR (настоящий пол) ----------
let xrSession = null, hitSource = null, xrRef = null;
const floorSamples = [];
async function startXR() {
  audio();
  xrSession = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay', 'local-floor'], domOverlay: { root: $('ui') },
  });
  renderer.xr.setReferenceSpaceType('local');
  await renderer.xr.setSession(xrSession);
  xrRef = renderer.xr.getReferenceSpace();
  const viewer = await xrSession.requestReferenceSpace('viewer');
  hitSource = await xrSession.requestHitTestSource({ space: viewer });
  S.mode = 'xr'; S.floorFound = false; floorSamples.length = 0;
  xrSession.addEventListener('select', onXRSelect);
  xrSession.addEventListener('end', () => { hitSource = null; xrSession = null; reticle.visible = false; toMenu(); });
  enterPlacing();
}
function onXRSelect(e) {
  const pose = e.frame.getPose(e.inputSource.targetRaySpace, xrRef);
  if (!pose) return;
  const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
  const o = new V3().setFromMatrixPosition(m);
  const d = new V3(0, 0, -1).transformDirection(m);
  if (S.phase === 'placing' && reticle.visible) placeGate(new V3().setFromMatrixPosition(reticle.matrix));
  else shoot(o, d);
}
function xrFrame(frame) {
  if (!hitSource || !frame) return;
  const res = frame.getHitTestResults(hitSource);
  const camY = viewCam().getWorldPosition(new V3()).y;
  let ok = false;
  if (res.length) {
    const pose = res[0].getPose(xrRef);
    if (pose) {
      const m = new THREE.Matrix4().fromArray(pose.transform.matrix);
      const n = new V3(0, 1, 0).transformDirection(m);
      const p = new V3().setFromMatrixPosition(m);
      // горизонтальная плоскость минимум в 70 см под телефоном — это пол, а не стол
      if (n.y > 0.85 && camY - p.y > 0.7) {
        ok = true;
        floorSamples.push(p.y); if (floorSamples.length > 30) floorSamples.shift();
        const sorted = [...floorSamples].sort((a, b) => a - b);
        S.floorY = sorted[Math.floor(sorted.length / 2)];
        S.floorFound = true;
        reticle.matrix.copy(m);
      }
    }
  }
  reticle.visible = ok && S.phase === 'placing';
  if (S.phase === 'placing') hint(ok ? 'Пол найден! Тапни туда, откуда покатятся колёса (подальше от себя)' : 'Медленно поводи телефоном, направив камеру на пол…');
}

// ---------- режим «камера + гироскоп» (iPhone и др.) ----------
const devQ = new THREE.Quaternion();
let orientOK = false, orient = null, yaw = 0, pitch = -0.35;
function onOrient(e) { if (e.alpha == null && e.beta == null) return; orient = e; orientOK = true; }
function applyOrientation() {
  const deg = THREE.MathUtils.DEG2RAD;
  if (orientOK && orient) {
    const so = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    const euler = new THREE.Euler(orient.beta * deg, orient.alpha * deg, -orient.gamma * deg, 'YXZ');
    devQ.setFromEuler(euler);
    devQ.multiply(new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2));
    devQ.multiply(new THREE.Quaternion().setFromAxisAngle(new V3(0, 0, 1), -so * deg));
    camera.quaternion.copy(devQ);
  } else {
    camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  }
  camera.position.set(0, S.camH, 0);
}
let drag = null;
renderer.domElement.addEventListener('pointerdown', e => {
  if (S.mode !== 'cam') return;
  audio();
  drag = { x: e.clientX, y: e.clientY, moved: false };
});
renderer.domElement.addEventListener('pointermove', e => {
  if (!drag || orientOK) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
  if (drag.moved) { yaw -= dx * 0.004; pitch = Math.max(-1.4, Math.min(0.5, pitch - dy * 0.004)); drag.x = e.clientX; drag.y = e.clientY; }
});
renderer.domElement.addEventListener('pointerup', e => {
  if (!drag) return;
  const wasDrag = drag.moved; drag = null;
  if (wasDrag || S.mode !== 'cam') return;
  const ndc = new THREE.Vector2(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  shoot(raycaster.ray.origin.clone(), raycaster.ray.direction.clone());
});

let grid = null;
async function startCam() {
  audio();
  // гироскоп: на iPhone нужно разрешение, спрашивать строго по нажатию
  try {
    if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r === 'granted') addEventListener('deviceorientation', onOrient);
    } else addEventListener('deviceorientation', onOrient);
  } catch (e) { console.warn(e); }
  let hasVideo = false;
  try {
    const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    const v = $('video'); v.srcObject = st; v.style.display = 'block'; await v.play(); hasVideo = true;
  } catch (e) { console.warn('камера недоступна', e); }
  if (!hasVideo) {
    scene.background = new THREE.Color(0x2b1e14);
    if (!grid) { grid = new THREE.GridHelper(30, 60, 0x8a6a4a, 0x4a3828); scene.add(grid); }
    grid.visible = true;
  } else { scene.background = null; if (grid) grid.visible = false; }
  S.mode = 'cam'; S.floorY = 0; S.floorFound = true;
  $('height').style.display = 'block';
  $('exit').style.display = 'block';
  applyOrientation();
  // ворота — в 4 м перед собой по направлению взгляда
  const f = new V3(0, 0, -1).applyQuaternion(camera.quaternion).setY(0);
  if (f.lengthSq() < 1e-4) f.set(0, 0, -1);
  f.normalize().multiplyScalar(4);
  placeGate(new V3(f.x, 0, f.z));
}

// ---------- фазы ----------
let hintT = '';
function hint(t) { const el = $('hint'); if (t === hintT) return; hintT = t; el.textContent = t; el.style.display = t ? 'block' : 'none'; }
function enterPlacing() {
  $('start').style.display = 'none'; $('over').style.display = 'none';
  $('exit').style.display = 'block';
  S.phase = 'placing';
  hint('Медленно поводи телефоном, направив камеру на пол…');
}
function placeGate(p) {
  const player = playerFloorPos();
  if (S.mode === 'xr' && p.distanceTo(player) < 1.2) { hint('Слишком близко! Выбери место подальше (от 1,5 м)'); return; }
  S.spawn.copy(p); S.spawn.y = S.floorY;
  gate.position.copy(S.spawn); gate.position.y += 0.003; gate.visible = true;
  reticle.visible = false;
  newGame();
}
function newGame() {
  for (const w of [...S.wheels]) removeWheel(w);
  S.lives = 3; S.score = 0; S.level = 1; S.nextSpawn = S.t + 1.2;
  $('score').textContent = '0'; $('lvl').textContent = 'Уровень 1'; updateLives();
  $('hud').style.display = 'flex'; $('over').style.display = 'none'; $('start').style.display = 'none';
  S.phase = 'play';
  hint('Тыкай в колёса!'); setTimeout(() => { if (S.phase === 'play') hint(''); }, 2500);
}
function gameOver() {
  S.phase = 'over'; hint('');
  $('overText').textContent = `Разломано колёс: ${S.score}. Дошёл до уровня ${S.level}.`;
  $('over').style.display = 'flex';
}
function toMenu() {
  for (const w of [...S.wheels]) removeWheel(w);
  S.phase = 'menu'; gate.visible = false; hint('');
  $('hud').style.display = 'none'; $('over').style.display = 'none'; $('start').style.display = 'flex';
  $('exit').style.display = 'none'; $('height').style.display = 'none';
  const v = $('video'); if (v.srcObject) { v.srcObject.getTracks().forEach(t => t.stop()); v.srcObject = null; } v.style.display = 'none';
  removeEventListener('deviceorientation', onOrient); orientOK = false;
  scene.background = null; if (grid) grid.visible = false;
  S.mode = null;
}

// кнопки поверх AR не должны «стрелять»
for (const id of ['exit', 'height', 'again', 'toMenu', 'over']) $(id).addEventListener('beforexrselect', e => e.preventDefault());
$('btnCam').onclick = () => { if (ready) startCam(); };
$('btnXR').onclick = () => { if (ready) startXR().catch(e => { alert('AR не запустился: ' + e.message); }); };
$('again').onclick = () => { if (S.mode === 'cam') newGame(); else newGame(); };
$('toMenu').onclick = () => { if (xrSession) xrSession.end(); else toMenu(); };
$('exit').onclick = () => { if (xrSession) xrSession.end(); else toMenu(); };
$('height').onclick = () => {
  const hs = [1.0, 1.2, 1.4, 1.6, 1.8]; S.camH = hs[(hs.indexOf(S.camH) + 1) % hs.length];
  $('height').textContent = '📱 ' + S.camH.toFixed(1) + ' м';
};

(async () => {
  let xrOK = false;
  try { xrOK = !!(navigator.xr && await navigator.xr.isSessionSupported('immersive-ar')); } catch (e) {}
  $('btnXR').hidden = !xrOK;
  $('btnCam').classList.toggle('alt', xrOK);
  $('modeNote').textContent = xrOK
    ? 'AR поддерживается: телефон сам найдёт пол. «С камерой» — упрощённый режим.'
    : 'Полноценный AR (поиск пола) работает в Chrome на Android. Здесь — режим «камера + гироскоп»: пол считается на высоте телефона (кнопка 📱).';
})();
await loadWheel();

// ---------- цикл ----------
let last = performance.now();
renderer.setAnimationLoop((time, frame) => {
  const now = performance.now(); const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (S.mode === 'xr') xrFrame(frame);
  if (S.mode === 'cam') applyOrientation();
  gate.material.opacity = 0.35 + Math.sin(S.t * 4) * 0.15;
  step(dt);
  renderer.render(scene, camera);
});

// для автотестов
window.__kolesoAPI = { startCam, shoot, makeWheel, newGame, step, camera, scene, get wheels() { return S.wheels; }, TYPES };
