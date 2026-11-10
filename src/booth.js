// The DJ booth: two decks with a mixer between them, the one view they share, and the mixer's controls.
// Booth coordinates are the decks' world coordinates moved so the middle of the mixer is at x = 0 (+y is away from the DJ, +z up).
// Each deck still has its own canvas with its spindle at its own origin. Both look through one camera, each at half of the window.
// The two pictures meet on an upright plane through the eye. It has to pass between the decks, so it sits in the gap between them on screen.
import * as G from './gl-util.js';
import { ALPHA_REST, PIVOT_X, PIVOT_Y } from './geometry.js';

export const FACE_W = 0.324, FACE_D = 0.374;     // the mixer's faceplate
// The same camera as a deck on its own (turntable.js). Turned much further, the decks overlap on screen and no line can be drawn between them.
const PHONE = 640, AZ0 = -0.5, EL0 = 0.6, AZ_MAX = 0.65, EL_MIN = 0.25, EL_MAX = 1.45, MIN_PULL = 0.6, KNOB_PX = 180, DOUBLE_MS = 320, TAU = 2 * Math.PI;
const TOP = -0.08, FACE = -0.02, MIX = 0.165, DEEP = 0.19, GAP = 0.012;     // the floor (where the decks' feet stand), faceplate height, half the mixer's size, space beside it
const ORIGIN = [-(MIX + GAP + 0.27), MIX + GAP + 0.185];                    // each deck's spindle, in booth coordinates
const KNOB_Z = FACE + 0.0145, CAP_Z = FACE + 0.011, BTN_Z = FACE + 0.005;
const INNER = 0.082, OUTER = 0.132, ROWS = [0.140, 0.092, 0.044];         // the two columns of knobs on each side
const AMBER = [1.5, 0.82, 0.24], RED = [1.7, 0.16, 0.12], GREEN = [0.35, 1.3, 0.5];
const PHASE_LEDS = 7, PHASE_SPAN = 0.03, LIMIT_SHOWN = 0.02;                // the limiter's lamp comes on from about 0.2 dB of reduction
const POOL_FULL = 0.4, POOL_END = 1.5;                                       // the key light's pool round the middle of the mixer: full strength, and where it has faded out
const lerp = (a, b, t) => a + (b - a) * t, clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const toMeter = (peak) => clamp(1 + 20 * Math.log10(peak + 1e-6) / 42, 0, 1);    // 16 segments over 42 dB
const root = document.documentElement;

// The mixer's controls. Each drives one of the page's own sliders (mixer.js), which stay the only record of the settings.
const knob = (id, x, y, label) => ({ id, kind: 'knob', x, y, z: KNOB_Z, label });
const CONTROLS = [
  ...[['a', -1], ['b', 1]].flatMap(([side, s]) => [
    knob(`m-trim-${side}`, s * OUTER, ROWS[0], 'TRIM'), knob(`m-filter-${side}`, s * OUTER, ROWS[1], 'FILTER'), knob(`m-echo-${side}`, s * OUTER, ROWS[2], 'ECHO'),
    knob(`m-high-${side}`, s * INNER, ROWS[0], 'HI'), knob(`m-mid-${side}`, s * INNER, ROWS[1], 'MID'), knob(`m-low-${side}`, s * INNER, ROWS[2], 'LOW'),
    { id: `m-cue-${side}`, kind: 'button', x: s * INNER, y: 0.008, z: BTN_Z, lit: AMBER, label: 'CUE', labelX: s * (INNER + 0.027) },
    { id: `m-level-${side}`, kind: 'fader', x: s * INNER, y0: -0.112, y1: -0.012, z: CAP_Z },
  ]),
  { ...knob('m-master', 0, 0.165, 'MASTER'), labelY: 0.1385 },
  knob('m-cuemix', 0, -0.118),
  { id: 'm-cross', kind: 'cross', y: -0.160, x0: -0.06, x1: 0.06, z: CAP_Z },
  { id: 'm-rec', kind: 'button', x: -0.128, y: -0.160, z: BTN_Z, lit: RED, label: 'REC', labelY: -0.137 },
  { id: 'm-curve', kind: 'button', x: 0.128, y: -0.160, z: BTN_Z, lit: AMBER, label: 'CUT', labelY: -0.137 },
];
const METERS = [-0.030, -0.010, 0.010, 0.030];

