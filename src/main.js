// UI: wires the renderer, the mastering worker and the audio-thread physics engine together.
import { Renderer } from './render.js';
import { TAU } from './dsp.js';
import { RECORDS } from './records.js';
import { COMMONS_ALBUMS, albumSource, loadCommonsAlbum, prepareCommonsTrack } from './commons.js';
import { press, makeVis } from './press.js';
import { PIVOT_X, PIVOT_Y, ALPHA_REST, R_DISC, R_LABEL, R_LEADIN, W33, alphaForRadius, stylusXY } from './geometry.js';

const $ = (id) => document.getElementById(id);
const canvas = $('gl'), renderer = new Renderer(canvas);
let masterWorker = null;      // the lathe + pressing plant; only started if something has to be mastered in the browser
const worker = { postMessage: (m, transfer) => { busy(); (masterWorker ||= startWorker()).postMessage(m, transfer || []); } };
// The progress bar (index.html) shows window.__load: a download with got/total, or just "busy" when the size is unknown.
const busy = (h = { got: 0, total: 0 }) => (window.__load = h);
const idle = () => { if (window.__load) window.__load.done = true; };
const AZ0 = -0.5, EL0 = 0.6;   // default camera
const S = { hudOn: false, lastDown: 0, tel: null, tRecv: 0, zoom: 0, zoomT: 0, az: AZ0, el: EL0, rpm: 33.3333, rec: null, pending: null, motor: false, cue: true, ready: false };
let ctx = null, node = null, drag = null;
// ?og renders just the deck on black, with no interface and no audio: it is how og.png (the share image) is made
const OG = new URLSearchParams(location.search).has('og');
if (OG) document.documentElement.classList.add('og');
let pick = 0;   // bumps each time a record is chosen, so an older, slower cut cannot land on top of a newer choice
const send = (m, transfer) => { if (node) node.port.postMessage(m, transfer || []); };
const status = (msg) => { $('status').textContent = msg; };   // empty when nothing is happening

// ---------- mastering ----------
const condition = () => Object.fromEntries(['noise', 'dust', 'scratches', 'warp', 'offCenter'].map((k) => [k, +$('c-' + k).value]));
function startWorker() {
  const w = new Worker(new URL('./master-worker.js', import.meta.url), { type: 'module' });
  w.onmessage = ({ data: m }) => {
    if (m.id != null && m.id !== pick) return;
    if (m.t === 'status') status(m.msg + '...');
    else if (m.t === 'error') { idle(); status('Mastering failed: ' + m.msg); console.error(m.msg); }
    else if (m.t === 'done') { if (m.id == null || m.id === pick) gotRecord(m.rec, m.vis); }
  };
  return w;
}
function gotRecord(rec, vis) {
  renderer.setRecord(rec, vis);
  idle();
  if (!S.shown) {            // first record: fade the deck and the disc in together, a frame after it has been drawn
    S.shown = true;
    requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.add('ready')));
  }
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
  if (S.album) {
    if (S.started && S.on && S.album.wantsPlay) play(); else start();
  } else if (S.started) play(); else start();
}
const play = () => {
  setMotor(true);
  clearTimeout(S.cueTimer);
  S.cueTimer = setTimeout(() => { if (S.on && S.motor) send({ t: 'cueTo', al: alphaForRadius(R_LEADIN - 0.0012) }); }, 400);
};
// Nothing moves until all three are true: the user powered on, the engine is warm, and a record is in it.
function start() {
  if (!S.on || !S.ready || !S.loaded || S.started) return;
  S.started = true; $('power')?.remove(); if (!S.album || S.album.wantsPlay) play();
}

