// Offline checks of the mixer's audio: tone controls, filter, crossfader, cue, echo and limiter. Run silently: nothing here reaches a speaker.
import { Desk, Limiter, bandGain, crossGains, faderGain, trimGain } from '../src/desk.js';
import { dB, tone, rms } from './lib.mjs';

const fs = 48000, TAU = 2 * Math.PI, BLOCK = 128;
let failed = 0;
const check = (name, ok, detail = '') => { console.log((ok ? 'ok   ' : 'FAIL ') + name.padEnd(46) + detail); if (!ok) failed++; };
const sine = (f, a = 0.5) => (i) => a * Math.sin(TAU * f * i / fs), silence = () => 0;

// Runs the desk for `seconds`, feeding each deck from a function of the sample number, and returns the last half second of each output.
function render(setup, [genA, genB], seconds = 1) {
  const d = new Desk(fs); setup(d);
  const total = Math.round(seconds * fs), keep = Math.min(total, fs / 2);
  const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)], rec = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const A = [new Float32Array(BLOCK), new Float32Array(BLOCK)], B = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const L = new Float32Array(keep), R = new Float32Array(keep), recL = new Float32Array(keep);
  for (let o = 0; o < total; o += BLOCK) {
    for (let i = 0; i < BLOCK; i++) { A[0][i] = A[1][i] = genA(o + i); B[0][i] = B[1][i] = genB(o + i); }
    d.process(A, B, out, rec);
    const at = o - (total - keep);
    for (let i = 0; i < BLOCK; i++) if (at + i >= 0 && at + i < keep) { L[at + i] = out[0][i]; R[at + i] = out[1][i]; recL[at + i] = rec[0][i]; }
  }
  return { L, R, recL, d };
}
const channel = (d, ch, o) => { for (const [key, value] of Object.entries(o)) d.set({ ch, key, value }); };
const only = (o = {}) => (d) => { channel(d, 1, { gain: 0 }); channel(d, 0, o); };
const level = (x, f) => dB(tone(x, f, fs));
const peak = (x) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

