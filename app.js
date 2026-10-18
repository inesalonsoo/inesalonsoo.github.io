// A seeded 2-D free-energy landscape with an ensemble of particles diffusing
// between metastable basins under overdamped Langevin dynamics:
//   dx = -∇F(x) dt + sqrt(2 kT dt) ξ
// Each basin is a "state" that links somewhere. "Measure" collapses the
// ensemble into one basin, chosen with probability equal to its occupancy.
// The |résumé⟩ basin is a macrostate: three shallow sub-wells the ensemble
// hops between quickly, lumped like microstates in a Markov state model.
// Hover it (or measure into it) and it resolves into its three states.
// The wells breathe: each depth drifts slowly on its own period, so the
// contour lines around every basin swell and settle.

const stage = document.querySelector('#stage');
const glCanvas = document.querySelector('#landscape');
const canvas = document.querySelector('#field');
const basinsEl = document.querySelector('#basins');
const seedCode = document.querySelector('#seed-code');
const statEl = document.querySelector('#stat');
const randomizeBtn = document.querySelector('#randomize');
const measureBtn = document.querySelector('#measure'); // the uncertainty box
const insideEl = document.querySelector('#inside');
const pauseBtn = document.querySelector('#pause');
const themeBtn = document.querySelector('#theme');
const shareLink = document.querySelector('#share-seed');
const boxEl = document.querySelector('#box');
const cube = document.querySelector('#cube');
let land = initGL(); // { gl, u }, or null without WebGL2: the landscape is then drawn once on the CPU and holds still
const ctx = canvas.getContext('2d', { alpha: !!land }); // particles, over the landscape
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const isSmall = () => matchMedia('(max-width: 700px)').matches;

// Basins are the "states" of this system, and where they lead. A destination
// with `states` is a macrostate whose sub-wells each lead somewhere.
const DESTINATIONS = [
  { label: '|research⟩', href: '#research' },
  { label: '|github⟩', href: 'https://github.com/inesalonsoo' },
  { label: '|linkedin⟩', href: 'https://www.linkedin.com/in/inesalonsocl/' },
  { label: '|résumé⟩', href: '#resume', states: [
    { label: '|industry⟩', href: 'assets/IAlonso_Resume_Industry.pdf', title: 'Industry résumé · 1 page PDF' },
    { label: '|phd⟩', href: 'assets/IAlonso_Resume_PhD.pdf', title: 'PhD résumé · 1 page PDF' },
    { label: '|cv⟩', href: 'assets/IAlonso_CV.pdf', title: 'Full CV · 2 page PDF' },
  ] },
];
const MACRO = DESTINATIONS.findIndex(d => d.states);

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
  wells: [],          // {x, y, depth, sx, sy, subs?, reach?} one per destination
  gauss: [],          // the gaussians that make up F: plain wells and sub-wells, each tagged with .macro; .d is the breathing depth
  time: 0,            // seconds of simulated (unpaused) time, drives the breathing
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
const isPortrait = () => isSmall() || state.aspect < 0.9;
function buildWells(seed) {
  const rnd = mulberry32(seed);
  const wells = placeWells(rnd);
  // split after placing, so a seed lays its basins out the same as it always has
  DESTINATIONS.forEach((d, i) => { if (d.states) splitWell(wells[i], d.states.length, rnd); });
  state.gauss = wells.flatMap((w, i) => (w.subs || [w]).map(g => Object.assign(g, { macro: i })));
  breathe(state.time);
  return wells;
}

// Each well's depth drifts by ±9% on its own 9–15 s period. Near a well of
// width σ that moves its contour rings by about ±0.09σ, slow and calm, and
// almost nothing far from the wells. Only with WebGL: the CPU fallback
// draws the landscape once, so there the wells hold still.
const BREATH = 0.09;
function breathe(t) {
  const a = land ? BREATH : 0;
  state.gauss.forEach((w, i) => {
    const period = 9 + (i * 3.7) % 6;
    w.d = w.depth * (1 + a * Math.sin(2 * Math.PI * t / period + i * 2.1));
  });
}

