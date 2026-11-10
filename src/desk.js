// The mixer's audio, between the decks' cartridges and the speakers: two channels, a crossfader, a headphone cue, an echo and a limiter.
// Runs inside an AudioWorklet (and in node for tests). Every control is smoothed here, on the audio thread, so moving one never clicks.
const TAU = 2 * Math.PI;
const XOVER = [250, 2500];                   // Hz: where Low hands over to Mid, and Mid to High
const KILL_DB = 40, BOOST_DB = 6, TRIM_DB = 12;
const FILTER_LOW = 200, FILTER_TOP = 20000, FILTER_FLOOR = 20, FILTER_HIGH = 8000, FILTER_Q = 1, FILTER_DEAD = 0.02, FILTER_FADE = 0.05;   // Hz; how far from centre the knob does nothing, and how far on the filter is fully in
const CUT_TRAVEL = 0.04;                     // how much of the crossfader's travel the scratch curve cuts over
const CEILING = 0.966, LOOKAHEAD = 0.0015, RELEASE = 0.1;   // -0.3 dBFS; seconds
const SMOOTH = 0.005, CHUNK = 32;            // s; how many samples a filter's tuning is held for
const ECHO_MAX = 2, ECHO_FEEDBACK = 0.5, ECHO_LOW = 300, ECHO_HIGH = 4000, ECHO_GLIDE = 0.05;   // s; Hz in the feedback path; s

const fromDb = (db) => 10 ** (db / 20);
export const faderGain = (v) => v * v;
export const trimGain = (v) => fromDb(v * TRIM_DB);
export const bandGain = (v) => (v <= -1 ? 0 : fromDb(v * (v < 0 ? KILL_DB : BOOST_DB)));   // all the way down is silence: that is what makes it a kill
// Blend keeps the sum of the two powers constant, so a mix does not dip in the middle. Cut leaves both decks up until the last sliver of travel, for scratching.
export function crossGains(x, cut) {
  if (cut) return [x >= 1 - CUT_TRAVEL ? (1 - x) / CUT_TRAVEL : 1, x <= CUT_TRAVEL ? x / CUT_TRAVEL : 1];
  const a = x * Math.PI / 2;
  return [Math.cos(a), Math.sin(a)];
}

// Second-order sections, as [b0, b1, b2, a1, a2]. Two Butterworths in a row make a Linkwitz-Riley crossover, whose two halves add back up to flat.
function section(type, f, fs) {
  const w = TAU * f / fs, c = Math.cos(w), a = Math.sin(w) * Math.SQRT1_2, n = 1 + a;
  return { lp: [(1 - c) / 2, 1 - c, (1 - c) / 2], hp: [(1 + c) / 2, -(1 + c), (1 + c) / 2], ap: [1 - a, -2 * c, 1 + a] }[type].map((b) => b / n).concat(-2 * c / n, (1 - a) / n);
}
const run = (c, z, i, x) => { const y = c[0] * x + z[i]; z[i] = c[1] * x - c[3] * y + z[i + 1]; z[i + 1] = c[2] * x - c[4] * y; return y; };
const flush = (z) => { for (let i = 0; i < z.length; i++) if (Math.abs(z[i]) < 1e-30) z[i] = 0; };   // numbers this small are very slow to work with, and nobody can hear them

