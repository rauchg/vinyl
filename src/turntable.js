// One turntable and everything that belongs to it: the picture, the physics engine on the audio thread,
// the panels and the readout. main.js puts it on the page.
import { Renderer } from './render.js';
import { TAU } from './dsp.js';
import { RECORDS } from './records.js';
import { press, makeVis } from './press.js';
import { PIVOT_X, PIVOT_Y, ALPHA_REST, R_DISC, R_LABEL, R_LEADIN, W33, alphaForRadius } from './geometry.js';

const $ = (id) => document.getElementById(id);
const AZ0 = -0.5, EL0 = 0.6;   // default camera
const POWER_MSG = matchMedia('(pointer: coarse)').matches ? 'tap to power on' : 'click to power on';
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const decodeAudio = async (url, fs) => new OfflineAudioContext(2, 1, fs).decodeAudioData(await (await fetch(url)).arrayBuffer());   // for mastering here

// ---------- precompiled record (lathe.mjs): the clean cut ships as DPCM; decode it, press it here, go ----------
// Start every download for a record at once and expose how far the big one is.
function fetchRecord(dir) {
  const h = { dir, got: 0, total: 0 };
  h.man = fetch(dir + 'record.json', { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('no precompiled record'); return r.json(); });
  h.audio = h.man.then(async (man) => {
    const r = await fetch(dir + man.walls);
    if (!r.ok) throw new Error('no precompiled record');
    h.total = +r.headers.get('content-length') || 0;
    let buf;
    if (r.body) {
      const reader = r.body.getReader(), chunks = [];
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); h.got += value.length; }
      buf = await new Blob(chunks).arrayBuffer();
    } else buf = await r.arrayBuffer();
    return new OfflineAudioContext(2, 1, man.fs).decodeAudioData(buf);
  });
  h.vis = h.man.then((man) => fetch(dir + man.vis.file).then((r) => r.arrayBuffer()));
  for (const k of ['man', 'audio', 'vis']) h[k].catch(() => {});
  return h;
}
// The opening record is already on its way: index.html starts these fetches before any module loads.
function takeBoot(dir) {
  const b = window.__boot;
  if (!b || b.dir !== dir || b.used) return null;
  b.used = true; return b;
}