// Turn a well into a macrostate: k narrow sub-wells on a ring two widths out.
// The barrier between neighbours is about half a sub-well deep (~2 kT), so the
// ensemble hops among them far faster than it escapes the basin.
function splitWell(w, k, rnd) {
  const portrait = isPortrait();
  const s = portrait ? 0.065 : 0.1, r = 2 * s;
  // landscape: a vertex up or down; portrait: a vertex toward the middle of the
  // screen, so the other two stack vertically on the outer side and their labels fit
  const a0 = portrait ? (w.x > 0 ? Math.PI : 0) : (rnd() < 0.5 ? -1 : 1) * Math.PI / 2;
  // k narrow wells have ~1/k the volume of one wide one; +kT·ln k keeps the occupancy fair
  const depth = w.depth + state.baseKT * Math.log(k);
  w.subs = Array.from({ length: k }, (_, j) => {
    const t = a0 + 2 * Math.PI * j / k;
    return { x: w.x + r * Math.cos(t), y: w.y + r * Math.sin(t), sx: s, sy: s, depth };
  });
  w.reach = r + 2 * s;
}

function placeWells(rnd) {
  const a = state.aspect;
  const wells = [];
  if (isPortrait()) {
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
    // keep the bottom-left corner free for the caption and the bottom-right for the box
    if (x < -0.05 * a && y > 0.12) continue;
    if (x > 0.45 * a && y > 0.08) continue;
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

function potential(x, y, base = false) {
  let F = 0.5 * state.confine * ((x / state.aspect) ** 2 + y * y);
  for (const w of state.gauss) {
    const dx = (x - w.x) / w.sx, dy = (y - w.y) / w.sy;
    F -= (base ? w.depth : w.d) * Math.exp(-0.5 * (dx * dx + dy * dy));
  }
  return F;
}

function gradient(x, y, out) {
  let gx = state.confine * x / (state.aspect * state.aspect);
  let gy = state.confine * y;
  for (const w of state.gauss) {
    const dx = (x - w.x) / w.sx, dy = (y - w.y) / w.sy;
    const e = w.d * Math.exp(-0.5 * (dx * dx + dy * dy));
    gx += e * dx / w.sx;
    gy += e * dy / w.sy;
  }
  out[0] = gx; out[1] = gy;
}

// Basin indices are macrostates: landing in any sub-well of |résumé⟩ counts as |résumé⟩.
function nearestBasin(x, y) {
  let best = 0, bestD = Infinity;
  for (const w of state.gauss) {
    const d = ((x - w.x) / w.sx) ** 2 + ((y - w.y) / w.sy) ** 2;
    if (d < bestD) { bestD = d; best = w.macro; }
  }
  return best;
}
// Core-set assignment: a particle only changes state once it is well inside
// another well's core, so saddle-point flicker doesn't count as a transition.
const CORE = 1.3 * 1.3;
function coreBasin(x, y) {
  for (const w of state.gauss) {
    if (((x - w.x) / w.sx) ** 2 + ((y - w.y) / w.sy) ** 2 < CORE) return w.macro;
  }
  return -1;
}
function nearestSub(w, x, y) {
  let best = w.subs[0], bestD = Infinity;
  for (const s of w.subs) {
    const d = (x - s.x) ** 2 + (y - s.y) ** 2;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
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

// ---------- the landscape on the GPU ----------
// The same picture as the CPU path below, evaluated per pixel every frame in a
// fragment shader so the wells can breathe. Contours are antialiased from the
// level's screen-space derivative, so a slowly moving ring glides instead of
// stepping from pixel to pixel. Holds up to 8 gaussians (we use 6).
function initGL() {
  const gl = glCanvas?.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
  if (!gl) return null;
  const vs = `#version 300 es
void main() { // one triangle covering the screen
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
  const fs = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uAspect, uConfine, uFmin, uRange, uTint, uHalfWidth;
uniform int uN;
uniform vec4 uG[8];   // x, y, sx, sy
uniform float uD[8];  // current (breathing) depth
uniform vec3 uBg, uSoft, uLine, uAcc;
out vec4 color;
void main() {
  vec2 p = gl_FragCoord.xy / uRes;
  float x = (p.x * 2.0 - 1.0) * uAspect, y = 1.0 - p.y * 2.0;
  float F = 0.5 * uConfine * ((x / uAspect) * (x / uAspect) + y * y);
  for (int i = 0; i < 8; i++) {
    if (i >= uN) break;
    vec2 d = (vec2(x, y) - uG[i].xy) / uG[i].zw;
    F -= uD[i] * exp(-0.5 * dot(d, d));
  }
  float depth = 1.0 - (F - uFmin) / uRange; // 1 at the deepest point
  float dc = clamp(depth, 0.0, 1.0);
  vec3 c = mix(uBg, uSoft, pow(dc, 1.6));
  c = mix(c, uAcc, uTint * dc * dc * dc);
  float lv = depth * 14.0;
  float dist = abs(lv - floor(lv + 0.5)) / max(fwidth(lv), 1e-6); // device px to the nearest contour
  float major = mod(floor(lv + 0.5), 4.0) < 0.5 ? 0.9 : 0.45;
  c = mix(c, uLine, major * (1.0 - smoothstep(uHalfWidth - 0.5, uHalfWidth + 0.5, dist)));
  color = vec4(c, 1.0);
}`;
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    gl.attachShader(prog, s);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const u = {};
  for (const name of ['uRes', 'uAspect', 'uConfine', 'uFmin', 'uRange', 'uTint', 'uHalfWidth', 'uN', 'uG', 'uD', 'uBg', 'uSoft', 'uLine', 'uAcc']) {
    u[name] = gl.getUniformLocation(prog, name);
  }
  // if the GPU drops the context, fall back to the CPU picture
  glCanvas.addEventListener('webglcontextlost', () => { land = null; renderLandscape(); draw(); });
  return { gl, u };
}

// Per seed / theme / resize: colours, and the depth scale. The scale comes
// from the resting depths so breathing moves the rings, not the whole map.
function prepareLandscapeGL() {
  let fmin = Infinity, fmax = -Infinity;
  const nx = 128, ny = 80;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const f = potential((((i + 0.5) / nx) * 2 - 1) * state.aspect, ((j + 0.5) / ny) * 2 - 1, true);
      if (f < fmin) fmin = f; if (f > fmax) fmax = f;
    }
  }
  for (const w of state.gauss) fmin = Math.min(fmin, potential(w.x, w.y, true));
  const { gl, u } = land;
  const rgb = name => hexToRgb(cssColor(name)).map(v => v / 255);
  gl.uniform1f(u.uFmin, fmin);
  gl.uniform1f(u.uRange, fmax - fmin || 1);
  gl.uniform3fv(u.uBg, rgb('--bg'));
  gl.uniform3fv(u.uSoft, rgb('--soft'));
  gl.uniform3fv(u.uLine, rgb('--line'));
  gl.uniform3fv(u.uAcc, rgb('--accent'));
  gl.uniform1f(u.uTint, isLight() ? 0.10 : 0.16);
}

const gaussBuf = new Float32Array(8 * 4), depthBuf = new Float32Array(8);
function drawLandscapeGL() {
  const { gl, u } = land;
  const n = Math.min(8, state.gauss.length);
  for (let i = 0; i < n; i++) {
    const w = state.gauss[i];
    gaussBuf[4 * i] = w.x; gaussBuf[4 * i + 1] = w.y; gaussBuf[4 * i + 2] = w.sx; gaussBuf[4 * i + 3] = w.sy;
    depthBuf[i] = w.d;
  }
  gl.viewport(0, 0, glCanvas.width, glCanvas.height);
  gl.uniform2f(u.uRes, glCanvas.width, glCanvas.height);
  gl.uniform1f(u.uAspect, state.aspect);
  gl.uniform1f(u.uConfine, state.confine);
  gl.uniform1f(u.uHalfWidth, 0.85 * dpr);
  gl.uniform1i(u.uN, n);
  gl.uniform4fv(u.uG, gaussBuf);
  gl.uniform1fv(u.uD, depthBuf);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// ---------- the landscape on the CPU (fallback, drawn once) ----------
function renderLandscape() {
  refreshPalette();
  if (land) { prepareLandscapeGL(); return; }
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
    // start inside a random basin (and sub-well) so the ensemble is already near equilibrium
    const m = state.wells[Math.floor(Math.random() * state.wells.length)];
    const w = m.subs ? m.subs[Math.floor(Math.random() * m.subs.length)] : m;
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
    if (col) {
      // a macrostate keeps its microstates: each particle settles into the nearest sub-well
      const t = col.subs ? nearestSub(col, x, y) : col;
      fx += (t.x - x) * pull; fy += (t.y - y) * pull;
    }
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
  if (land) drawLandscapeGL();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  if (land) ctx.clearRect(0, 0, width, height);
  else if (bg) ctx.drawImage(bg, 0, 0, width, height);
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
function makeLink(d, className) {
  const a = document.createElement('a');
  a.className = className;
  a.href = d.href;
  a.textContent = d.label;
  if (d.title) a.title = d.title;
  if (!d.href.startsWith('#') && !d.href.startsWith('/')) a.rel = 'noopener noreferrer';
  return a;
}
// A macrostate's label sits in a .macro group with one .micro label per
// sub-well; the micro labels wait at the basin centre until the group splits.
function buildLabels() {
  basinsEl.innerHTML = '';
  state.wells.forEach((w, i) => {
    const d = DESTINATIONS[i];
    const a = makeLink(d, 'basin');
    a.dataset.i = i;
    if (!d.states) { basinsEl.appendChild(a); return; }
    const group = document.createElement('div');
    group.className = 'macro';
    a.setAttribute('aria-expanded', 'false');
    group.append(a, ...d.states.map((s, k) => {
      const m = makeLink(s, 'basin micro');
      m.style.setProperty('--k', k);
      return m;
    }));
    basinsEl.appendChild(group);
  });
  placeLabels();
  updateSplit();
}
function placeLabels() {
  const labels = [...basinsEl.querySelectorAll('.basin[data-i]')];
  for (const a of labels) {
    const w = state.wells[+a.dataset.i];
    const [px, py] = toPx(w.x, w.y);
    a.style.left = px + 'px';
    a.style.top = py + 'px';
  }
  for (const a of labels) {
    const w = state.wells[+a.dataset.i];
    if (w.subs) placeMicro(a, w, labels.filter(o => o !== a));
  }
}
// Each micro label goes on its sub-well if that spot is free; otherwise it
// spirals outward (starting away from the basin centre) to the nearest spot
// clear of the other labels and the hero furniture, below the top controls.
function placeMicro(macro, w, otherLabels) {
  const s = stage.getBoundingClientRect();
  const rectBox = r => ({ x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2, w: r.width, h: r.height });
  const labelBox = el => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: el.offsetWidth, h: el.offsetHeight });
  const taken = [
    labelBox(macro),
    ...otherLabels.map(labelBox),
    ...['.scene', '.caption', '.links'].map(sel => rectBox(document.querySelector(sel).getBoundingClientRect())),
  ];
  const gap = 6;
  const hits = (b, x, y) => taken.some(q => Math.abs(x - q.x) < (b.w + q.w) / 2 + gap && Math.abs(y - q.y) < (b.h + q.h) / 2 + gap);
  const [cx, cy] = toPx(w.x, w.y);
  [...macro.parentElement.querySelectorAll('.micro')].forEach((el, k) => {
    const b = { w: el.offsetWidth, h: el.offsetHeight };
    const inX = x => Math.min(Math.max(x, b.w / 2 + 8), width - b.w / 2 - 8);
    const inY = y => Math.min(Math.max(y, 72 + b.h / 2), height - b.h / 2 - 8);
    const [x0, y0] = toPx(w.subs[k].x, w.subs[k].y);
    const away = Math.atan2(y0 - cy, x0 - cx);
    b.x = inX(x0); b.y = inY(y0);
    search: for (let r = 0; r <= 160; r += 8) {
      for (let j = 0; j < (r ? 16 : 1); j++) {
        const t = away + (j % 2 ? -1 : 1) * Math.ceil(j / 2) * Math.PI / 8;
        const x = inX(x0 + r * Math.cos(t)), y = inY(y0 + r * Math.sin(t));
        if (!hits(b, x, y)) { b.x = x; b.y = y; break search; }
      }
    }
    taken.push(b);
    el.style.left = cx + 'px';
    el.style.top = cy + 'px';
    el.style.setProperty('--dx', (b.x - cx).toFixed(1) + 'px');
    el.style.setProperty('--dy', (b.y - cy).toFixed(1) + 'px');
  });
}
function styleLabels() {
  basinsEl.querySelectorAll('.basin[data-i]').forEach(a => {
    const i = +a.dataset.i;
    a.classList.toggle('collapsed', state.collapsed === i);
    a.classList.toggle('faded', state.collapsed >= 0 && state.collapsed !== i);
  });
  updateSplit();
}

// ---------- the macrostate splitting ----------
// Resolved while the pointer is over the basin, while keyboard focus is inside
// it, after a tap on its label (touch has no hover), or when measured into.
const split = { hover: false, focus: false, tap: false };
function updateSplit() {
  const group = basinsEl.querySelector('.macro');
  if (!group) return;
  const on = split.hover || split.focus || split.tap || state.collapsed === MACRO;
  group.classList.toggle('split', on);
  group.firstElementChild.setAttribute('aria-expanded', String(on));
}
function hoverSplit(x, y) {
  const w = state.wells[MACRO];
  if (!w) return;
  // hysteresis: resolve inside reach, merge again only well outside it
  const near = Math.hypot(x - w.x, y - w.y) < w.reach * (split.hover ? 1.4 : 1);
  if (near !== split.hover) { split.hover = near; updateSplit(); }
}
basinsEl.addEventListener('click', e => {
  // first tap on a merged |résumé⟩ resolves it; once resolved, the label leads to #resume
  const a = e.target.closest('.macro > .basin:not(.micro)');
  if (!a || a.parentElement.classList.contains('split')) return;
  e.preventDefault();
  split.tap = true;
  updateSplit();
});
basinsEl.addEventListener('focusin', e => {
  if (e.target.closest('.macro') && e.target.matches(':focus-visible')) { split.focus = true; updateSplit(); }
});
basinsEl.addEventListener('focusout', e => {
  if (e.target.closest('.macro') && !e.relatedTarget?.closest?.('.macro')) { split.focus = false; updateSplit(); }
});

// ---------- controls ----------
function setSeed(seed, { pushUrl = true } = {}) {
  state.seed = seed >>> 0;
  seedCode.textContent = hexSeed(state.seed);
  uncollapse();
  state.wells = buildWells(state.seed);
  renderLandscape();
  spawnParticles();
  split.tap = false;
  buildLabels();
  if (pushUrl) {
    const url = new URL(location.href);
    url.searchParams.set('seed', hexSeed(state.seed).slice(2));
    history.replaceState(null, '', url);
  }
  draw();
}

function measure() {
  let pick;
  if (state.collapsed >= 0) {
    // Already collapsed: a fresh measurement lands in a different basin.
    const others = state.wells.map((_, i) => i).filter(i => i !== state.collapsed);
    pick = others[Math.floor(Math.random() * others.length)];
  } else {
    // Born rule, classical edition: probability = occupancy of each basin.
    const counts = new Array(state.wells.length).fill(0);
    for (let i = 0; i < state.n; i++) counts[state.basin[i]]++;
    let r = Math.random() * state.n; pick = 0;
    for (let i = 0; i < counts.length; i++) { r -= counts[i]; if (r <= 0) { pick = i; break; } }
  }
  state.collapsed = pick;
  state.collapseT = 0;
  state.kT = state.baseKT * 0.25;
  measureBtn.setAttribute('aria-pressed', 'true');
  startCube();
  measureBtn.setAttribute('aria-label', `Collapsed into ${DESTINATIONS[pick].label}. Tap again for a new measurement; click the landscape to release`);
  showInside(() => {
    // a macrostate shows up in the box as its microstates
    const d = DESTINATIONS[pick];
    insideEl.classList.toggle('kets', !!d.states);
    insideEl.replaceChildren(...(d.states || [d]).map(s => makeLink(s, '')));
  });
  styleLabels();
  if (state.paused) { for (let s = 0; s < 400; s++) { state.collapseT += DT * SUBSTEPS * 6; step(); } recordTrails(); draw(); }
}
function uncollapse() {
  state.collapsed = -1;
  state.collapseT = 0;
  state.kT = state.baseKT;
  measureBtn.setAttribute('aria-pressed', 'false');
  startCube();
  measureBtn.setAttribute('aria-label', 'The uncertainty box. Tap to measure the system and collapse it into one basin');
  if (insideEl.firstElementChild) showInside(() => { insideEl.classList.remove('kets'); insideEl.textContent = 'tap to measure'; });
  styleLabels();
}
// Cross-fade the text inside the box.
function showInside(update) {
  insideEl.classList.add('swap');
  setTimeout(() => { update(); insideEl.classList.remove('swap'); }, 350);
}

function setPaused(p) {
  state.paused = p;
  document.body.classList.toggle('paused', p);
  pauseBtn.setAttribute('aria-pressed', String(p));
  pauseBtn.setAttribute('aria-label', p ? 'Resume animation' : 'Pause animation');
  if (!p && !raf && heroVisible) { last = 0; raf = requestAnimationFrame(frame); }
  startCube(); // the idle spin follows play/pause
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
  canvas.width = glCanvas.width = Math.round(width * dpr);
  canvas.height = glCanvas.height = Math.round(height * dpr);
  const newAspect = width / height;
  if (Math.abs(newAspect - state.aspect) > 1e-6) {
    // world x-extent follows the aspect ratio; rescale so wells keep their relative place
    const k = newAspect / state.aspect;
    state.aspect = newAspect;
    for (const w of state.wells) { w.x *= k; w.subs?.forEach(s => { s.x *= k; }); }
    if (state.particles) for (let i = 0; i < state.n; i++) state.particles[2 * i] *= k;
    if (state.trails) for (let i = 0; i < state.trails.length; i += 2) state.trails[i] *= k;
  }
  const small = isPortrait();
  if (wasSmall !== null && small !== wasSmall && state.wells.length) { wasSmall = small; setSeed(state.seed, { pushUrl: false }); return; }
  wasSmall = small;
  placeLabels();
  if (land) renderLandscape(); // cheap on the GPU path
  else { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { renderLandscape(); draw(); }, 120); }
  draw();
}
let resizeTimer = 0;

// ---------- loop ----------
let raf = 0, last = 0, statTick = 0;
function frame(now) {
  raf = 0;
  if (state.paused || !heroVisible) return;
  const dtFrame = Math.min(34, now - (last || now));
  last = now;
  state.time += dtFrame / 1000;
  breathe(state.time);
  const subs = Math.max(1, Math.round(SUBSTEPS * dtFrame / 16.7));
  if (state.collapsed >= 0) state.collapseT += dtFrame / 900;
  for (let s = 0; s < subs; s++) step();
  recordTrails();
  draw();
  if (now - statTick > 500) { statTick = now; updateStat(now); }
  raf = requestAnimationFrame(frame);
}
// Nothing in the hero needs to run while it is scrolled out of view.
let heroVisible = true;
new IntersectionObserver(([entry]) => {
  heroVisible = entry.isIntersecting;
  if (!heroVisible) return;
  if (!state.paused && !raf) { last = 0; raf = requestAnimationFrame(frame); }
  startCube();
}).observe(stage);

function updateStat(now) {
  const window_ = 3000;
  while (state.hops.length && now - state.hops[0] > window_) state.hops.shift();
  const rate = (state.hops.length / (window_ / 1000)).toFixed(1);
  const mode = state.collapsed >= 0 ? `collapsed → ${DESTINATIONS[state.collapsed].label}` : `${rate} hops/s`;
  statEl.textContent = `${state.wells.length} basins · kT ${state.kT.toFixed(2)} · ${mode}`;
}

// ---------- the uncertainty box ----------
// The cube is driven from here rather than by a CSS animation so it can ease
// between its idle spin; a hover, where it slows, lifts, leans toward the
// pointer and wobbles a little (something is moving in there); a squash when
// pressed; and turning to face you when opened. All smoothing is exponential,
// so every change of state is gentle. The idle spin and the wobble follow the
// play/pause state (reduced motion starts paused); the hover lean only moves
// when the pointer does, so it always responds. When nothing is left to
// animate the loop sleeps, and the pointer, a press, play or a measurement wake it.
const cubeState = {
  yaw: 30, pitch: -18, scale: 1, speed: 0,        // degrees, degrees per second (eases up to the idle spin)
  hovering: false, hover: 0,                      // pointer over the box, and its eased 0..1
  aimX: 0, aimY: 0, tiltX: 0, tiltY: 0,           // pointer offset from the cube centre (−1..1), eased
  kick: 0,                                        // press squash, decays
  t: 0, last: 0, raf: 0,
};
function cubeFrame(now) {
  const c = cubeState;
  c.raf = 0;
  if (!heroVisible) return;
  const dt = Math.min(0.05, (now - (c.last || now)) / 1000);
  c.last = now;
  c.t += dt;
  const ease = rate => 1 - Math.exp(-rate * dt);
  const open = measureBtn.getAttribute('aria-pressed') === 'true';
  const still = state.paused;
  c.hover += ((c.hovering ? 1 : 0) - c.hover) * ease(5);
  c.tiltX += (c.aimX * c.hover - c.tiltX) * ease(7);
  c.tiltY += (c.aimY * c.hover - c.tiltY) * ease(7);
  c.kick -= c.kick * ease(9);
  const front = Math.round(c.yaw / 360) * 360;
  if (open) {
    // stop spinning and turn the nearest way round to face front
    c.speed -= c.speed * ease(8);
    c.yaw += (front - c.yaw) * ease(5);
  } else {
    // idle: a turn every 28 s; hovered: a fifth of that; paused: none
    c.speed += ((still ? 0 : (360 / 28) * (1 - 0.8 * c.hover)) - c.speed) * ease(3);
    c.yaw += c.speed * dt;
  }
  const pitchTo = open ? 0 : -18, scaleTo = open ? 1.08 : 1 + 0.05 * c.hover;
  c.pitch += (pitchTo - c.pitch) * ease(6);
  c.scale += (scaleTo - c.scale) * ease(6);
  const lean = open ? 0.35 : 1; // opened, it only glances at the pointer
  const wobble = open || still ? 0 : c.hover;
  const roll = wobble * (2.2 * Math.sin(c.t * 5.3) + 1.1 * Math.sin(c.t * 8.7 + 1.3));
  const lift = -6 * c.hover * lean + wobble * 1.5 * Math.sin(c.t * 3.1);
  cube.style.transform =
    `translateY(${lift.toFixed(2)}px) rotateZ(${roll.toFixed(2)}deg) ` +
    `rotateX(${(c.pitch - c.tiltY * 24 * lean).toFixed(2)}deg) ` +
    `rotateY(${(c.yaw + c.tiltX * 32 * lean).toFixed(2)}deg) ` +
    `scale(${(c.scale * (1 - 0.07 * c.kick)).toFixed(4)})`;
  const settled = still && !c.hovering && c.hover < 1e-3 && Math.abs(c.speed) < 0.01 && c.kick < 1e-3 &&
    Math.abs(c.tiltX) < 1e-3 && Math.abs(c.tiltY) < 1e-3 && Math.abs(pitchTo - c.pitch) < 0.01 &&
    Math.abs(scaleTo - c.scale) < 1e-4 && (!open || Math.abs(front - c.yaw) < 0.01);
  if (!settled) c.raf = requestAnimationFrame(cubeFrame);
}
function startCube() {
  if (cubeState.raf || !heroVisible) return;
  cubeState.last = 0;
  cubeState.raf = requestAnimationFrame(cubeFrame);
}
boxEl.addEventListener('pointermove', e => {
  if (e.pointerType === 'touch') return;
  const r = measureBtn.getBoundingClientRect();
  const clamp1 = v => Math.max(-1, Math.min(1, v));
  cubeState.aimX = clamp1((e.clientX - r.left - r.width / 2) / (r.width * 0.75));
  cubeState.aimY = clamp1((e.clientY - r.top - r.height / 2) / (r.height * 0.75));
  cubeState.hovering = true;
  startCube();
});
boxEl.addEventListener('pointerleave', () => { cubeState.hovering = false; });
measureBtn.addEventListener('pointerdown', () => { cubeState.kick = 1; startCube(); });

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
  if (e.pointerType === 'mouse') hoverSplit(x, y);
});
stage.addEventListener('pointerdown', e => {
  if (e.target.closest('.basin')) return;
  if (split.tap) { split.tap = false; updateSplit(); }
  if (state.collapsed >= 0) uncollapse(); // clicking the landscape resets the measurement
  const [x, y] = pointerToWorld(e);
  state.pointer.x = x; state.pointer.y = y; state.pointer.active = true; state.pointer.pressed = true;
  stage.setPointerCapture?.(e.pointerId);
});
const release = () => { state.pointer.pressed = false; };
stage.addEventListener('pointerup', release);
stage.addEventListener('pointercancel', release);
stage.addEventListener('pointerleave', () => {
  state.pointer.active = false; state.pointer.pressed = false;
  if (split.hover) { split.hover = false; updateSplit(); }
});

// ---------- wiring ----------
randomizeBtn.addEventListener('click', () => setSeed(randomSeed()));
measureBtn.addEventListener('click', e => { if (!e.target.closest('a')) measure(); });
measureBtn.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); measure(); }
});
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
startCube();