// What has to stay in view of each deck, in deck A's coordinates (A's renderer does the measuring): the plinth, its feet, the arm's counterweight. The mixer is lower and between them.
const WEIGHT = [PIVOT_X - 0.06 * Math.cos(ALPHA_REST), PIVOT_Y - 0.06 * Math.sin(ALPHA_REST), 0.065];
const SEEN = ORIGIN.map((o) => [-0.185, 0.27].flatMap((x) => [-0.19, 0.19].flatMap((y) => [-0.03, TOP].map((z) => [x, y, z]))).concat([WEIGHT]).map(([x, y, z]) => [x + o - ORIGIN[0], y, z]));
const SEAM_CLEAR = 0.02;                         // how far the seam stays from either deck on screen, in the camera's clip units
const homeFor = (i) => [-ORIGIN[i], 0, -0.05];   // where the camera looks: the middle of the mixer

// The artwork printed on the faceplate.
function faceArt() {
  const W = 1296, H = 1496, c = Object.assign(document.createElement('canvas'), { width: W, height: H }), k = c.getContext('2d');
  const X = (x) => (x / FACE_W + 0.5) * W, Y = (y) => (0.5 - y / FACE_D) * H, mm = 4;
  const bg = k.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#26262a'); bg.addColorStop(1, '#1b1b1e');
  k.fillStyle = bg; k.fillRect(0, 0, W, H);
  const ink = '#d8d4cc', amber = '#ffb454';
  k.textAlign = 'center'; k.textBaseline = 'middle';
  const text = (s, x, y, px, col = ink) => { k.font = `600 ${px}px ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", sans-serif`; k.fillStyle = col; k.fillText(s, x, y); };
  const line = (x0, y0, x1, y1, w = 3, col = ink) => { k.strokeStyle = col; k.lineWidth = w; k.beginPath(); k.moveTo(x0, y0); k.lineTo(x1, y1); k.stroke(); };
  const slot = (x0, y0, x1, y1) => { k.fillStyle = '#050506'; k.beginPath(); k.roundRect(x0, y0, x1 - x0, y1 - y0, 8); k.fill(); };
  for (const c0 of CONTROLS) {
    if (c0.kind === 'knob') {
      const x = X(c0.x), y = Y(c0.y), side = c0.x < 0 ? -1 : 1;
      for (let i = 0; i <= 10; i++) {
        const a = (i / 10 - 0.5) * 1.5 * Math.PI, s = Math.sin(a), co = Math.cos(a), r0 = 16 * mm, r1 = (i % 5 ? 18 : 19.5) * mm;
        line(x + r0 * s, y - r0 * co, x + r1 * s, y - r1 * co, i % 5 ? 3 : 5);
      }
      if (c0.label) text(c0.label, x, Y(c0.labelY ?? c0.y + 0.0238), 28);
    } else if (c0.kind === 'button') {
      k.fillStyle = '#050506'; k.beginPath(); k.roundRect(X(c0.x) - 12.5 * mm, Y(c0.y) - 12.5 * mm, 25 * mm, 25 * mm, 8); k.fill();
      text(c0.label, X(c0.labelX ?? c0.x), Y(c0.labelY ?? c0.y), 28);
    } else if (c0.kind === 'fader') {
      const x = X(c0.x), y0 = Y(c0.y0), y1 = Y(c0.y1);
      slot(x - 2.5 * mm, y1 - 5 * mm, x + 2.5 * mm, y0 + 5 * mm);
      for (let i = 0; i <= 10; i++) { const y = lerp(y0, y1, i / 10), w = (i % 5 ? 4 : 7) * mm; line(x - 12 * mm - w, y, x - 12 * mm, y); line(x + 12 * mm, y, x + 12 * mm + w, y); }
    } else {
      const x0 = X(c0.x0), x1 = X(c0.x1), y = Y(c0.y);
      slot(x0 - 5 * mm, y - 2.5 * mm, x1 + 5 * mm, y + 2.5 * mm);
      for (let i = 0; i <= 10; i++) { const x = lerp(x0, x1, i / 10), w = (i % 5 ? 3 : 6) * mm; line(x, y - 12 * mm - w, x, y - 12 * mm); }
      text('A', x0 - 16 * mm, y, 50, amber); text('B', x1 + 16 * mm, y, 50, amber);
    }
  }
  text('A', X(-0.107), Y(0.178), 44, amber); text('B', X(0.107), Y(0.178), 44, amber);
  k.fillStyle = '#050506'; k.fillRect(X(-0.039), Y(0.132), X(0.039) - X(-0.039), Y(-0.072) - Y(0.132));   // behind the meters
  text('A', X(METERS[0]), Y(-0.0675), 20); text('L', X(METERS[1]), Y(-0.0675), 20); text('R', X(METERS[2]), Y(-0.0675), 20); text('B', X(METERS[3]), Y(-0.0675), 20);
  text('PHASE', X(0), Y(-0.0915), 20);
  text('CUE', X(-0.036), Y(-0.118), 24); text('MIX', X(0.036), Y(-0.118), 24);
  for (const [fx, fy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {             // the screws holding the plate
    const x = X(fx * (FACE_W / 2 - 0.009)), y = Y(fy * (FACE_D / 2 - 0.009));
    k.fillStyle = '#4a4a4f'; k.beginPath(); k.arc(x, y, 3 * mm, 0, TAU); k.fill();
    line(x - 2 * mm, y - 1 * mm, x + 2 * mm, y + 1 * mm, 5, '#0a0a0b');
  }
  return c;
}

// The booth's meshes and the faceplate's picture, made for one deck's GL context the first time it is in the booth.
export function boothParts(gl) {
  const m = (d) => G.mesh(gl, d), L = G.lathe;
  const tex = gl.createTexture(), art = faceArt();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, art);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
  if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 8);
  return {
    tex,
    body: m(G.rbox(-MIX, -DEEP, MIX, DEEP, TOP, FACE - 0.002, 0.012, 0.002)),
    face: m(G.rbox(-FACE_W / 2, -FACE_D / 2, FACE_W / 2, FACE_D / 2, FACE - 0.002, FACE, 0.01, 0.0006)),
    knob: m(L([[0.0125, 0], [0.0125, 0.0024], [0.0112, 0.0036], [0.0098, 0.0125], [0.0088, 0.0145], [0, 0.0145]], 40)),
    tick: m(G.box(-0.0006, 0.0025, 0.0143, 0.0006, 0.0088, 0.0149)),
    cap: m(G.rbox(-0.009, -0.0055, 0.009, 0.0055, 0, 0.011, 0.002, 0.0012)),
    capLine: m(G.box(-0.0085, -0.0005, 0.0108, 0.0085, 0.0005, 0.0113)),
    capX: m(G.rbox(-0.0055, -0.009, 0.0055, 0.009, 0, 0.011, 0.002, 0.0012)),
    capXLine: m(G.box(-0.0005, -0.0085, 0.0108, 0.0005, 0.0085, 0.0113)),
    meter: m(G.box(-0.006, -0.1, 0, 0.006, 0.1, 0.0009)),
    button: m(G.rbox(-0.0105, -0.0105, 0.0105, 0.0105, 0, 0.005, 0.0022, 0.0009)),
    dot: m(G.box(-0.0034, -0.0024, 0, 0.0034, 0.0024, 0.0012)),
  };
}

