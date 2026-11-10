// AudioWorklet wrapper around the physics engine.
import { Engine } from './engine.js';
import { TAU } from './dsp.js';
import { alphaForRadius, stylusXY, TAB_PER_REV, GROOVE_W } from './geometry.js';

// A tiny synthetic disc (coarse sampling, 16 revolutions, last one a locked circle) for the warm-up.
function warmupRecord() {
  const fs = 8000, spr = fs * 1.8, K = 16 * TAB_PER_REV + 1, rTab = new Float64Array(K);
  for (let k = 0; k < K; k++) rTab[k] = 0.146 - Math.min(k / TAB_PER_REV, 14.5) * 0.0003;
  const thetaEnd = (K - 1) * TAU / TAB_PER_REV, n = Math.ceil(thetaEnd * spr / TAU);
  const wallIn = new Float32Array(n), wallOut = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = 4e-6 * Math.sin(i * 0.07) + 1e-6 * Math.sin(i * 1.3);
    wallIn[i] = v + (i % 977 === 0 ? 8e-6 : 0); wallOut[i] = -0.8 * v;
  }
  return { fs, spr, n, wallIn, wallOut, rTab, thetaEnd, thetaLock: thetaEnd - TAU, W: GROOVE_W, Vfs: 0.3, ecc: [1e-4, 0], warp: [{ k: 1, amp: 2e-4, ph: 0 }], tracks: [] };
}

// Exercise every code path once, offline, so the JIT has compiled the integration loop before it
// has to run in real time (otherwise the first needle drop / scratch / skip glitches). Kept short:
// about 1.3 s of simulated audio.
function warmup(fs) {
  const rec = warmupRecord(), e = new Engine(fs), a = new Float32Array(128), b = new Float32Array(128);
  const run = (secs) => { for (let i = 0; i < secs * fs / 128; i++) e.process(a, b, 128); };
  const drop = (r) => { e.al = alphaForRadius(r); e.zb = 0.3e-3; e.zcue = 0.3e-3; e.cueUp = false; e.hOn = false; e.auto = 0; };
  e.setRecord(rec); run(0.03);                                             // parked
  e.setMotor(true); e.wp = e.wSet; drop(0.1445); run(0.3);                 // tracking a groove
  e.platterHand(true); for (let i = 0; i < 24; i++) { e.platterMove(i < 12 ? -0.05 : 0.05); run(0.005); } e.platterHand(false);   // scratch
  e.bump(4); run(0.12);                                                    // knock: skips grooves
  e.jump(30); run(0.03); e.setLoop(40, 40.3); e.jump(40); run(0.2); e.setLoop();   // a hot cue, and a loop
  e.hand(true, e.al + 0.03); run(0.08); e.hand(false); run(0.1);           // hand on the headshell
  e.cueTo(e.al - 0.01); run(0.08);                                         // auto-cue
  const rl = rec.rTab[rec.rTab.length - 1], [sx, sy] = stylusXY(alphaForRadius(rl));
  drop(rl); e.thp = rec.thetaEnd - 0.5 - Math.atan2(sy, sx); run(0.22);    // run-out groove wrapping
  drop(0.1495); run(0.08);                                                 // bare land outside the lead-in
  e.setVtf(0.3); e.setStylus('conical'); drop(0.143); run(0.15);           // other tip, mistracking
  e.setMotor(false); e.setCue(true); run(0.05);
}

let warm = false;     // the second deck runs on the same audio thread, with the code already compiled: warming up again would stall the first deck's sound

class Turntable extends AudioWorkletProcessor {
  constructor() {
    super();
    if (!warm) { warm = true; try { warmup(sampleRate); } catch (err) { this.port.postMessage({ t: 'log', msg: 'warmup failed: ' + err }); } }
    this.e = new Engine(sampleRate);
    this.count = 0; this.view = false; this.tick = 0; this.busy = 0; this.frames = 0;
    this.now = globalThis.performance && performance.now ? () => performance.now() : () => Date.now();
    this.scratch = new Float32Array(128);
    this.port.onmessage = (ev) => this.onMsg(ev.data);
    this.port.postMessage({ t: 'ready', os: this.e.OS, fs: sampleRate });
  }
  onMsg(m) {
    const e = this.e;
    switch (m.t) {
      case 'record': e.setRecord(m.rec); this.recSeq = m.seq; break;   // echoed in telemetry (main.js drawStats)
      case 'set': e.set(m); break;
      case 'motor': e.setMotor(m.on); break;
      case 'speed': e.setSpeed(m.rpm); break;
      case 'cue': e.setCue(m.up); break;
      case 'hand': e.hand(m.on, m.al); break;
      case 'cueTo': e.cueTo(m.al); break;
      case 'platter': e.platterHand(m.on); break;
      case 'platterMove': e.platterMove(m.d); break;
      case 'bump': e.bump(m.s); break;
      case 'jump': e.jump(m.theta, m.stop); break;
      case 'loop': e.setLoop(m.a, m.b); break;
      case 'view': this.view = m.on; break;
      case 'end': this.ended = true; break;
    }
  }
  process(inputs, outputs) {
    if (this.ended) return false;
    const out = outputs[0], L = out[0], R = out[1] || this.scratch;
    const t0 = this.now();
    this.e.process(L, R, L.length);
    this.busy += this.now() - t0; this.frames += L.length;
    this.count += L.length;
    if (this.count >= 768) {
      this.count = 0;
      const tel = this.e.telemetry();
      tel.t = 'tel'; tel.recSeq = this.recSeq;
      if (this.frames >= sampleRate / 2) { this.load = this.busy / 1000 / (this.frames / sampleRate); this.busy = 0; this.frames = 0; }
      tel.load = this.load;
      if (this.view && (this.tick++ & 1)) tel.view = this.e.grooveView();
      this.port.postMessage(tel);
    }
    return true;
  }
}
registerProcessor('turntable', Turntable);