const near = (a, b, tol) => Math.abs(a - b) <= tol;
for (const f of [40, 120, 250, 700, 1000, 2500, 6000, 12000]) {
  const { L } = render(only(), [sine(f), silence]);
  check(`flat through the strip at ${f} Hz`, near(level(L, f), dB(0.5), 0.05), `${(level(L, f) - dB(0.5)).toFixed(3)} dB`);
}
const kills = [['low', 60], ['mid', 800], ['high', 10000]];
for (const [key, f] of kills) {
  const { L } = render(only({ [key]: bandGain(-1) }), [sine(f), silence]);
  check(`${key} kill removes ${f} Hz`, level(L, f) - dB(0.5) < -30, `${(level(L, f) - dB(0.5)).toFixed(1)} dB`);   // the middle of the mid band is only a little over a decade from both crossovers
}
{
  const { L } = render(only({ low: 0, mid: 0, high: 0 }), [(i) => sine(90)(i) + sine(1000)(i) + sine(9000)(i), silence]);
  check('all three killed is silence', rms(L) < 1e-6, `rms ${dB(rms(L)).toFixed(0)} dB`);
  const up = render(only({ mid: bandGain(1) }), [sine(1000), silence]).L;
  check('a band lifts 6 dB at most', near(level(up, 1000) - dB(0.5), 6, 0.5), `${(level(up, 1000) - dB(0.5)).toFixed(2)} dB`);
}
{
  const low = render(only({ filter: -1 }), [sine(5000), silence]).L, high = render(only({ filter: 1 }), [sine(100), silence]).L, pass = render(only({ filter: 1 }), [sine(15000), silence]).L;
  check('filter down: treble goes', level(low, 5000) - dB(0.5) < -30, `${(level(low, 5000) - dB(0.5)).toFixed(1)} dB`);
  check('filter up: bass goes', level(high, 100) - dB(0.5) < -30, `${(level(high, 100) - dB(0.5)).toFixed(1)} dB`);
  check('filter up: treble stays', level(pass, 15000) - dB(0.5) > -3, `${(level(pass, 15000) - dB(0.5)).toFixed(1)} dB`);
  const off = render(only({ filter: 0.01 }), [sine(5000), silence]).L;
  check('filter does nothing around its centre', near(level(off, 5000), dB(0.5), 0.05));
}
{
  const up = render(only({ trim: trimGain(0.5) }), [sine(1000, 0.1), silence]).L;
  check('trim lifts by its dB', near(level(up, 1000) - dB(0.1), 6, 0.05), `${(level(up, 1000) - dB(0.1)).toFixed(2)} dB`);
  check('fader law is squared', faderGain(0.5) === 0.25);
  const [a, b] = crossGains(0.5, false), [ca, cb] = crossGains(0, true), [da, db] = crossGains(0.5, true), [ea, eb] = crossGains(1, true);
  check('blend keeps the power in the middle', near(a * a + b * b, 1, 1e-9));
  check('cut: one deck only at each end', ca === 1 && cb === 0 && ea === 0 && eb === 1);
  check('cut: both up in the middle', da === 1 && db === 1);
}
{
  const hot = render((d) => { channel(d, 0, { gain: 1 }); channel(d, 1, { gain: 1 }); }, [sine(440, 1), sine(440, 1)]);
  check('two full decks stay under the ceiling', peak(hot.L) <= 0.9661, `peak ${dB(peak(hot.L)).toFixed(2)} dB`);
  const l = new Limiter(fs), x = Float64Array.from({ length: 4800 }, (_, i) => 0.5 * Math.sin(TAU * 997 * i / fs)), y = x.slice(), z = x.slice();
  l.process(y, z, 4800);
  let worst = 0;
  for (let i = l.N; i < 4800; i++) worst = Math.max(worst, Math.abs(y[i] - x[i - l.N]));
  check('below the ceiling the limiter does nothing', worst === 0, `worst ${worst}`);
  const spike = new Float64Array(4800); spike[2400] = 3;
  const s2 = spike.slice(); new Limiter(fs).process(spike, s2, 4800);
  check('a single spike is held down', peak(spike) <= 0.9661 && peak(spike) > 0.8, `peak ${peak(spike).toFixed(4)}`);
}
{
  const cued = render((d) => { channel(d, 0, { gain: 0, pfl: 1 }); channel(d, 1, { gain: 1 }); }, [sine(300), sine(2000)]);
  check('cue: left ear hears the cued deck', near(level(cued.L, 300), dB(0.5), 0.2) && level(cued.L, 2000) < -60, `${level(cued.L, 300).toFixed(1)} / ${level(cued.L, 2000).toFixed(1)} dB`);
  check('cue: right ear hears the mix', near(level(cued.R, 2000), dB(0.5), 0.2) && level(cued.R, 300) < -60, `${level(cued.R, 2000).toFixed(1)} / ${level(cued.R, 300).toFixed(1)} dB`);
  check('cue never goes on the recording', near(level(cued.recL, 2000), dB(0.5), 0.2) && level(cued.recL, 300) < -60);
  const blend = render((d) => { channel(d, 0, { gain: 0, pfl: 1 }); channel(d, 1, { gain: 1 }); d.set({ key: 'cueMix', value: 0.5 }); }, [sine(300), sine(2000)]).L;
  check('cue mix blends the mix into the left ear', near(level(blend, 300), dB(0.25), 0.2) && near(level(blend, 2000), dB(0.25), 0.2));
  const none = render((d) => { channel(d, 0, { gain: 1 }); channel(d, 1, { gain: 0 }); }, [sine(300), silence]);
  check('nothing cued: both sides the mix', near(level(none.L, 300), dB(0.5), 0.05) && near(level(none.R, 300), dB(0.5), 0.05));
}
{
  const burst = (i) => (i < 4800 ? sine(1000)(i) : 0);
  const on = render((d) => { only({ send: 1 })(d); d.set({ key: 'echoTime', value: 0.25 }); }, [burst, silence], 0.5).d;
  check('echo runs without blowing up', on.peak.every((v) => Number.isFinite(v)));
  const wet = render((d) => { only({ send: 1 })(d); d.set({ key: 'echoTime', value: 0.25 }); }, [burst, silence], 1);
  const dry = render(only(), [burst, silence], 1);
  check('echo repeats after the music stops', rms(wet.L) + rms(wet.R) > 1e-3 && rms(dry.L) < 1e-6, `${dB(rms(wet.L)).toFixed(1)} dB`);
  const long = render((d) => { only({ send: 1 })(d); d.set({ key: 'echoTime', value: 0.25 }); }, [burst, silence], 8);
  check('echo dies away', rms(long.L) < 0.02 * rms(wet.L) + 1e-4, `${dB(rms(long.L)).toFixed(1)} dB`);
}
{
  const { L } = render((d) => channel(d, 0, { gain: 1 }), [(i) => (Number.isNaN(i) ? 0 : 0.2 * Math.sin(TAU * 100 * i / fs)), silence], 0.3);
  check('no NaN or infinity on the way out', L.every(Number.isFinite));
  const d = new Desk(fs), out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  d.process([], [], out);
  check('runs with nothing connected', out[0].every((v) => v === 0));
}
{
  const t0 = performance.now(); render((d) => { channel(d, 0, { filter: -0.4, send: 0.3 }); channel(d, 1, { filter: 0.4, pfl: 1 }); }, [sine(440, 0.3), sine(660, 0.3)], 10);
  console.log(`cost: ${((performance.now() - t0) / 10000).toFixed(4)} of real time`);
}
if (failed) { console.error(`${failed} failed`); process.exit(1); }