// Everything the booth adds to one deck's picture, as the renderer's [mesh, model, albedo, roughness, metalness, mode, emissive, level].
export function boothItems(p, v) {
  const B = G.T(v.x, 0, 0), at = (x, y, z, ...rest) => G.chain(B, G.T(x, y, z), ...rest), off = [0, 0, 0];
  const DARK = [0.016, 0.016, 0.018], WHITE = [0.8, 0.78, 0.72];
  const items = [[p.body, B, DARK, 0.55, 0.3, 0, off], [p.face, B, DARK, 0.52, 0.15, 7, off]];
  for (const c of CONTROLS) {
    if (c.kind === 'knob') {
      const M = at(c.x, c.y, FACE, G.Rz(-(c.t - 0.5) * 1.5 * Math.PI)), live = !c.el?.disabled;
      items.push([p.knob, M, [0.03, 0.03, 0.033], 0.42, 0.3, 0, off], [p.tick, M, WHITE, 0.4, 0, 0, live ? [1.1, 1.0, 0.85] : off]);
    } else if (c.kind === 'button') {
      const on = c.el?.checked, live = !c.el?.disabled;
      items.push([p.button, at(c.x, c.y, FACE - (on ? 0.0012 : 0)), on ? [0.1, 0.09, 0.08] : [0.05, 0.05, 0.055], 0.42, 0.1, 0, on && live ? c.lit : off]);
    } else if (c.kind === 'fader') {
      const M = at(c.x, lerp(c.y0, c.y1, c.t), FACE);
      items.push([p.cap, M, [0.05, 0.05, 0.055], 0.38, 0.4, 0, off], [p.capLine, M, WHITE, 0.4, 0, 0, [1.1, 1.0, 0.85]]);
    } else {
      const M = at(lerp(c.x0, c.x1, c.t), c.y, FACE);
      items.push([p.capX, M, [0.05, 0.05, 0.055], 0.38, 0.4, 0, off], [p.capXLine, M, WHITE, 0.4, 0, 0, [1.1, 1.0, 0.85]]);
    }
  }
  METERS.forEach((x, i) => items.push([p.meter, at(x, 0.03, FACE), DARK, 0.3, 0, 8, off, v.meters[i]]));
  [-1, 1].forEach((s, i) => { const b = v.beats[i]; items.push([p.dot, at(s * OUTER, 0.008, FACE), DARK, 0.4, 0, 0, b.known ? GREEN.map((g) => g * b.flash + 0.04) : off]); });
  items.push([p.dot, at(0, 0.1385 - 0.0115, FACE), DARK, 0.4, 0, 0, v.limiting ? RED : off]);
  for (let i = 0; i < PHASE_LEDS; i++) {
    const t = i / (PHASE_LEDS - 1), lit = v.phase != null && Math.round((v.phase + 0.5) * (PHASE_LEDS - 1)) === i;
    items.push([p.dot, at((t * 2 - 1) * PHASE_SPAN, -0.082, FACE), DARK, 0.4, 0, 0, lit ? (i === (PHASE_LEDS - 1) / 2 ? GREEN : AMBER) : off]);
  }
  return items;
}

