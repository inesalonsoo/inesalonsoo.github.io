// A seeded 2-D free-energy landscape with an ensemble of particles diffusing
// between metastable basins under overdamped Langevin dynamics:
//   dx = -∇F(x) dt + sqrt(2 kT dt) ξ
// Each basin is a "state" that links somewhere. "Measure" collapses the
// ensemble into one basin, chosen with probability equal to its occupancy.

const stage = document.querySelector('#stage');
const canvas = document.querySelector('#field');
const basinsEl = document.querySelector('#basins');
const seedCode = document.querySelector('#seed-code');
const statEl = document.querySelector('#stat');
const randomizeBtn = document.querySelector('#randomize');
const measureBtn = document.querySelector('#measure');
const pauseBtn = document.querySelector('#pause');
const themeBtn = document.querySelector('#theme');
const shareLink = document.querySelector('#share-seed');
const ctx = canvas.getContext('2d', { alpha: false });
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const isSmall = () => matchMedia('(max-width: 700px)').matches;

// Basins are the "states" of this system, and where they lead.
const DESTINATIONS = [
  { label: '|research⟩', href: '#research' },
  { label: '|github⟩', href: 'https://github.com/inesalonsoo' },
  { label: '|linkedin⟩', href: 'https://www.linkedin.com/in/inesalonsocl/' },
  { label: '|résumé⟩', href: 'assets/IAlonso_Resume_2026.pdf' },
];

// ---------- seeded randomness ----------
const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
const hexSeed = s => '0x' + (s >>> 0).toString(16).padStart(8, '0');
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Box–Muller, one gaussian at a time.
let spare = null;
function randn() {
  if (spare !== null) { const s = spare; spare = null; return s; }
  let u, v, r;
  do { u = Math.random() * 2 - 1; v = Math.random() * 2 - 1; r = u * u + v * v; } while (r === 0 || r >= 1);
  const m = Math.sqrt(-2 * Math.log(r) / r);
  spare = v * m;
  return u * m;
}

// ---------- state ----------
const seedParam = new URL(location.href).searchParams.get('seed');
const initialSeed = seedParam && /^[0-9a-fA-F]{8}$/.test(seedParam) ? parseInt(seedParam, 16) : randomSeed();

const state = {
  seed: initialSeed,
  wells: [],          // {x, y, depth, sx, sy}
  particles: null,    // Float32Array [x0,y0,x1,y1,...]
  basin: null,        // Int8Array current basin per particle
  trails: null,       // Float32Array ring buffer of past positions
  trailHead: 0,
  n: 0,
  kT: 0.075,
  baseKT: 0.075,
  confine: 0.6,
  aspect: 1,
  paused: motion.matches,
  collapsed: -1,      // index of basin the ensemble collapsed into, or -1
  collapseT: 0,
  pointer: { x: 0, y: 0, active: false, pressed: false },
  hops: [],           // timestamps of recent basin transitions
};
const TRAIL = 6;
const DT = 0.0006;
const SUBSTEPS = 3;

// ---------- landscape ----------
function buildWells(seed) {
  const rnd = mulberry32(seed);
  const a = state.aspect;
  const wells = [];
  if (isSmall() || a < 0.9) {
    // Portrait: a seeded zigzag down the upper two thirds, clear of the caption.
    const slots = [-0.66, -0.42, -0.18, 0.06];
    const order = slots.map((y, i) => i).sort(() => rnd() - 0.5);
    const base = rnd() < 0.5 ? 1 : -1;
    for (const i of order) {
      const y = slots[i] + (rnd() - 0.5) * 0.08;
      const side = i % 2 ? -base : base; // neighbouring slots on opposite sides
      const x = side * (0.42 + rnd() * 0.2) * a;
      wells.push({ x, y, depth: 0.34 + rnd() * 0.22, sx: (0.13 + rnd() * 0.06) * Math.max(1, a * 1.6), sy: 0.14 + rnd() * 0.06 });
    }
    // keep destination order stable across seeds by sorting on the seeded slot order
    return order.map((_, k) => wells[k]);
  }
  const xr = 0.72, yTop = -0.5, yBot = 0.42;
  let guard = 0;
  while (wells.length < DESTINATIONS.length && guard++ < 4000) {
    const x = (rnd() * 2 - 1) * xr * a;
    const y = yTop + rnd() * (yBot - yTop);
    // keep the bottom-left corner free for the caption
    if (x < -0.05 * a && y > 0.12) continue;
    if (wells.some(w => Math.hypot(w.x - x, w.y - y) < 0.66)) continue;
    wells.push({ x, y, depth: 0.34 + rnd() * 0.22, sx: 0.2 + rnd() * 0.12, sy: 0.2 + rnd() * 0.12 });
  }
  // fall back to a fixed layout if rejection sampling starved
  while (wells.length < DESTINATIONS.length) {
    const i = wells.length;
    wells.push({ x: (i % 2 ? 0.45 : -0.45) * a, y: i < 2 ? -0.35 : 0.3, depth: 0.45, sx: 0.24, sy: 0.24 });
  }
  return wells;
}