// suffix: what this turntable's element ids end in. say(name, message): the status line.
// guard(name, fn): runs a part of the frame so that a failure cannot stop the loop.
export function createTurntable({ suffix = '', name = 'A', og = false, say, guard }) {
  const el = (id) => $(id + suffix), api = {};
  const canvas = el('gl'), renderer = new Renderer(canvas);
  let masterWorker = null;      // the lathe + pressing plant; only started if something has to be mastered in the browser
  const worker = { postMessage: (m, transfer) => { busy(); (masterWorker ||= startWorker()).postMessage(m, transfer || []); } };
  // The progress bar (index.html) shows window.__load: a download with got/total, or just "busy" when the size is unknown.
  const busy = (h = { got: 0, total: 0 }) => (window.__load = h);
  const idle = () => { if (window.__load) window.__load.done = true; };
  const S = { hudOn: false, lastDown: 0, tel: null, tRecv: 0, zoom: 0, zoomT: 0, az: AZ0, el: EL0, rpm: 33.3333, rec: null, pending: null, motor: false, cue: true, ready: false };
  let ctx = null, node = null, drag = null;
  let pick = 0;   // bumps each time a record is chosen, so an older, slower cut cannot land on top of a newer choice
  const send = (m, transfer) => { if (node) node.port.postMessage(m, transfer || []); };
  const status = (msg) => { S.msg = msg; say(name, msg); };   // empty when nothing is happening

  // ---------- mastering ----------
  const condition = () => Object.fromEntries(['noise', 'dust', 'scratches', 'warp', 'offCenter'].map((k) => [k, +el('c-' + k).value]));
  function startWorker() {
    const w = new Worker(new URL('./master-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = ({ data: m }) => {
      if (m.t === 'status') status(m.msg + '...');
      else if (m.t === 'error') { idle(); status('Mastering failed: ' + m.msg); console.error(m.msg); }
      else if (m.t === 'done') { if (m.id == null || m.id === pick) gotRecord(m.rec, m.vis); }
    };
    return w;
  }
  function reveal() {          // first record: fade the deck and the disc in together, a frame after it has been drawn
    if (S.shown) return;
    S.shown = true;
    requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.add('ready')));
  }
  function gotRecord(rec, vis) {
    renderer.setRecord(rec, vis);
    idle();
    reveal();
    S.pending = rec; S.pendingPick = pick;          // gotRecord only ever runs for the current pick
    status(rec.truncated ? 'Programme was too long for one side and was cut short.' : '');
    $('d-points').textContent = (rec.n / 1e6).toFixed(1) + ' million';
    loadRecord();
  }
  function loadRecord() {
    if (!S.ready || !S.pending) return;
    const rec = S.pending; S.pending = null;
    // what the track readout maps the needle onto; seq comes back in the telemetry once the audio thread has it,
    // so a packet about the previous record can't be read against this one
    S.rec = { tracks: rec.tracks, thetaLock: rec.thetaLock, pick: S.pendingPick, seq: S.recSeq = (S.recSeq || 0) + 1 };
    send({ t: 'cue', up: true });
    send({ t: 'record', rec, seq: S.rec.seq }, [rec.wallIn.buffer, rec.wallOut.buffer]);
    S.loaded = true;
    if (S.started) play(); else start();
  }
  const play = () => { setMotor(true); setTimeout(() => send({ t: 'cueTo', al: alphaForRadius(R_LEADIN - 0.0012) }), 400); };
  // Nothing moves until all three are true: the user powered on, the engine is warm, and a record is in it.
  function start() {
    if (!S.on || !S.ready || !S.loaded || S.started) return;
    S.started = true; $('power')?.remove(); play();
  }
  async function loadPrecompiled(dir = 'assets/', me = pick, pressing = null) {     // dir: assets/ (house record) or assets/<id>/ (a shelf record)
    let h = takeBoot(dir) || fetchRecord(dir), man = await h.man;
    if (man.version !== 2) throw new Error('precompiled record is in an old format');
    if (h === window.__boot && man.walls !== 'record.flac') { h = fetchRecord(dir); man = await h.man; }
    S.load = busy(h);
    const [audio, visData] = await Promise.all([h.audio, h.vis]);
    if (me !== pick) return;                      // another record was chosen meanwhile
    if (audio.length < man.n || audio.sampleRate !== man.fs) throw new Error('precompiled record does not match its manifest');
    const unpack = (q) => {                       // 16-bit DPCM of the wall slope -> wall displacement (m)
      const w = new Float32Array(man.n); let d = 0;
      for (let i = 0; i < 4096; i++) { const x = q[i] * 32768; if (Math.abs(x - Math.round(x)) > 0.01) throw new Error('this browser did not decode the record losslessly'); }
      for (let i = 0; i < man.n; i++) { d += Math.round(q[i] * 32768) * man.gain; w[i] = d; }
      return w;
    };
    const rec = { ...man.rec, rTab: Float64Array.from(man.rTab), wallIn: unpack(audio.getChannelData(0)), wallOut: unpack(audio.getChannelData(1)) };
    // the pressing plant: roughness, dust, scratches and echo are seeded, so they are made here instead of downloaded
    press(rec, pressing?.cond ?? man.press.cond, pressing?.seed ?? man.press.seed);
    S.man = man; S.manDir = dir; S.load = null;
    gotRecord(rec, pressing ? makeVis(rec) : { data: new Uint8Array(visData), cols: man.vis.cols, rows: man.vis.rows });
  }
  function houseRecord() {                        // "Demo EP" on the shelf: assets/, or synthesised and mastered here
    S.workerHasSource = false;
    return loadPrecompiled().catch((err) => {     // not built (or stale): master it here instead
      console.info((err.message || err) + '; mastering in the browser');
      S.man = null; worker.postMessage({ t: 'demo', fs: 48000, cond: condition() });
    });
  }
  // Pressing again: a precompiled record is pressed here from the same cut (re-read from the browser cache);
  // one mastered in the browser goes back to the worker, which still has the tape.
  async function pressAgain() {
    const cond = condition(), seed = 1 + Math.floor(Math.random() * 1e6);
    if (!S.man) return worker.postMessage({ t: 'press', cond, seed });
    const me = ++pick;
    try { await loadPrecompiled(S.manDir, me, { cond, seed }); }
    catch (err) { console.error(err); if (me === pick) { idle(); status('Could not press that record again.'); } }
  }

  // ---------- audio ----------
  // The engine is created (and its JIT warm-up runs) as soon as the page loads. The context just stays
  // suspended until the first click, so "power on" is normally instant.
  let audioInit = null;
  function initAudio() {
    return audioInit ||= (async () => {
      ctx = new AudioContext({ latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
      node = new AudioWorkletNode(ctx, 'turntable', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      node.port.onmessage = ({ data: m }) => {
        if (m.t === 'tel') { S.tel = m; S.tRecv = performance.now(); if (m.view) S.view = m.view; S.cue = m.cueUp; }
        else if (m.t === 'ready') {
          S.ready = true; pushParams(); send({ t: 'view', on: true }); loadRecord(); start();
          $('d-rate').textContent = (m.os * m.fs).toLocaleString('en-US');
        } else if (m.t === 'log') console.warn(m.msg);
      };
      node.connect(ctx.destination);
      if (!S.on && ctx.state === 'running') await ctx.suspend();   // some browsers start it unasked; stay silent until power-on
    })().catch((err) => { audioInit = null; ctx = null; node = null; throw err; });
  }
  async function powerOn() {
    if (S.on) return;
    S.on = true; $('power').classList.add('busy');      // a spinner until the engine is warm AND the record is in it
    powerMsg();
    try {
      if (ctx) ctx.resume().catch(() => {});            // straight away, inside the gesture: iOS only honours it there
      await initAudio();
      // If the browser did not count this event as a user gesture, resume() never settles. Do not hang on it:
      // give up after a moment and go back to waiting, so the next tap can try again.
      if (ctx.state !== 'running') await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 3000))]);
      if (ctx.state !== 'running') throw new Error('not started');
      start();
    } catch (err) {
      S.on = false; $('power')?.classList.remove('busy');
      if ($('power-msg')) $('power-msg').textContent = err.message === 'not started' ? POWER_MSG : 'audio failed: ' + err.message;
      if (err.message !== 'not started') console.error(err);
    }
  }
  // What the power button says while we wait (the progress bar itself is driven from index.html).
  function powerMsg() {
    const msg = $('power-msg');
    if (msg && S.on && !S.started) msg.textContent = (S.msg || '').replace(/\.+$/, '') || (S.loaded ? (S.ready ? 'starting' : 'warming up') : 'loading the record');
  }
  $('power').addEventListener('click', powerOn);       // the pill; a tap on the scene powers on too (see the pointer handlers)
  $('power-msg').textContent = POWER_MSG;
  if (!og) initAudio().catch(() => {});                // best effort before any gesture; the click retries if the browser refused

  // ---------- controls ----------
  function setMotor(on) { S.motor = on; send({ t: 'motor', on }); el('b-start').textContent = on ? 'Stop' : 'Start'; el('b-start').classList.toggle('on', on); }
  function pushParams() {
    // 100% on the slider is 2 dB under unity: the cartridge lifts the treble by up to 1.9 dB, and bright peaks would clip
    send({ t: 'set', volume: 0.8 * +el('p-volume').value, stylus: el('p-stylus').value, vtf: +el('p-vtf').value, antiskate: +el('p-antiskate').value, hum: +el('p-hum').value });
  }
  for (const input of el('ctl').querySelectorAll('input[type=range]')) {
    const out = input.parentElement.querySelector('output'), show = () => { out.textContent = input.id === 'p-volume' + suffix ? Math.round(input.value * 100) + '%' : (+input.value).toFixed(2); };
    input.addEventListener('input', () => { show(); if (input.id.startsWith('p-')) pushParams(); }); show();
  }
  el('p-stylus').addEventListener('change', pushParams);
  const toggle = (btn, panel, onChange) => el(btn).addEventListener('click', () => {
    const open = el(panel).hidden; el(panel).hidden = !open; el(btn).setAttribute('aria-pressed', String(open)); if (onChange) onChange(open);
  });
  toggle('t-ctl', 'ctl', (open) => { if (open && !el('shelf').hidden) el('t-records').click(); });      // one panel in that corner at a time
  toggle('t-records', 'shelf', (open) => { if (open && !el('ctl').hidden) el('t-ctl').click(); });
  el('b-start').addEventListener('click', () => setMotor(!S.motor));
  el('b-cue').addEventListener('click', () => send({ t: 'cue', up: !S.cue }));
  el('b-bump').addEventListener('click', () => send({ t: 'bump', s: 1 }));
  el('b-press').addEventListener('click', pressAgain);
  const speeds = el('ctl').querySelectorAll('[data-rpm]');
  for (const b of speeds) b.addEventListener('click', () => { speeds.forEach((x) => x.classList.toggle('on', x === b)); S.rpm = +b.dataset.rpm; send({ t: 'speed', rpm: S.rpm }); });
  async function cutFiles(files) {
    const list = [...files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|wav|flac|m4a|ogg|aiff?)$/i.test(f.name));
    if (!list.length) return;
    status('Decoding...');
    const tracks = [], transfer = [];
    for (const f of list) {
      try {
        const ab = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(await f.arrayBuffer());
        const L = ab.getChannelData(0).slice(), R = ab.numberOfChannels > 1 ? ab.getChannelData(1).slice() : L.slice();
        tracks.push({ L, R, title: f.name.replace(/\.[^.]+$/, '') }); transfer.push(L.buffer, R.buffer);
      } catch (err) { console.error(err); }
    }
    if (!tracks.length) return status('Could not decode that audio.');
    S.workerHasSource = true; S.man = null; pick++; markRecord(null);
    worker.postMessage({ t: 'tracks', tracks, fs: 48000, cond: condition() }, transfer);
  }

  // ---------- record shelf: free-to-ship recordings (src/records.js, audio in records/), precompiled into assets/<id>/ ----------
  const shelf = el('shelf'), credit = shelf.appendChild(document.createElement('p'));
  // The Records toggle shows what is on the platter: the record, or while a track plays its title and time.
  function nowPlaying(title, time = '', playing = false) {
    if (title === S.nowTitle && time === S.nowTime && playing === S.nowPlaying) return;
    S.nowTitle = title; S.nowTime = time; S.nowPlaying = playing;
    el('now-title').textContent = title; el('now-time').textContent = time;
    el('t-records').classList.toggle('playing', playing);
    el('t-records').title = `Records: ${title}${time ? ' ' + time : ''}`;
  }
  function markRecord(r) {
    S.shelf = r?.tracks ? r : null;
    S.recTitle = r ? r.title : 'Your audio'; nowPlaying(S.recTitle);
    for (const b of shelf.querySelectorAll('button')) b.setAttribute('aria-current', String(b.dataset.id === r?.id));
    credit.replaceChildren(r ? [r.credit, r.licence].filter(Boolean).join(' · ') : 'Your own audio');
    if (r?.url) credit.append(' · ', Object.assign(document.createElement('a'), { href: r.url, target: '_blank', rel: 'noopener', textContent: 'source' }));
  }

  async function pickRecord(r) {
    const me = ++pick;
    markRecord(r);
    if (!r.tracks) return houseRecord();
    S.workerHasSource = false;
    try { await loadPrecompiled(`assets/${r.id}/`, me); }
    catch (err) {                                 // not built (or stale): cut and press it here instead, which takes a while
      console.info(`${r.title}: ${err.message || err}; mastering in the browser`);
      if (me === pick) { S.man = null; master(r, me); }
    }
  }
  async function master(r, me, seed) {            // the slow way: fetch the audio, then lathe and pressing plant in the worker
    try {
      busy();
      const tracks = [], transfer = [];
      for (const k of r.tracks) {
        status(`Fetching ${k.title}...`);
        const ab = await decodeAudio(new URL('../records/' + k.file, import.meta.url), 48000);
        if (me !== pick) return;
        const L = ab.getChannelData(0).slice(), R = ab.numberOfChannels > 1 ? ab.getChannelData(1).slice() : L.slice();
        tracks.push({ L, R, title: k.title }); transfer.push(L.buffer, R.buffer);
      }
      S.workerHasSource = true;
      worker.postMessage({ t: 'tracks', id: me, tracks, fs: 48000, opts: r.cut, cond: condition(), seed }, transfer);
    } catch (err) { console.error(err); if (me === pick) { idle(); status(`Could not load ${r.title}.`); } }
  }
  for (const r of RECORDS) {
    const b = document.createElement('button');
    b.dataset.id = r.id;
    b.append(Object.assign(document.createElement('b'), { textContent: r.title }), Object.assign(document.createElement('span'), { textContent: r.by }));
    b.addEventListener('click', () => { pickRecord(r); b.blur(); });
    shelf.insertBefore(b, credit);
  }
  pickRecord(RECORDS.find((r) => r.id === (window.__boot?.id || 'rhapsody')) || RECORDS[0]);   // the record on the platter when the page opens
  el('f-audio').addEventListener('change', (e) => cutFiles(e.target.files));

  // ---------- keyboard ----------
  function onKey(e) {
    if (e.code === 'Space') { e.preventDefault(); setMotor(!S.motor); }
    else if (e.key === 'c') send({ t: 'cue', up: !S.cue });
    else if (e.key === 'b') send({ t: 'bump', s: 1 });
    else if (e.key === 'z') S.zoomT = S.zoomT > 0.5 ? 0 : 0.92;
  }

  // ---------- pointer: grab the headshell, spin the record, or click to drop the needle ----------
  const armAngle = (p) => { const a = Math.atan2(p[1] - PIVOT_Y, p[0] - PIVOT_X); return a < 0 ? a + TAU : a; };
  const curAl = () => (S.tel ? S.tel.al : ALPHA_REST);
  const touches = new Map();   // active pointers, for two-finger pinch zoom
  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (touches.size === 2) {                     // a second finger: stop what the first was doing and pinch
      if (drag) drag.tap = false;
      release();
      const [a, b] = [...touches.values()];
      drag = { type: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, z0: S.zoomT };
      return;
    }
    const pa = renderer.pick(e.clientX, e.clientY, 0.018), p = renderer.pick(e.clientX, e.clientY, 0);
    // until it is powered on the scene can only be looked around; a tap that doesn't drag powers it on
    const plain = S.started && S.ready && e.button === 0 && !e.shiftKey && !e.altKey;
    if (plain && pa && renderer.armDistance(pa, curAl()) < (e.pointerType === 'touch' ? 0.03 : 0.011)) {
      drag = { type: 'arm', off: curAl() - armAngle(pa) };
      send({ t: 'hand', on: true, al: curAl() });
    } else if (plain && p && Math.hypot(p[0], p[1]) < R_DISC) {
      drag = { type: 'platter', ang: Math.atan2(p[1], p[0]), moved: 0, t0: performance.now(), p };
      send({ t: 'platter', on: true });
    } else drag = { type: 'orbit', x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, tap: !S.on && e.button === 0 };   // anywhere else: turn the camera
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (e) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (!drag) return;
    if (drag.type === 'pinch') {
      const [a, b] = [...touches.values()];
      if (b) S.zoomT = Math.max(-0.8, Math.min(0.985, drag.z0 + 0.6 * Math.log(Math.hypot(a[0] - b[0], a[1] - b[1]) / drag.d0)));
    } else if (drag.type === 'orbit') {
      S.az -= (e.clientX - drag.x) * 0.006; S.el = Math.max(0.02, Math.min(1.55, S.el + (e.clientY - drag.y) * 0.006)); S.resetting = false;
      drag.x = e.clientX; drag.y = e.clientY;
      if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 6) drag.tap = false;
    } else if (drag.type === 'arm') {
      const pa = renderer.pick(e.clientX, e.clientY, 0.018);
      if (pa) send({ t: 'hand', on: true, al: armAngle(pa) + drag.off });
    } else {
      const p = renderer.pick(e.clientX, e.clientY, 0); if (!p) return;
      const a = Math.atan2(p[1], p[0]);
      let d = a - drag.ang; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
      drag.ang = a; drag.moved += Math.abs(d) * Math.hypot(p[0], p[1]);
      send({ t: 'platterMove', d: -d });            // platter angle is clockwise-positive
    }
  });
  const release = () => {
    if (!drag) return;
    if (drag.type === 'arm') send({ t: 'hand', on: false });
    else if (drag.type === 'orbit' && drag.tap) S.tapped = performance.now();   // powers on in the click / touchend that follows
    else if (drag.type === 'platter') {
      send({ t: 'platter', on: false });
      const r = Math.hypot(drag.p[0], drag.p[1]);
      if (drag.moved < 0.003 && performance.now() - drag.t0 < 400 && r > R_LABEL + 0.002) send({ t: 'cueTo', al: alphaForRadius(r) });
    }
    drag = null; canvas.style.cursor = 'grab';
  };
  for (const type of ['pointerup', 'pointercancel']) canvas.addEventListener(type, (e) => { touches.delete(e.pointerId); release(); });
  // A tap on the scene powers on. It has to happen in `touchend` or `click`: iOS Safari does not accept
  // `pointerup` as a gesture that may start audio, and the context would stay suspended forever.
  for (const type of ['touchend', 'click']) canvas.addEventListener(type, () => {
    if (!S.on && S.tapped && performance.now() - S.tapped < 800 && document.documentElement.classList.contains('ready')) { S.tapped = 0; powerOn(); }
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); S.zoomT = Math.max(-0.8, Math.min(0.985, S.zoomT - e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))); }, { passive: false });

  // ---------- HUD ----------
  const scope = el('scope'), sc = scope.getContext('2d');
  function drawScope() {
    const w = scope.width, h = scope.height, v = S.view, rows = 5, cols = 160, k = (h / 2) / 95e-6;
    sc.fillStyle = '#1c1c20'; sc.fillRect(0, 0, w, h);
    if (!v) return;
    const X = (c) => c / (cols - 1) * w, Y = (m) => h / 2 - m * k;
    const fill = new Path2D(), edge = new Path2D();
    for (let g = 0; g < rows; g++) {
      for (let c = 0; c + 1 < cols; c++) {
        const o = (g * cols + c) * 2, a0 = v[o], b0 = v[o + 1], a1 = v[o + 2], b1 = v[o + 3];
        if (a0 !== a0 || a1 !== a1 || Y(a0) > 2 * h || Y(b0) < -h) continue;      // no groove here, or far outside the view
        const x0 = X(c), x1 = X(c + 1);
        fill.moveTo(x0, Y(a0)); fill.lineTo(x1 + 0.5, Y(a1)); fill.lineTo(x1 + 0.5, Y(b1)); fill.lineTo(x0, Y(b0)); fill.closePath();
        edge.moveTo(x0, Y(a0)); edge.lineTo(x1, Y(a1)); edge.moveTo(x0, Y(b0)); edge.lineTo(x1, Y(b1));
      }
    }
    sc.fillStyle = '#060607'; sc.fill(fill);
    sc.strokeStyle = '#b9b2a6'; sc.lineWidth = 1.5; sc.stroke(edge);
    const xg = v[rows * cols * 2], hc = v[rows * cols * 2 + 1], down = hc < 40e-6;
    sc.strokeStyle = 'rgba(255,180,84,.35)'; sc.lineWidth = 1; sc.beginPath(); sc.moveTo(w / 2, 0); sc.lineTo(w / 2, h); sc.stroke();
    sc.fillStyle = down ? '#ffb454' : 'rgba(255,180,84,.25)';
    sc.beginPath(); sc.arc(w / 2, Y(xg === xg ? xg : 0), Math.max(5, 13e-6 * k), 0, TAU); sc.fill();
  }
  function drawNumbers(t) {
    el('s-rpm').textContent = (t.wp * 60 / TAU).toFixed(2) + ' rpm';
    el('s-vg').textContent = (t.vg * 100).toFixed(1) + ' cm/s';
    el('s-r').textContent = (t.r * 1000).toFixed(1) + ' mm';
    el('s-err').textContent = (Math.asin(Math.max(-1, Math.min(1, t.err))) * 180 / Math.PI).toFixed(2) + '°';
    el('s-nl').textContent = (t.nIn * 1000).toFixed(1) + ' mN'; el('s-nr').textContent = (t.nOut * 1000).toFixed(1) + ' mN';
    el('s-loss').textContent = (t.loss * 100).toFixed(0) + ' %';
    el('s-xi').textContent = (t.xi * 1e6).toFixed(0) + '/' + (t.ze * 1e6).toFixed(0) + ' µm'; el('s-load').textContent = t.load != null ? (t.load * 100).toFixed(0) + ' %' : '-';
    el('s-z').textContent = t.hc > 1e-4 ? (t.hc * 1000).toFixed(1) + ' mm' : (t.hc * 1e6).toFixed(1) + ' µm';   // above the local surface
  }
  function drawStats() {
    const t = S.tel; if (!t) return;
    drawNumbers(t);
    // the readout only exists while the needle is on the record (with a grace period so that
    // lifting it to jump elsewhere does not make the panel blink)
    const down = t.hc < 40e-6, clock = performance.now();
    if (down) S.lastDown = clock;
    const show = down || (S.lastDown > 0 && clock - S.lastDown < 3000);
    if (show !== S.hudOn) { S.hudOn = show; el('hud').classList.toggle('on', show); }
    // in a track: its title and time, bars moving while the record turns; anywhere else: the record's name
    // only while the platter holds the record that was picked last: switching shows the new name straight away,
    // and never a track of the previous record while the new one loads
    // (a new record is put on with the needle lifted: until it has been up once, it is still settling on the old radius)
    const rec = S.rec && S.rec.pick === pick && t.recSeq === S.rec.seq && (S.rec.lifted ||= !down) ? S.rec : null;
    const k = rec && down && t.xg === t.xg ? rec.tracks.find((k) => t.theta >= k.theta0 && t.theta < k.theta1) : null;
    if (k) nowPlaying(k.title, `${fmt((t.theta - k.theta0) / W33)} / ${fmt((k.theta1 - k.theta0) / W33)}`, Math.abs(t.wp) * 60 / TAU > 5);
    else if (!rec) nowPlaying(S.recTitle || 'Records');
    else nowPlaying(S.recTitle || 'Records', !down ? '' : t.xg !== t.xg ? 'off the groove'
      : t.theta >= S.rec.thetaLock ? 'run-out' : t.theta > S.rec.tracks[S.rec.tracks.length - 1].theta1 ? 'lead-out' : t.theta < S.rec.tracks[0].theta0 ? 'lead-in' : 'between tracks');
  }

  // ---------- frame loop ----------
  let frame = 0;
  function tick() {
    const t = S.tel, dt = t ? Math.min(0.1, (performance.now() - S.tRecv) / 1000) : 0;
    S.zoom += (S.zoomT - S.zoom) * 0.12;
    if (frame % 6 === 0 && S.on && !S.started) powerMsg();
    if (S.resetting) {
      S.az += (AZ0 - S.az) * 0.12; S.el += (EL0 - S.el) * 0.12;
      if (Math.abs(S.az - AZ0) < 1e-3 && Math.abs(S.el - EL0) < 1e-3) { S.az = AZ0; S.el = EL0; S.resetting = false; }
    }
    S.moved = Math.abs(S.zoomT) > 0.01 || Math.abs(S.az - AZ0) > 0.01 || Math.abs(S.el - EL0) > 0.01;
    guard('render', () => {
      if (og) renderer.draw({ thp: 2.2, al: alphaForRadius(0.108), zt: 0, zoom: 0, az: -0.5, el: 0.6, motor: true, rpm: 33.3333, bare: true, dist: 1.1, at: [0.021, -0.07, -0.093], ...window.__og });   // deck high in the frame: X overlays the bottom
      else renderer.draw({ thp: t ? t.thp + t.wp * dt : 0, al: t ? t.al : ALPHA_REST, zt: t ? t.zb + t.ze : 5e-3, zoom: S.zoom, az: S.az, el: S.el, motor: S.motor, rpm: S.rpm });
    });
    if (frame++ % 2 === 0 && S.hudOn) guard('groove view', drawScope);
    if (frame % 6 === 0) guard('readout', drawStats);
  }
  function resetView() {      // ease the camera back to where it started
    S.zoomT = 0; S.resetting = true;
    S.az = AZ0 + ((((S.az - AZ0 + Math.PI) % TAU) + TAU) % TAU) - Math.PI;   // unwind full turns first
  }

  return Object.defineProperties(api, Object.getOwnPropertyDescriptors({   // not Object.assign: that would freeze the getters at their first value
    name, canvas, S, renderer, send, tick, resetView, cutFiles, onKey,
    get ctx() { return ctx; },
    get moved() { return S.moved; },
    panels: [[el('ctl'), el('t-ctl')], [el('shelf'), el('t-records')]],
  }));
}