export class Booth {
  constructor() {
    this.on = false; this.az = AZ0; this.el = EL0; this.resetting = false;
    this.pull = this.pullT = 1.4; this.shiftY = this.shiftT = 0; this.seam = 0; this.key = '';
    this.snap = false;
    this.levels = [0, 0]; this.meters = [0, 0, 0, 0]; this.beats = [{ known: false, flash: 0 }, { known: false, flash: 0 }]; this.phase = null;
    this.grabs = new Map(); this.lastPress = null;
  }
  get moved() { return this.on && (Math.abs(this.az - AZ0) > 0.01 || Math.abs(this.el - EL0) > 0.01); }

  // Once a frame, before the decks draw.
  step(decks, mixer, controllers = []) {
    const on = decks.length > 1 && innerWidth > PHONE;
    if (on !== this.on) {
      this.on = on; root.classList.toggle('booth', on); this.grabs.clear(); this.key = '';
      if (on) { this.az = AZ0; this.el = EL0; this.resetting = false; this.snap = true; for (const c of CONTROLS) c.el = document.getElementById(c.id); }
      else root.classList.remove('zoomed');
    }
    if (!on) return;
    for (const d of decks) d.renderer.resize();
    const [A] = decks, key = `${A.canvas.width}x${A.canvas.height}`;
    if (key !== this.key) { this.key = key; this.fit(A, this.freeBox(decks)); }
    if (this.snap) { this.pull = this.pullT; this.shiftY = this.shiftT; this.snap = false; }
    this.pull += (this.pullT - this.pull) * 0.12; this.shiftY += (this.shiftT - this.shiftY) * 0.12;
    if (this.resetting) {
      this.az += (AZ0 - this.az) * 0.12; this.el += (EL0 - this.el) * 0.12;
      if (Math.abs(this.az - AZ0) < 1e-3 && Math.abs(this.el - EL0) < 1e-3) { this.az = AZ0; this.el = EL0; this.resetting = false; }
    }
    this.seam = this.measure(A.renderer, this.az, this.el, this.pull).seam;
    root.classList.toggle('zoomed', decks.some((d) => d.S.zoom > 2e-3));
    for (const c of CONTROLS) if (c.kind !== 'button') c.t = c.el ? (+c.el.value - +c.el.min) / (+c.el.max - +c.el.min) : 0;
    this.light(mixer?.meters);
    this.readBeats(controllers);
    this.limiting = (mixer?.meters?.reduced ?? 0) > LIMIT_SHOWN;
  }

