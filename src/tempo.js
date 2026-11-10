// The tempo of each track on a record, measured from the groove itself: where the walls start moving harder, in the bass and above it, compared with itself a beat later.
import { TAU } from './dsp.js';

const HOP = 128, SPAN_S = 60, MIN_BPM = 70, MAX_BPM = 180, USUAL_BPM = 118, MIN_CLEAR = 3, REFINE = [2, 4, 8, 16];   // cut samples per point of the curve; how much of a track is looked at; the range; where a tempo is most likely; how far the best tempo must stand out from the others to name one
const BASS_HZ = 180, TREBLE_WEIGHT = 0.6;     // the kick drum carries the beat, so the bass counts for more

// How much energy each band has at each point: the bass (kept apart so a kick is not lost under cymbals and surface noise) and everything above it.
function bands(rec, i0, count) {
  const { wallIn: a, wallOut: b, fs } = rec, k = 1 - Math.exp(-TAU * BASS_HZ / fs), low = new Float32Array(count), high = new Float32Array(count);
  let la = 0, lb = 0, pa = a[i0], pb = b[i0];
  for (let n = 0; n < count; n++) {
    let eL = 0, eH = 0;
    for (let i = i0 + n * HOP, end = i + HOP; i < end; i++) {
      const da = a[i] - pa, db = b[i] - pb;
      pa = a[i]; pb = b[i]; la += (da - la) * k; lb += (db - lb) * k;
      eL += la * la + lb * lb; eH += (da - la) * (da - la) + (db - lb) * (db - lb);
    }
    low[n] = eL; high[n] = eH;
  }
  return [low, high];
}
// Goes up where something starts, by how many times louder it just got, then is scaled so that a quiet band counts as much as a loud one.
function rises(e) {
  const n = e.length, raw = new Float32Array(n), out = new Float32Array(n);
  let mean = 0;
  for (let k = 0; k < n; k++) mean += e[k] / n;
  const floor = mean * 0.02 + 1e-30;
  let last = Math.log(e[0] + floor);
  for (let k = 1; k < n; k++) { const l = Math.log(e[k] + floor); raw[k] = Math.max(0, l - last); last = l; }
  let sum = 0, power = 0;
  for (let k = 2; k < n - 2; k++) { out[k] = (raw[k - 2] + 2 * raw[k - 1] + 3 * raw[k] + 2 * raw[k + 1] + raw[k + 2]) / 9; sum += out[k]; }
  sum /= n;
  for (let k = 0; k < n; k++) { out[k] -= sum; power += out[k] * out[k]; }
  power = Math.sqrt(power / n) || 1;
  for (let k = 0; k < n; k++) out[k] /= power;
  return out;
}
function onsets(rec, i0, count) {
  const [low, high] = bands(rec, i0, count).map(rises);
  for (let k = 0; k < count; k++) low[k] += TREBLE_WEIGHT * high[k];
  return low;
}

function correlate(x, lag) { let sum = 0; for (let k = lag; k < x.length; k++) sum += x[k] * x[k - lag]; return sum / (x.length - lag); }

// The peak of a curve from the points either side of its top: how far off the top sample the real top is.
const parabola = (a, b, c) => { const top = a - 2 * b + c; return top < 0 ? 0.5 * (a - c) / top : 0; };

// { bpm: beats per minute at the cutting speed, beat0: the groove angle of one beat }, or null when no steady beat stands out
function tempoOf(rec, track) {
  const { fs, spr, n } = rec, first = Math.round(track.theta0 * spr / TAU), last = Math.min(n - 1, Math.round(track.theta1 * spr / TAU));
  const span = Math.min(last - first, Math.round(SPAN_S * fs)), rate = fs / HOP;   // the middle of the track, past any intro
  if (span < 8 * fs) return null;
  const start = first + ((last - first - span) >> 1), x = onsets(rec, start, Math.floor(span / HOP) - 1), power = correlate(x, 0);
  if (!(power > 0)) return null;
  const lagMin = Math.floor(rate * 60 / MAX_BPM), lagMax = Math.ceil(rate * 60 / MIN_BPM), scores = new Float32Array(lagMax + 3), memo = new Map();
  const at = (lag) => { let v = memo.get(lag); if (v === undefined) memo.set(lag, v = correlate(x, lag) / power); return v; };
  for (let lag = lagMin - 1; lag <= lagMax + 1; lag++) scores[lag] = at(lag) + 0.5 * at(2 * lag) + 0.25 * at(4 * lag);   // a real beat also shows up two and four beats later
  let best = lagMin, top = -Infinity, mean = 0, spread = 0;
  const lags = lagMax - lagMin + 1;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const likely = scores[lag] * Math.exp(-0.5 * (Math.log2(60 * rate / lag / USUAL_BPM) / 0.8) ** 2);   // the same beat at half or double speed scores as well: take the likelier one
    if (likely > top) { top = likely; best = lag; }
    mean += scores[lag] / lags;
  }
  for (let lag = lagMin; lag <= lagMax; lag++) spread += (scores[lag] - mean) ** 2 / lags;
  if (scores[best] - mean < MIN_CLEAR * Math.sqrt(spread)) return null;   // nothing stands out: rubato piano, a test tone
  let lag = best + parabola(scores[best - 1], scores[best], scores[best + 1]);
  for (const m of REFINE) {                   // a small error in the length of a beat has grown enough to measure many beats later
    const near = Math.round(lag * m);
    if (near + 2 >= x.length / 2) break;
    let top = near;
    for (let l = near - 1; l <= near + 1; l++) if (at(l) > at(top)) top = l;
    lag = (top + parabola(at(top - 1), at(top), at(top + 1))) / m;
  }
  let offset = 0, most = -Infinity;           // where the beats fall: the comb of beats that sits on the most onsets
  for (let o = 0; o < lag; o++) {
    let sum = 0;
    for (let k = o; k < x.length - 1; k += lag) sum += x[Math.round(k)];
    if (sum > most) { most = sum; offset = o; }
  }
  return { bpm: 60 * rate / lag, beat0: (start + offset * HOP) * TAU / spr };
}

// Gives every track on the record its bpm and beat0 (both null when no steady beat stands out).
export function findTempo(rec) { for (const t of rec.tracks) Object.assign(t, tempoOf(rec, t) ?? { bpm: null, beat0: null }); }