class Channel {
  constructor(fs) {
    this.fs = fs; this.k = 1 - Math.exp(-1 / (SMOOTH * fs)); this.kc = 1 - Math.exp(-CHUNK / (SMOOTH * 4 * fs));
    [this.lp1, this.hp1, this.lp2, this.hp2, this.ap2] = [['lp', 0], ['hp', 0], ['lp', 1], ['hp', 1], ['ap', 1]].map(([t, i]) => section(t, XOVER[i], fs));
    this.z = new Float64Array(2 * 2 * 9);    // two sides, nine sections, two values each
    this.svf = new Float64Array(4); this.a1 = 1; this.a2 = 0; this.a3 = 0; this.high = false; this.f = 0;
    this.T = { trim: 1, low: 1, mid: 1, high: 1, filter: 0, gain: 1, pfl: 0, send: 0 };
    this.v = { trim: 1, low: 1, mid: 1, high: 1, wet: 0, gain: 1, pfl: 0, send: 0 };
    this.pre = 0; this.post = 0;
  }
  // The tuning of the sweeping filter, from where its knob is by now.
  tune() {
    this.f += (this.T.filter - this.f) * this.kc;
    const a = Math.abs(this.f);
    this.wetT = a <= FILTER_DEAD ? 0 : Math.min(1, (a - FILTER_DEAD) / FILTER_FADE);
    this.high = this.f > 0;
    const fc = this.high ? FILTER_FLOOR * (FILTER_HIGH / FILTER_FLOOR) ** a : FILTER_TOP * (FILTER_LOW / FILTER_TOP) ** a;
    const g = Math.tan(Math.PI * Math.min(fc, 0.45 * this.fs) / this.fs), k = 1 / FILTER_Q;
    this.a1 = 1 / (1 + g * (g + k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  }
  // The channel, added on to the buses it feeds: bus (after the faders), cue (before them), fx (the echo's send).
  process(L, R, n, bus, cue, fx) {
    const { lp1, hp1, lp2, hp2, ap2, z, svf, k: sm, T, v } = this, kF = 1 / FILTER_Q;
    let { trim, low, mid, high, wet, gain, pfl, send } = v, pre = this.pre, post = this.post;
    for (let o = 0; o < n; o += CHUNK) {
      this.tune();
      const { a1, a2, a3 } = this, hp = this.high, wetT = this.wetT, end = Math.min(n, o + CHUNK);
      for (let i = o; i < end; i++) {
        trim += (T.trim - trim) * sm; low += (T.low - low) * sm; mid += (T.mid - mid) * sm; high += (T.high - high) * sm;
        wet += (wetT - wet) * sm; gain += (T.gain - gain) * sm; pfl += (T.pfl - pfl) * sm; send += (T.send - send) * sm;
        let peak = 0, peakOut = 0;
        for (let c = 0; c < 2; c++) {
          const x = trim * ((c ? R : L)?.[i] ?? 0), at = c * 18;
          const lo = run(ap2, z, at + 4, run(lp1, z, at + 2, run(lp1, z, at, x)));
          const rest = run(hp1, z, at + 8, run(hp1, z, at + 6, x));
          const m = run(lp2, z, at + 12, run(lp2, z, at + 10, rest)), h = run(hp2, z, at + 16, run(hp2, z, at + 14, rest));
          let y = lo * low + m * mid + h * high;
          if (wet > 1e-5) {                  // a state-variable filter stays well behaved while it is being swept
            const s = c * 2, v3 = y - svf[s + 1], v1 = a1 * svf[s] + a2 * v3, v2 = svf[s + 1] + a2 * svf[s] + a3 * v3;
            svf[s] = 2 * v1 - svf[s]; svf[s + 1] = 2 * v2 - svf[s + 1];
            y += ((hp ? y - kF * v1 - v2 : v2) - y) * wet;
          }
          const out = y * gain;
          bus[c][i] += out; cue[c][i] += y * pfl; fx[c][i] += out * send;
          peak = Math.max(peak, Math.abs(y)); peakOut = Math.max(peakOut, Math.abs(out));
        }
        if (peak > pre) pre = peak;
        if (peakOut > post) post = peakOut;
      }
    }
    Object.assign(v, { trim, low, mid, high, wet, gain, pfl, send });
    this.pre = pre; this.post = post;
    flush(z); flush(svf);
  }
}

// Holds the peaks under the ceiling by looking a moment ahead: the level is already down when a peak arrives, so nothing is clipped.
// Below the ceiling the gain is exactly 1, and the sound only comes out a moment late.
export class Limiter {
  constructor(fs) {
    const N = this.N = Math.max(1, Math.round(LOOKAHEAD * fs));
    this.dl = [new Float64Array(N), new Float64Array(N)]; this.need = new Float64Array(N + 1).fill(1); this.box = new Float64Array(N).fill(1);
    this.i = 0; this.j = 0; this.env = 1; this.rel = 1 - Math.exp(-1 / (RELEASE * fs)); this.least = 1;
  }
  process(L, R, n) {
    const { N, dl: [dL, dR], need, box, rel } = this;
    let { i, j, env } = this, sum = 0, least = this.least;
    for (let k = 0; k < N; k++) sum += box[k];   // added up afresh each block, so rounding cannot build up
    for (let s = 0; s < n; s++) {
      const peak = Math.max(Math.abs(L[s]), Math.abs(R[s]));
      need[j] = peak > CEILING ? CEILING / peak : 1;
      j = j === N ? 0 : j + 1;
      let m = 1;
      for (let k = 0; k <= N; k++) if (need[k] < m) m = need[k];
      env = m < env ? m : env + (m - env) * rel;
      sum += env - box[i]; box[i] = env;
      const g = sum / N, l = dL[i], r = dR[i];
      dL[i] = L[s]; dR[i] = R[s];
      L[s] = l * g; R[s] = r * g;
      if (g < least) least = g;
      i = i === N - 1 ? 0 : i + 1;
    }
    this.i = i; this.j = j; this.env = env; this.least = least;
  }
}

// A tape echo: each repeat goes to the other side, and comes back a little duller and thinner, as a tape loop does.
class Echo {
  constructor(fs) {
    this.fs = fs; this.size = Math.ceil(ECHO_MAX * fs) + 2; this.w = 0;
    this.lines = [new Float32Array(this.size), new Float32Array(this.size)];
    this.time = this.timeT = 0.375 * fs; this.glide = 1 - Math.exp(-1 / (ECHO_GLIDE * fs));
    this.kLo = 1 - Math.exp(-TAU * ECHO_LOW / fs); this.kHi = 1 - Math.exp(-TAU * ECHO_HIGH / fs);
    this.lo = [0, 0]; this.hi = [0, 0];
  }
  setTime(seconds) { this.timeT = Math.max(0.02, Math.min(ECHO_MAX, seconds)) * this.fs; }
  read(line, d) {
    const p = this.w - d + this.size, i = Math.floor(p), f = p - i, a = line[i % this.size], b = line[(i + 1) % this.size];
    return a + (b - a) * f;
  }
  process(fx, bus, n) {
    const [lineL, lineR] = this.lines, { lo, hi, kLo, kHi, glide } = this;
    for (let i = 0; i < n; i++) {
      this.time += (this.timeT - this.time) * glide;
      const dl = this.read(lineL, this.time), dr = this.read(lineR, this.time);
      bus[0][i] += dl; bus[1][i] += dr;
      const shape = (x, c) => { hi[c] += (x - hi[c]) * kHi; lo[c] += (hi[c] - lo[c]) * kLo; return hi[c] - lo[c]; };
      lineL[this.w] = (fx[0][i] + fx[1][i]) * 0.5 + ECHO_FEEDBACK * shape(dr, 0);
      lineR[this.w] = ECHO_FEEDBACK * shape(dl, 1);
      this.w = this.w + 1 === this.size ? 0 : this.w + 1;
    }
    flush(lo); flush(hi);
  }
}

export class Desk {
  constructor(fs) {
    this.ch = [new Channel(fs), new Channel(fs)]; this.echo = new Echo(fs);
    this.limit = new Limiter(fs); this.limitCue = new Limiter(fs);
    this.k = 1 - Math.exp(-1 / (SMOOTH * fs));
    this.T = { master: 1, cueMix: 0, split: 0 }; this.v = { master: 1, cueMix: 0, split: 0 };
    this.size = 0; this.peak = [0, 0];
  }
  // { ch, key, value } for a channel's control, { key, value } for one of the master section's
  set({ ch, key, value }) {
    if (ch != null) this.ch[ch].T[key] = value;
    else if (key === 'echoTime') this.echo.setTime(value);
    else this.T[key] = value;
    if (key === 'pfl') this.T.split = this.ch.some((c) => c.T.pfl) ? 1 : 0;   // one pair of outputs: while a channel is cued, the left ear is the headphones and the right ear the room
  }
  buffers(n) {
    if (n <= this.size) return;
    const pair = () => [new Float32Array(n), new Float32Array(n)];
    this.size = n; this.bus = pair(); this.cue = pair(); this.fx = pair();
  }
  // inA, inB: each deck's channels (empty when nothing is connected). rec, if given, gets the mix alone: the cue never goes on a recording.
  process(inA, inB, out, rec) {
    const n = out[0].length, [oL, oR = oL] = out;
    this.buffers(n);
    const { bus, cue, fx, T, v, k } = this;
    for (const b of [bus, cue, fx]) { b[0].fill(0, 0, n); b[1].fill(0, 0, n); }
    this.ch[0].process(inA[0], inA[1] ?? inA[0], n, bus, cue, fx);
    this.ch[1].process(inB[0], inB[1] ?? inB[0], n, bus, cue, fx);
    this.echo.process(fx, bus, n);
    let { master, cueMix, split } = v;
    for (let i = 0; i < n; i++) { master += (T.master - master) * k; bus[0][i] *= master; bus[1][i] *= master; }
    v.master = master;
    this.limit.process(bus[0], bus[1], n);
    this.limitCue.process(cue[0], cue[1], n);
    let [pL, pR] = this.peak;
    for (let i = 0; i < n; i++) {
      cueMix += (T.cueMix - cueMix) * k; split += (T.split - split) * k;
      const L = bus[0][i], R = bus[1][i], mono = (L + R) / 2, heard = (cue[0][i] + cue[1][i]) / 2 * (1 - cueMix) + mono * cueMix;
      oL[i] = L + (heard - L) * split; oR[i] = R + (mono - R) * split;
      if (rec) { rec[0][i] = L; if (rec[1]) rec[1][i] = R; }
      pL = Math.max(pL, Math.abs(L)); pR = Math.max(pR, Math.abs(R));
    }
    v.cueMix = cueMix; v.split = split; this.peak = [pL, pR];
  }
  // How loud everything has been since the last time this was asked.
  meters() {
    const [a, b] = this.ch, out = { pre: [a.pre, b.pre], post: [a.post, b.post], master: this.peak, reduced: 1 - this.limit.least };
    a.pre = a.post = b.pre = b.post = 0; this.peak = [0, 0]; this.limit.least = 1;
    return out;
  }
}
