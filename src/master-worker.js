// Off-main-thread mastering: audio -> lathe -> pressing plant -> record geometry.
import { cut } from './cut.js';
import { press, makeVis, DEFAULT_CONDITION } from './press.js';
import { demoTracks } from './demo.js';

let source = null;   // { tracks, fs } kept so the same master can be re-pressed in another condition

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.t === 'demo') { self.postMessage({ t: 'status', id: m.id, msg: 'Synthesising the demo EP' }); source = { tracks: demoTracks(m.fs), fs: m.fs, opts: { maxExtra: 150e-6 } }; }
    else if (m.t === 'tracks') source = { tracks: m.tracks, fs: m.fs, opts: m.opts || {} };
    if (!source) return;
    self.postMessage({ t: 'status', id: m.id, msg: 'Cutting the lacquer' });
    const rec = cut(source.tracks, source.fs, source.opts);
    self.postMessage({ t: 'status', id: m.id, msg: 'Pressing' });
    press(rec, { ...DEFAULT_CONDITION, ...(m.cond || {}) }, m.seed || 7);
    const vis = makeVis(rec);
    self.postMessage({ t: 'done', id: m.id, rec, vis }, [rec.wallIn.buffer, rec.wallOut.buffer, vis.data.buffer]);
  } catch (err) { self.postMessage({ t: 'error', id: m.id, msg: String(err && err.stack || err) }); }
};