// ---------- precompiled record (lathe.mjs): the clean cut ships as DPCM; decode it, press it here, go ----------
const decodeAudio = async (url, fs) => new OfflineAudioContext(2, 1, fs).decodeAudioData(await (await fetch(url)).arrayBuffer());   // for mastering here
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
  const me = pick;
  S.workerHasSource = false;
  return loadPrecompiled().catch((err) => {     // not built (or stale): master it here instead
    if (me !== pick) return;
    console.info((err.message || err) + '; mastering in the browser');
    S.man = null; worker.postMessage({ t: 'demo', id: me, fs: 48000, cond: condition() });
  });
}
// Pressing again: a precompiled record is pressed here from the same cut (re-read from the browser cache);
// one mastered in the browser goes back to the worker, which still has the tape.
async function pressAgain() {
  if (S.album) return chooseCommonsTrack(S.album.index);
  const cond = condition(), seed = 1 + Math.floor(Math.random() * 1e6);
  if (!S.man) return worker.postMessage({ t: 'press', id: pick, cond, seed });
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
      if (m.t === 'tel') {
        S.tel = m; S.tRecv = performance.now(); if (m.view) S.view = m.view; S.cue = m.cueUp;
        advanceCommons(m);
      }
      else if (m.t === 'ready') {
        S.ready = true; pushParams(); send({ t: 'motor', on: S.motor }); send({ t: 'view', on: true }); loadRecord(); start();
        $('d-rate').textContent = (m.os * m.fs).toLocaleString('en-US');
      } else if (m.t === 'log') console.warn(m.msg);
    };
    node.connect(ctx.destination);
    if (!S.on && ctx.state === 'running') await ctx.suspend();   // some browsers start it unasked; stay silent until power-on
  })().catch((err) => { audioInit = null; ctx = null; node = null; throw err; });
}
const POWER_MSG = matchMedia('(pointer: coarse)').matches ? 'tap to power on' : 'click to power on';
async function powerOn() {
  if (S.on) return;
  S.on = true; $('power')?.classList.add('busy');      // a spinner until the engine is warm AND the record is in it
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
    S.on = false; setMotor(false); $('power')?.classList.remove('busy');
    if ($('power-msg')) $('power-msg').textContent = err.message === 'not started' ? POWER_MSG : 'audio failed: ' + err.message;
    if (err.message !== 'not started') console.error(err);
  }
}
// What the power button says while we wait (the progress bar itself is driven from index.html).
function powerMsg() {
  const el = $('power-msg');
  if (el && S.on && !S.started) el.textContent = $('status').textContent.replace(/\.+$/, '') || (S.loaded ? (S.ready ? 'starting' : 'warming up') : 'loading the record');
}
$('power').addEventListener('click', powerOn);       // the pill; a tap on the scene powers on too (see the pointer handlers)
$('power-msg').textContent = POWER_MSG;
if (!OG) initAudio().catch(() => {});   // best effort before any gesture; the click retries if the browser refused