function potential(x, y) {
  let F = 0.5 * state.confine * ((x / state.aspect) ** 2 + y * y);
  for (const w of state.wells) {
    const dx = (x - w.x) / w.sx, dy = (y - w.y) / w.sy;
    F -= w.depth * Math.exp(-0.5 * (dx * dx + dy * dy));
  }
  return F;
}

function gradient(x, y, out) {
  let gx = state.confine * x / (state.aspect * state.aspect);
  let gy = state.confine * y;
  for (const w of state.wells) {
    const dx = (x - w.x) / w.sx, dy = (y - w.y) / w.sy;
    const e = w.depth * Math.exp(-0.5 * (dx * dx + dy * dy));
    gx += e * dx / w.sx;
    gy += e * dy / w.sy;
  }
  out[0] = gx; out[1] = gy;
}

function nearestBasin(x, y) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < state.wells.length; i++) {
    const w = state.wells[i];
    const d = ((x - w.x) / w.sx) ** 2 + ((y - w.y) / w.sy) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
// Core-set assignment: a particle only changes state once it is well inside
// another well's core, so saddle-point flicker doesn't count as a transition.
const CORE = 1.3 * 1.3;
function coreBasin(x, y) {
  for (let i = 0; i < state.wells.length; i++) {
    const w = state.wells[i];
    if (((x - w.x) / w.sx) ** 2 + ((y - w.y) / w.sy) ** 2 < CORE) return i;
  }
  return -1;
}

// ---------- rendering the landscape (once per seed / theme / resize) ----------
let width = 1, height = 1, dpr = 1;
let bg = null; // offscreen canvas holding the drawn potential

function cssColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function hexToRgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const isLight = () => document.documentElement.dataset.theme === 'light';
const palette = { accent: '#b7a6ff', ink: '#ececf1' };
function refreshPalette() { palette.accent = cssColor('--accent'); palette.ink = cssColor('--ink'); }

function renderLandscape() {
  refreshPalette();
  const cell = 2; // CSS px per sample
  const gw = Math.max(1, Math.ceil(width / cell)), gh = Math.max(1, Math.ceil(height / cell));
  const F = new Float32Array(gw * gh);
  let fmin = Infinity, fmax = -Infinity;
  for (let j = 0; j < gh; j++) {
    const y = ((j + 0.5) / gh) * 2 - 1;
    for (let i = 0; i < gw; i++) {
      const x = (((i + 0.5) / gw) * 2 - 1) * state.aspect;
      const f = potential(x, y);
      F[j * gw + i] = f;
      if (f < fmin) fmin = f; if (f > fmax) fmax = f;
    }
  }
  const range = fmax - fmin || 1;
  const bgc = hexToRgb(cssColor('--bg')), soft = hexToRgb(cssColor('--soft')),
        line = hexToRgb(cssColor('--line')), acc = hexToRgb(cssColor('--accent'));
  const light = isLight();
  const off = document.createElement('canvas');
  off.width = gw; off.height = gh;
  const octx = off.getContext('2d');
  const img = octx.createImageData(gw, gh);
  const px = img.data;
  const levels = 14;
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const k = j * gw + i;
      const depth = 1 - (F[k] - fmin) / range; // 1 at the deepest point
      const lvl = Math.floor(depth * levels);
      const right = i + 1 < gw ? Math.floor((1 - (F[k + 1] - fmin) / range) * levels) : lvl;
      const down = j + 1 < gh ? Math.floor((1 - (F[k + gw] - fmin) / range) * levels) : lvl;
      const onLine = lvl !== right || lvl !== down;
      // fill: bg → soft with depth, plus a whisper of accent in the wells
      const t = Math.pow(depth, 1.6);
      let r = bgc[0] + (soft[0] - bgc[0]) * t, g = bgc[1] + (soft[1] - bgc[1]) * t, b = bgc[2] + (soft[2] - bgc[2]) * t;
      const ta = (light ? 0.10 : 0.16) * Math.pow(depth, 3);
      r += (acc[0] - r) * ta; g += (acc[1] - g) * ta; b += (acc[2] - b) * ta;
      if (onLine) {
        const major = lvl % 4 === 0;
        const la = major ? 0.9 : 0.45;
        r += (line[0] - r) * la; g += (line[1] - g) * la; b += (line[2] - b) * la;
      }
      const o = k * 4;
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  bg = off;
}

// ---------- particles ----------
function spawnParticles() {
  state.n = isSmall() ? 150 : 280;
  state.particles = new Float32Array(state.n * 2);
  state.basin = new Int8Array(state.n);
  state.trails = new Float32Array(state.n * TRAIL * 2);
  for (let i = 0; i < state.n; i++) {
    // start inside a random well so the ensemble is already near equilibrium
    const w = state.wells[Math.floor(Math.random() * state.wells.length)];
    const x = w.x + randn() * w.sx * 0.6, y = w.y + randn() * w.sy * 0.6;
    state.particles[2 * i] = x; state.particles[2 * i + 1] = y;
    state.basin[i] = nearestBasin(x, y);
    for (let t = 0; t < TRAIL; t++) { state.trails[(i * TRAIL + t) * 2] = x; state.trails[(i * TRAIL + t) * 2 + 1] = y; }
  }
  state.trailHead = 0;
  state.hops.length = 0;
  for (let s = 0; s < 120; s++) step(false);
}

const g = new Float32Array(2);
function step(record = true) {
  const P = state.particles, a = state.aspect;
  const kT = state.kT;
  const noise = Math.sqrt(2 * kT * DT);
  const ptr = state.pointer;
  const pr = ptr.pressed ? 0.34 : 0.2, ps = ptr.pressed ? 2.2 : 0.9;
  const col = state.collapsed >= 0 ? state.wells[state.collapsed] : null;
  const pull = col ? Math.min(1, state.collapseT) * 7 : 0;
  const now = performance.now();
  for (let i = 0; i < state.n; i++) {
    let x = P[2 * i], y = P[2 * i + 1];
    gradient(x, y, g);
    let fx = -g[0], fy = -g[1];
    if (ptr.active) {
      const dx = x - ptr.x, dy = y - ptr.y, d2 = dx * dx + dy * dy;
      const e = ps * Math.exp(-d2 / (2 * pr * pr));
      fx += e * dx / pr; fy += e * dy / pr;
    }
    if (col) { fx += (col.x - x) * pull; fy += (col.y - y) * pull; }
    x += fx * DT + noise * randn();
    y += fy * DT + noise * randn();
    // reflect at the edges
    if (x < -a) x = -2 * a - x; else if (x > a) x = 2 * a - x;
    if (y < -1) y = -2 - y; else if (y > 1) y = 2 - y;
    P[2 * i] = x; P[2 * i + 1] = y;
    if (record) {
      const b = coreBasin(x, y);
      if (b >= 0 && b !== state.basin[i]) { state.basin[i] = b; state.hops.push(now); }
    }
  }
}

function recordTrails() {
  state.trailHead = (state.trailHead + 1) % TRAIL;
  const h = state.trailHead, P = state.particles, T = state.trails;
  for (let i = 0; i < state.n; i++) {
    T[(i * TRAIL + h) * 2] = P[2 * i];
    T[(i * TRAIL + h) * 2 + 1] = P[2 * i + 1];
  }
}

// ---------- drawing ----------
const toPx = (x, y) => [((x / state.aspect) + 1) * 0.5 * width, (y + 1) * 0.5 * height];

function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  if (bg) ctx.drawImage(bg, 0, 0, width, height);
  const acc = palette.accent, ink = palette.ink;
  const P = state.particles, T = state.trails, h = state.trailHead;
  const light = isLight();
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  // trails
  ctx.strokeStyle = acc;
  ctx.globalAlpha = light ? 0.2 : 0.26;
  ctx.beginPath();
  for (let i = 0; i < state.n; i++) {
    let idx = (h + 1) % TRAIL; // oldest
    let [px, py] = toPx(T[(i * TRAIL + idx) * 2], T[(i * TRAIL + idx) * 2 + 1]);
    ctx.moveTo(px, py);
    for (let t = 1; t < TRAIL; t++) {
      idx = (h + 1 + t) % TRAIL;
      [px, py] = toPx(T[(i * TRAIL + idx) * 2], T[(i * TRAIL + idx) * 2 + 1]);
      ctx.lineTo(px, py);
    }
  }
  ctx.stroke();
  // particles
  ctx.globalAlpha = 1;
  const r = isSmall() ? 1.6 : 1.9;
  const collapsed = state.collapsed;
  ctx.fillStyle = acc;
  ctx.beginPath();
  for (let i = 0; i < state.n; i++) {
    if (collapsed >= 0 && state.basin[i] !== collapsed) continue;
    const [px, py] = toPx(P[2 * i], P[2 * i + 1]);
    ctx.moveTo(px + r, py);
    ctx.arc(px, py, r, 0, Math.PI * 2);
  }
  ctx.fill();
  if (collapsed >= 0) {
    // stragglers outside the collapsed basin are drawn as faint ink
    ctx.fillStyle = ink;
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    for (let i = 0; i < state.n; i++) {
      if (state.basin[i] === collapsed) continue;
      const [px, py] = toPx(P[2 * i], P[2 * i + 1]);
      ctx.moveTo(px + r, py);
      ctx.arc(px, py, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// ---------- basin labels ----------
function buildLabels() {
  basinsEl.innerHTML = '';
  state.wells.forEach((w, i) => {
    const d = DESTINATIONS[i];
    const a = document.createElement('a');
    a.className = 'basin';
    a.href = d.href;
    a.textContent = d.label;
    a.dataset.i = i;
    if (!d.href.startsWith('#') && !d.href.startsWith('/')) a.rel = 'noopener noreferrer';
    basinsEl.appendChild(a);
  });
  placeLabels();
}
function placeLabels() {
  basinsEl.querySelectorAll('.basin').forEach(a => {
    const w = state.wells[+a.dataset.i];
    const [px, py] = toPx(w.x, w.y);
    a.style.left = px + 'px';
    a.style.top = py + 'px';
  });
}
function styleLabels() {
  basinsEl.querySelectorAll('.basin').forEach(a => {
    const i = +a.dataset.i;
    a.classList.toggle('collapsed', state.collapsed === i);
    a.classList.toggle('faded', state.collapsed >= 0 && state.collapsed !== i);
  });
}

// ---------- controls ----------
function setSeed(seed, { pushUrl = true } = {}) {
  state.seed = seed >>> 0;
  seedCode.textContent = hexSeed(state.seed);
  uncollapse();
  state.wells = buildWells(state.seed);
  renderLandscape();
  spawnParticles();
  buildLabels();
  if (pushUrl) {
    const url = new URL(location.href);
    url.searchParams.set('seed', hexSeed(state.seed).slice(2));
    history.replaceState(null, '', url);
  }
  draw();
}

function measure() {
  if (state.collapsed >= 0) { uncollapse(); return; }
  // Born rule, classical edition: probability = occupancy of each basin.
  const counts = new Array(state.wells.length).fill(0);
  for (let i = 0; i < state.n; i++) counts[state.basin[i]]++;
  let r = Math.random() * state.n, pick = 0;
  for (let i = 0; i < counts.length; i++) { r -= counts[i]; if (r <= 0) { pick = i; break; } }
  state.collapsed = pick;
  state.collapseT = 0;
  state.kT = state.baseKT * 0.25;
  measureBtn.setAttribute('aria-pressed', 'true');
  measureBtn.setAttribute('aria-label', `Collapsed into ${DESTINATIONS[pick].label}. Press again to release`);
  styleLabels();
  if (state.paused) { for (let s = 0; s < 400; s++) { state.collapseT += DT * SUBSTEPS * 6; step(); } recordTrails(); draw(); }
}
function uncollapse() {
  state.collapsed = -1;
  state.collapseT = 0;
  state.kT = state.baseKT;
  measureBtn.setAttribute('aria-pressed', 'false');
  measureBtn.setAttribute('aria-label', 'Measure: collapse the ensemble into one basin');
  styleLabels();
}

function setPaused(p) {
  state.paused = p;
  document.body.classList.toggle('paused', p);
  pauseBtn.setAttribute('aria-pressed', String(p));
  pauseBtn.setAttribute('aria-label', p ? 'Resume animation' : 'Pause animation');
  if (!p && !raf) raf = requestAnimationFrame(frame);
}

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch (e) {}
  themeBtn.setAttribute('aria-label', t === 'light' ? 'Switch to dark mode' : 'Switch to light mode');
  renderLandscape();
  draw();
}

// ---------- layout ----------
let wasSmall = null;
function resize() {
  const rect = stage.getBoundingClientRect();
  width = Math.max(1, Math.round(rect.width));
  height = Math.max(1, Math.round(rect.height));
  dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const newAspect = width / height;
  if (Math.abs(newAspect - state.aspect) > 1e-6) {
    // world x-extent follows the aspect ratio; rescale so wells keep their relative place
    const k = newAspect / state.aspect;
    state.aspect = newAspect;
    for (const w of state.wells) w.x *= k;
    if (state.particles) for (let i = 0; i < state.n; i++) state.particles[2 * i] *= k;
    if (state.trails) for (let i = 0; i < state.trails.length; i += 2) state.trails[i] *= k;
  }
  const small = isSmall() || state.aspect < 0.9;
  if (wasSmall !== null && small !== wasSmall && state.wells.length) { wasSmall = small; setSeed(state.seed, { pushUrl: false }); return; }
  wasSmall = small;
  placeLabels();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { renderLandscape(); draw(); }, 120);
  draw();
}
let resizeTimer = 0;

// ---------- loop ----------
let raf = 0, last = 0, statTick = 0;
function frame(now) {
  raf = 0;
  if (state.paused) return;
  const dtFrame = Math.min(34, now - (last || now));
  last = now;
  const subs = Math.max(1, Math.round(SUBSTEPS * dtFrame / 16.7));
  if (state.collapsed >= 0) state.collapseT += dtFrame / 900;
  for (let s = 0; s < subs; s++) step();
  recordTrails();
  draw();
  if (now - statTick > 500) { statTick = now; updateStat(now); }
  raf = requestAnimationFrame(frame);
}
function updateStat(now) {
  const window_ = 3000;
  while (state.hops.length && now - state.hops[0] > window_) state.hops.shift();
  const rate = (state.hops.length / (window_ / 1000)).toFixed(1);
  const mode = state.collapsed >= 0 ? `collapsed → ${DESTINATIONS[state.collapsed].label}` : `${rate} hops/s`;
  statEl.textContent = `${state.wells.length} basins · kT ${state.kT.toFixed(2)} · ${mode}`;
}

// ---------- pointer ----------
function pointerToWorld(e) {
  const rect = stage.getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width * 2 - 1) * state.aspect;
  const y = (e.clientY - rect.top) / rect.height * 2 - 1;
  return [x, y];
}
stage.addEventListener('pointermove', e => {
  const [x, y] = pointerToWorld(e);
  state.pointer.x = x; state.pointer.y = y; state.pointer.active = true;
});
stage.addEventListener('pointerdown', e => {
  if (e.target.closest('.basin')) return;
  const [x, y] = pointerToWorld(e);
  state.pointer.x = x; state.pointer.y = y; state.pointer.active = true; state.pointer.pressed = true;
  stage.setPointerCapture?.(e.pointerId);
});
const release = () => { state.pointer.pressed = false; };
stage.addEventListener('pointerup', release);
stage.addEventListener('pointercancel', release);
stage.addEventListener('pointerleave', () => { state.pointer.active = false; state.pointer.pressed = false; });

// ---------- wiring ----------
randomizeBtn.addEventListener('click', () => setSeed(randomSeed()));
measureBtn.addEventListener('click', measure);
pauseBtn.addEventListener('click', () => setPaused(!state.paused));
themeBtn.addEventListener('click', () => setTheme(isLight() ? 'dark' : 'light'));
shareLink?.addEventListener('click', async e => {
  e.preventDefault();
  const url = new URL(location.origin + location.pathname);
  url.searchParams.set('seed', hexSeed(state.seed).slice(2));
  try { await navigator.clipboard.writeText(url.toString()); shareLink.textContent = 'link copied'; }
  catch { shareLink.textContent = url.toString(); }
  setTimeout(() => { shareLink.textContent = 'share this landscape'; }, 2200);
});
document.addEventListener('keydown', e => {
  if (e.target !== document.body && e.target !== stage) return;
  if (e.key === ' ') { e.preventDefault(); measure(); }
  else if (e.key === 'r' || e.key === 'R') setSeed(randomSeed());
  else if (e.key === 'p' || e.key === 'P') setPaused(!state.paused);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (raf) { cancelAnimationFrame(raf); raf = 0; } }
  else if (!state.paused && !raf) { last = 0; raf = requestAnimationFrame(frame); }
});
new ResizeObserver(resize).observe(stage);
themeBtn.setAttribute('aria-label', isLight() ? 'Switch to dark mode' : 'Switch to light mode');

// ---------- boot ----------
resize();
setSeed(state.seed, { pushUrl: !!seedParam });
setPaused(state.paused);
updateStat(performance.now());