  // Where both decks fall on screen from the shared camera, before the picture is slid anywhere, in clip units of one canvas (x = 0 is the camera's centre line).
  // seam: where the two halves of the window should meet: in the gap between the decks, as near the middle of the whole picture as that allows.
  measure(renderer, az, el, pull) {
    const view = { az, el, pull, al: ALPHA_REST, home: homeFor(0), base: 1, zoom: 0, shift: [0, 0] };
    const [a, b] = SEEN.map((points) => renderer.extent({ ...view, points }));
    const x0 = Math.min(a.x0, b.x0), x1 = Math.max(a.x1, b.x1), lo = a.x1 + SEAM_CLEAR, hi = b.x0 - SEAM_CLEAR;
    return { x0, x1, y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1), seam: lo <= hi ? clamp((x0 + x1) / 2, lo, hi) : (a.x1 + b.x0) / 2 };
  }
  // The pull and upward slide that fit both decks into `box` (CSS pixels) from the resting view. Each deck has to fit on its own side of the seam.
  fit(A, box) {
    const r = A.canvas.getBoundingClientRect(), nx = (px) => (px - r.left) / r.width * 2 - 1, ny = (py) => 1 - (py - r.top) / r.height * 2;
    const left = 1 - nx(box.left), right = nx(box.right) - 1, top = ny(box.top), bottom = ny(box.bottom);
    if (left <= 0 || right <= 0 || top <= bottom) return;
    let pull = 1, m;
    for (let i = 0; i < 5; i++) {       // the picture does not shrink quite in proportion: perspective changes with distance
      m = this.measure(A.renderer, AZ0, EL0, pull);
      pull = Math.max(MIN_PULL, pull * Math.max((m.seam - m.x0) / left, (m.x1 - m.seam) / right, (m.y1 - m.y0) / (top - bottom)));
    }
    m = this.measure(A.renderer, AZ0, EL0, pull);
    this.pullT = pull; this.shiftT = (top + bottom - m.y0 - m.y1) / 2;
  }

  // The part of the window with nothing over the booth.
  freeBox(decks) {
    const box = (id) => document.getElementById(id).getBoundingClientRect();
    const under = ['console', 'hud', 'hud-b'].map(box).filter((r) => r.width);
    return { left: 16, right: innerWidth - 16, top: box('toggles').bottom + 6, bottom: Math.min(...under.map((r) => r.top)) - 22 };
  }

  // The mixer's level meters: each deck before its fader on the outside, the master's left and right in the middle.
  light(m) {
    const ease = (x, v) => x + (v - x) * (v > x ? 0.5 : 0.12), sides = m ? m.master.map(toMeter) : [0, 0];
    this.levels = this.levels.map((x, i) => ease(x, m ? toMeter(m.pre[i]) : 0));
    this.meters = [this.levels[0], ease(this.meters[1], sides[0]), ease(this.meters[2], sides[1]), this.levels[1]];
  }

  // The lights that keep time: one per deck on the beat, and the row between them showing how far apart the two decks' beats are.
  readBeats(controllers) {
    const beats = controllers.map((c) => c.beat());
    this.beats = [0, 1].map((i) => ({ known: !!beats[i], flash: beats[i] && controllers[i].deck.motor ? Math.max(0, 1 - beats[i].phase * 6) : 0 }));
    this.phase = beats[0] && beats[1] && controllers[0].deck.motor && controllers[1].deck.motor ? beats[1].phase - beats[0].phase - Math.round(beats[1].phase - beats[0].phase) : null;
  }

  // What deck `i` needs to look through the shared camera at its half of the booth.
  view(i) {
    const x = -ORIGIN[i];
    return { x, az: this.az, el: this.el, pull: this.pull, shift: [(i ? -1 : 1) - this.seam, this.shiftY], home: homeFor(i), pool: [x, 0, POOL_END, POOL_FULL],
      meters: this.meters, beats: this.beats, phase: this.phase, limiting: this.limiting };
  }
  orbit(dx, dy) { this.az = clamp(this.az - dx * 0.006, -AZ_MAX, AZ_MAX); this.el = clamp(this.el + dy * 0.006, EL_MIN, EL_MAX); this.resetting = false; }
  reset() { if (this.on) this.resetting = true; }

  // ---------- hands on the mixer ----------
  // The control under a pointer, if any, with where the pointer is at that control's height ({ c, x, y } in booth coordinates).
  // Each part is tested at its own height: a knob's top and the plate differ by more than the knob is wide to the eye. A fader's cap stands up; its slot is flush with the plate.
  // From a low camera two can be under the same point (a fader cap and the cue button behind it): the taller one is in front.
  hit(e, renderer, index) {
    const reach = e.pointerType === 'touch' ? 0.009 : 0, picks = new Map();
    const at = (z) => {
      if (!picks.has(z)) { const p = renderer.pick(e.clientX, e.clientY, z); picks.set(z, p && [p[0] + ORIGIN[index], p[1]]); }
      return picks.get(z);
    };
    let found = null;
    const take = (c, z, inside, q) => { if (inside && (!found || z > found.z)) found = { c, x: q[0], y: q[1], z }; };
    for (const c of CONTROLS) {
      const p = at(c.z); if (!p) continue;
      if (c.kind === 'knob') take(c, c.z, Math.hypot(p[0] - c.x, p[1] - c.y) < 0.015 + reach, p);
      else if (c.kind === 'button') take(c, c.z, Math.max(Math.abs(p[0] - c.x), Math.abs(p[1] - c.y)) < 0.0125 + reach, p);
      else {
        const fader = c.kind === 'fader', lo = fader ? c.y0 : c.x0, hi = fader ? c.y1 : c.x1, slot = at(FACE);
        const along = (q) => (fader ? q[1] : q[0]), across = (q) => (fader ? Math.abs(q[0] - c.x) : Math.abs(q[1] - c.y));
        take(c, c.z, across(p) < 0.0105 + reach && Math.abs(along(p) - lerp(lo, hi, c.t)) < 0.0075 + reach, p);
        if (slot) take(c, FACE, across(slot) < 0.015 + reach && along(slot) > lo - 0.012 && along(slot) < hi + 0.012, slot);
      }
    }
    return found;
  }
  cursor(e, renderer, index) { const h = this.hit(e, renderer, index); return h ? (h.c.el?.disabled ? 'not-allowed' : 'pointer') : null; }
  down(e, renderer, index) {
    if (!this.on || e.button !== 0) return false;
    const h = this.hit(e, renderer, index);
    if (!h) return false;
    const { c } = h;
    if (c.el.disabled) return true;
    if (c.kind === 'button') { c.el.checked = !c.el.checked; c.el.dispatchEvent(new Event('input', { bubbles: true })); return true; }
    const now = performance.now();
    if (this.lastPress?.c === c && now - this.lastPress.t < DOUBLE_MS) { this.lastPress = null; c.el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; }
    this.lastPress = { c, t: now };
    // A drag is read at the cap's height. Held by the cap, the cap keeps its place under the finger; touched on the slot, the cap jumps to where the slot was touched.
    let off = 0;
    const p = c.kind === 'knob' ? null : renderer.pick(e.clientX, e.clientY, c.z);
    if (p) {
      const fader = c.kind === 'fader', at = fader ? p[1] : p[0] + ORIGIN[index];
      off = (h.z === c.z ? (fader ? lerp(c.y0, c.y1, c.t) : lerp(c.x0, c.x1, c.t)) : fader ? h.y : h.x) - at;
    }
    this.grabs.set(e.pointerId, { c, renderer, index, x: e.clientX, y: e.clientY, v0: +c.el.value, off });
    if (c.kind !== 'knob') this.move(e);
    return true;
  }
  move(e) {
    const g = this.grabs.get(e.pointerId);
    if (!g) return false;
    if (!this.on) { this.grabs.delete(e.pointerId); return true; }
    const { c } = g, el = c.el, lo = +el.min, hi = +el.max;
    let v;
    if (c.kind === 'knob') v = g.v0 + (hi - lo) * ((e.clientX - g.x) - (e.clientY - g.y)) / KNOB_PX;
    else {
      const p = g.renderer.pick(e.clientX, e.clientY, c.z);
      if (!p) return true;
      v = lo + (hi - lo) * (c.kind === 'fader' ? (p[1] + g.off - c.y0) / (c.y1 - c.y0) : (p[0] + ORIGIN[g.index] + g.off - c.x0) / (c.x1 - c.x0));
    }
    el.value = clamp(v, lo, hi);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  up(e) { return this.grabs.delete(e.pointerId); }
}