// ---------- controls ----------
function setCue(up) { S.cue = up; send({ t: 'cue', up }); }
function setMotor(on) { S.motor = on; if (S.album) S.album.wantsPlay = on; send({ t: 'motor', on }); $('b-start').textContent = on ? 'Stop' : 'Start'; $('b-start').classList.toggle('on', on); }
function pushParams() {
  // 100% on the slider is 2 dB under unity: the cartridge lifts the treble by up to 1.9 dB, and bright peaks would clip
  send({ t: 'set', volume: 0.8 * +$('p-volume').value, stylus: $('p-stylus').value, vtf: +$('p-vtf').value, antiskate: +$('p-antiskate').value, hum: +$('p-hum').value });
}
for (const el of document.querySelectorAll('#ctl input[type=range]')) {
  const out = el.parentElement.querySelector('output'), show = () => { out.textContent = el.id === 'p-volume' ? Math.round(el.value * 100) + '%' : (+el.value).toFixed(2); };
  el.addEventListener('input', () => { show(); if (el.id.startsWith('p-')) pushParams(); }); show();
}
$('p-stylus').addEventListener('change', pushParams);
const toggle = (btn, panel, onChange) => $(btn).addEventListener('click', () => {
  const open = $(panel).hidden; $(panel).hidden = !open; $(btn).setAttribute('aria-pressed', String(open)); if (onChange) onChange(open);
});
toggle('t-ctl', 'ctl', (open) => { if (open && !$('shelf').hidden) $('t-records').click(); });      // one panel in that corner at a time
toggle('t-records', 'shelf', (open) => { if (open && !$('ctl').hidden) $('t-ctl').click(); });
// tapping anywhere outside an open panel closes it, and that tap does nothing else (it won't drop the needle
// or grab the record), so the toggles and a tap on the scene both work as open / close; so does Escape
const PANELS = [['ctl', 't-ctl'], ['shelf', 't-records']];
addEventListener('pointerdown', (e) => {
  let closed = false;
  for (const [panel, btn] of PANELS) if (!$(panel).hidden && !$(panel).contains(e.target) && !$(btn).contains(e.target)) { $(btn).click(); closed = true; }
  if (closed && e.target === canvas) e.stopPropagation();
}, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape') for (const [panel, btn] of PANELS) if (!$(panel).hidden) $(btn).click(); });
$('t-reset').addEventListener('click', () => {      // ease the camera back to where it started
  S.zoomT = 0; S.resetting = true;
  S.az = AZ0 + ((((S.az - AZ0 + Math.PI) % TAU) + TAU) % TAU) - Math.PI;   // unwind full turns first
});
$('b-more').addEventListener('click', () => { $('more').showModal(); $('more').scrollTop = 0; });
$('more').addEventListener('click', (e) => { if (e.target === $('more')) $('more').close(); });   // click outside closes
$('b-start').addEventListener('click', () => setMotor(!S.motor));
$('b-cue').addEventListener('click', () => send({ t: 'cue', up: !S.cue }));
$('b-bump').addEventListener('click', () => send({ t: 'bump', s: 1 }));
$('b-press').addEventListener('click', pressAgain);
for (const b of document.querySelectorAll('[data-rpm]')) {
  b.addEventListener('click', () => { document.querySelectorAll('[data-rpm]').forEach((x) => x.classList.toggle('on', x === b)); S.rpm = +b.dataset.rpm; send({ t: 'speed', rpm: S.rpm }); });
}
async function cutFiles(files) {
  const list = [...files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|wav|flac|m4a|ogg|aiff?)$/i.test(f.name));
  if (!list.length) return;
  cancelCommons();
  const me = ++pick;
  status('Decoding...');
  const tracks = [], transfer = [];
  for (const f of list) {
    try {
      const ab = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(await f.arrayBuffer());
      if (me !== pick) return;
      const L = ab.getChannelData(0).slice(), R = ab.numberOfChannels > 1 ? ab.getChannelData(1).slice() : L.slice();
      tracks.push({ L, R, title: f.name.replace(/\.[^.]+$/, '') }); transfer.push(L.buffer, R.buffer);
    } catch (err) { console.error(err); }
  }
  if (!tracks.length) return status('Could not decode that audio.');
  if (me !== pick) return;
  S.workerHasSource = true; S.man = null; markRecord(null);
  worker.postMessage({ t: 'tracks', id: me, tracks, fs: 48000, cond: condition() }, transfer);
}

// ---------- record shelf: free-to-ship recordings (src/records.js, audio in records/), precompiled into assets/<id>/ ----------
const shelf = $('shelf'), credit = shelf.appendChild(document.createElement('p'));
// The Records toggle shows what is on the platter: the record, or while a track plays its title and time.
function nowPlaying(title, time = '', playing = false) {
  if (title === S.nowTitle && time === S.nowTime && playing === S.nowPlaying) return;
  S.nowTitle = title; S.nowTime = time; S.nowPlaying = playing;
  $('now-title').textContent = title; $('now-time').textContent = time;
  $('t-records').classList.toggle('playing', playing);
  $('t-records').title = `Records: ${title}${time ? ' ' + time : ''}`;
}
function markRecord(r) {
  S.shelf = r?.tracks ? r : null;
  S.recTitle = r ? r.title : 'Your audio'; nowPlaying(S.recTitle);
  for (const b of shelf.querySelectorAll('button[data-id]')) b.setAttribute('aria-current', String(b.dataset.id === r?.id));
  credit.replaceChildren(r ? [r.credit, r.licence].filter(Boolean).join(' · ') : 'Your own audio');
  if (r?.url) credit.append(' · ', Object.assign(document.createElement('a'), { href: r.url, target: '_blank', rel: 'noopener', textContent: 'source' }));
}
async function pickRecord(r) {
  cancelCommons();
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

// ---------- Commons albums: fetch on demand, cut one track ahead ----------
const commonsShelf = shelf.appendChild(document.createElement('section'));
commonsShelf.id = 'commons-shelf';
commonsShelf.innerHTML = '<h2>Albums from Wikimedia Commons</h2><p>CC0 recordings. Play one track while the next is prepared.</p><div id="commons-albums"></div><p id="commons-status" role="status"></p><p id="cache-status" role="status"></p><div id="commons-tracks"></div>';
$('cache-status').textContent = window.__cacheUnavailable ? 'Local caching is unavailable. Use HTTPS or localhost with browser storage enabled.' : 'Downloads are saved on this device for replay and offline listening.';
navigator.serviceWorker?.addEventListener('message', ({ data }) => {
  if (data.type === 'cache-error') $('cache-status').textContent = 'Could not save a download. Free some browser storage; this track may need internet next time.';
});
for (const album of COMMONS_ALBUMS) {
  const button = document.createElement('button');
  button.dataset.album = album.id;
  button.append(Object.assign(document.createElement('b'), { textContent: album.title }),
    Object.assign(document.createElement('span'), { textContent: album.count + ' tracks' }));
  button.addEventListener('click', () => chooseCommonsAlbum(album));
  $('commons-albums').append(button);
}
function cancelCommons() {
  S.album?.controller.abort(); S.album = null;
  $('commons-status').textContent = '';
  $('commons-tracks').replaceChildren();
  for (const button of $('commons-albums').children) button.removeAttribute('aria-current');
}
function beginCommons(album, tracks = []) {
  navigator.storage?.persist?.().catch(() => {});
  cancelCommons();
  const session = { album, tracks, index: 0, controller: new AbortController(), wantsPlay: true, waiting: true };
  // Discard a previous cut and its callbacks, including a pending startup record.
  masterWorker?.terminate(); masterWorker = null;
  ++pick; S.pending = null; S.loaded = false; S.man = null; S.workerHasSource = false;
  clearTimeout(S.cueTimer); setCue(true); setMotor(false);
  S.album = session;
  markRecord({ title: album.title, credit: album.by, licence: 'CC0', url: albumSource(album) });
  for (const button of $('commons-albums').children) button.setAttribute('aria-current', String(button.dataset.album === album.id));
  busy();
  // Resume audio within the click gesture, before requesting album metadata.
  if (!S.on) powerOn(); else ctx?.resume().catch(() => {});
  setMotor(true);     // Stop must cancel the pending play request during buffering too.
  return session;
}
async function chooseCommonsAlbum(album) {
  const session = beginCommons(album);
  $('commons-status').textContent = 'Loading album…';
  try {
    session.tracks = await loadCommonsAlbum(album, session.controller.signal);
    if (S.album !== session) return;
    renderCommonsTracks(session);
    await playCommonsTrack(session, 0);
  } catch (err) { commonsError(session, err); }
}
function renderCommonsTracks(session) {
  $('commons-tracks').replaceChildren(...session.tracks.map((track, index) => {
    const button = document.createElement('button');
    button.dataset.track = index;
    button.append(Object.assign(document.createElement('b'), { textContent: track.number + '. ' + track.title }),
      Object.assign(document.createElement('span'), { textContent: fmt(track.duration) }));
    button.addEventListener('click', () => chooseCommonsTrack(index));
    return button;
  }));
}
function chooseCommonsTrack(index) {
  if (!S.album?.tracks[index]) return;
  const { album, tracks } = S.album;
  const session = beginCommons(album, tracks);
  renderCommonsTracks(session);
  playCommonsTrack(session, index);
}
function commonsError(session, err) {
  if (S.album !== session || session.controller.signal.aborted) return;
  session.waiting = false; session.failed = true;
  setMotor(false);
  idle(); status('');
  $('commons-status').textContent = err.message || 'Could not load this track. Select it to retry.';
}
function prepareUpcoming(session, index) {
  // Convert failure to a result immediately: a background download can fail long
  // before the listener reaches this track, without an unhandled rejection.
  return prepareCommonsTrack(session.tracks[index], condition(), session.controller.signal, (message) => {
    if (S.album === session && session.waiting && session.index === index) $('commons-status').textContent = message;
  }).then(result => ({ result }), error => ({ error }));
}
async function playCommonsTrack(session, index) {
  if (S.album !== session) return;
  session.index = index; session.waiting = true; session.failed = false;
  const me = ++pick;
  S.pending = null; S.loaded = false;
  clearTimeout(S.cueTimer); setCue(true);
  // Stop the old disc without changing the user's play/stop intent while buffering.
  send({ t: 'motor', on: false });
  busy(); $('commons-status').textContent = 'Preparing ' + session.tracks[index].title + '…';
  for (const button of $('commons-tracks').children) button.setAttribute('aria-current', String(+button.dataset.track === index));
  const track = session.tracks[index];
  markRecord({ title: session.album.title, credit: session.album.by, licence: 'CC0', url: track.source });
  try {
    const prepared = session.next || prepareUpcoming(session, index);
    session.next = null;
    const { result, error } = await prepared;
    if (S.album !== session || me !== pick) return;
    if (error) throw error;
    session.waiting = false;
    gotRecord(result.rec, result.vis);
    $('commons-status').textContent = `Track ${index + 1} of ${session.tracks.length}. ${session.album.by}.`;
    if (index + 1 < session.tracks.length) session.next = prepareUpcoming(session, index + 1);
  } catch (err) { commonsError(session, err); }
}
function advanceCommons(t) {
  const album = S.album, rec = S.rec;
  if (!album || album.waiting || album.failed || !rec || rec.pick !== pick || t.recSeq !== rec.seq) return;
  const down = t.hc < 40e-6;
  rec.lifted ||= !down;
  if (!rec.lifted || !down || t.cueUp || !S.on || !S.motor || t.wp <= 0 || t.theta < rec.tracks.at(-1).theta1) return;
  if (album.index + 1 < album.tracks.length) playCommonsTrack(album, album.index + 1);
  else { setCue(true); setMotor(false); $('commons-status').textContent = 'Album finished. Select a track to play again.'; }
}

pickRecord(RECORDS.find((r) => r.id === (window.__boot?.id || 'rhapsody')) || RECORDS[0]);   // the record on the platter when the page opens
$('f-audio').addEventListener('change', (e) => cutFiles(e.target.files));
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); cutFiles(e.dataTransfer.files); });
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); setMotor(!S.motor); }
  else if (e.key === 'c') send({ t: 'cue', up: !S.cue });
  else if (e.key === 'b') send({ t: 'bump', s: 1 });
  else if (e.key === 'z') S.zoomT = S.zoomT > 0.5 ? 0 : 0.92;
});

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
const scope = $('scope'), sc = scope.getContext('2d');
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
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function drawNumbers(t) {
  $('s-rpm').textContent = (t.wp * 60 / TAU).toFixed(2) + ' rpm';
  $('s-vg').textContent = (t.vg * 100).toFixed(1) + ' cm/s';
  $('s-r').textContent = (t.r * 1000).toFixed(1) + ' mm';
  $('s-err').textContent = (Math.asin(Math.max(-1, Math.min(1, t.err))) * 180 / Math.PI).toFixed(2) + '°';
  $('s-nl').textContent = (t.nIn * 1000).toFixed(1) + ' mN'; $('s-nr').textContent = (t.nOut * 1000).toFixed(1) + ' mN';
  $('s-loss').textContent = (t.loss * 100).toFixed(0) + ' %';
  $('s-xi').textContent = (t.xi * 1e6).toFixed(0) + '/' + (t.ze * 1e6).toFixed(0) + ' µm'; $('s-load').textContent = t.load != null ? (t.load * 100).toFixed(0) + ' %' : '-';
  $('s-z').textContent = t.hc > 1e-4 ? (t.hc * 1000).toFixed(1) + ' mm' : (t.hc * 1e6).toFixed(1) + ' µm';   // above the local surface
}
function drawStats() {
  const t = S.tel; if (!t) return;
  drawNumbers(t);
  // the readout only exists while the needle is on the record (with a grace period so that
  // lifting it to jump elsewhere does not make the panel blink)
  const down = t.hc < 40e-6, clock = performance.now();
  if (down) S.lastDown = clock;
  const show = down || (S.lastDown > 0 && clock - S.lastDown < 3000);
  if (show !== S.hudOn) { S.hudOn = show; $('hud').classList.toggle('on', show); }
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
// One failing part must never stop the frame loop: that froze the picture while the sound carried on.
// The first error is shown in the status line so it can be read off a phone.
const seen = new Set();
function guard(name, fn) {
  try { fn(); } catch (err) {
    if (seen.has(name)) return;
    seen.add(name); console.error(name, err); status(`${name} error: ${(err && err.message) || err}`);
  }
}
addEventListener('error', (e) => { if (!seen.size) { seen.add('page'); status(`error: ${e.message}`); } });
function tick() {
  requestAnimationFrame(tick);      // first, so nothing below can end the loop
  const t = S.tel, dt = t ? Math.min(0.1, (performance.now() - S.tRecv) / 1000) : 0;
  S.zoom += (S.zoomT - S.zoom) * 0.12;
  if (frame % 6 === 0 && S.on && !S.started) powerMsg();
  if (S.resetting) {
    S.az += (AZ0 - S.az) * 0.12; S.el += (EL0 - S.el) * 0.12;
    if (Math.abs(S.az - AZ0) < 1e-3 && Math.abs(S.el - EL0) < 1e-3) { S.az = AZ0; S.el = EL0; S.resetting = false; }
  }
  const moved = Math.abs(S.zoomT) > 0.01 || Math.abs(S.az - AZ0) > 0.01 || Math.abs(S.el - EL0) > 0.01;
  if (moved !== S.moved) { S.moved = moved; $('t-reset').hidden = !moved; }
  guard('render', () => {
    if (OG) renderer.draw({ thp: 2.2, al: alphaForRadius(0.108), zt: 0, zoom: 0, az: -0.5, el: 0.6, motor: true, rpm: 33.3333, bare: true, dist: 1.1, at: [0.021, -0.07, -0.093], ...window.__og });   // deck high in the frame: X overlays the bottom
    else renderer.draw({ thp: t ? t.thp + t.wp * dt : 0, al: t ? t.al : ALPHA_REST, zt: t ? t.zb + t.ze : 5e-3, zoom: S.zoom, az: S.az, el: S.el, motor: S.motor, rpm: S.rpm });
  });
  if (frame++ % 2 === 0 && S.hudOn) guard('groove view', drawScope);
  if (frame % 6 === 0) guard('readout', drawStats);
}
tick();
window.__rp = { S, get ctx() { return ctx; }, send, renderer, stylusXY };   // debugging handle
