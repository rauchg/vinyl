// The mixer between two decks: the panel of controls, which hold every setting, and what it tells the audio thread (desk.js).
import { audioContext } from './audio-context.js';
import { bandGain, crossGains, faderGain, trimGain } from './desk.js';

const SIDES = ['a', 'b'];
const BANDS = [['high', 'High'], ['mid', 'Mid'], ['low', 'Low']];
const FADE_MS = 100, FRESH_MS = 300, ECHO_BEATS = 0.75, ECHO_DEFAULT = 0.375, TICK_FRAMES = 6;   // the echo repeats on the off-beat when the tempo is known
const RECORD_TYPES = [['audio/webm;codecs=opus', 'webm'], ['audio/mp4', 'm4a'], ['audio/ogg;codecs=opus', 'ogg']];
const $ = (id) => document.getElementById(id);

function slider(id, label, min, max, step, value) {
  const s = Object.assign(document.createElement('input'), { id, type: 'range', min, max, step });
  s.defaultValue = s.value = value;
  s.setAttribute('aria-label', label);
  return s;
}
function toggle(id, label) {
  const s = Object.assign(document.createElement('input'), { id, type: 'checkbox' });
  s.setAttribute('aria-label', label);
  return s;
}
const row = (cls, ...kids) => { const d = document.createElement('div'); d.className = cls; d.append(...kids); return d; };
const caption = (textContent, title = '') => Object.assign(document.createElement('span'), { textContent, title });
const toCentre = (s) => { if (s.type === 'checkbox') s.checked = false; else s.value = s.defaultValue; s.dispatchEvent(new Event('input')); };
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export class Mixer {
  constructor(root, say) {
    this.root = root; this.say = say; this.decks = null; this.node = null; this.readings = null; this.session = 0; this.frame = 0;
    this.applied = [];                              // how to send each setting to the audio thread
    const toDesk = (key, map = (v) => v) => (i, v) => this.post({ ch: i, key, value: map(v) });
    const left = document.createElement('div'), right = document.createElement('div');
    left.append(this.strip('trim', 'Trim', -1, 1, 0.01, 0, toDesk('trim', trimGain)));
    for (const [key, label] of BANDS) left.append(this.strip(key, label, -1, 1, 0.01, 0, toDesk(key, bandGain)));
    right.append(this.strip('filter', 'Filter', -1, 1, 0.01, 0, toDesk('filter')));
    right.append(this.strip('echo', 'Echo', 0, 1, 0.01, 0, toDesk('send', faderGain)));
    right.append(this.toggles('cue', 'Cue', toDesk('pfl')));
    right.append(this.strip('level', 'Level', 0, 1, 0.01, 1, () => this.levels()));
    root.append(row('mx-cols', left, right));

    this.cross = this.control(slider('m-cross', 'Crossfader', 0, 1, 0.01, 0.5), () => this.levels());
    this.cross.addEventListener('dblclick', () => toCentre(this.cross));
    root.append(row('mx mx-cross', Object.assign(caption('A'), { title: 'Deck A' }), this.cross, Object.assign(caption('B'), { title: 'Deck B' })));

    this.master = this.control(slider('m-master', 'Master level', 0, 1, 0.01, 1), () => this.levels());
    this.cueMix = this.control(slider('m-cuemix', 'Headphones: cue to mix', 0, 1, 0.01, 0), () => this.post({ key: 'cueMix', value: +this.cueMix.value }));
    this.curve = this.control(toggle('m-curve', 'Sharp crossfader for scratching'), () => this.levels());
    this.rec = toggle('m-rec', 'Record the mix');
    this.rec.addEventListener('input', () => (this.rec.checked ? this.startRecording() : this.stopRecording()));
    for (const s of [this.master, this.cueMix]) s.addEventListener('dblclick', () => toCentre(s));
    root.append(row('mx-end', caption('Master'), this.master, caption('Cue mix', 'In the left ear while a deck is cued: all the way down is the cued deck alone, all the way up is the mix'), this.cueMix,
      Object.assign(document.createElement('label'), { title: 'Sharp crossfader for scratching' }), Object.assign(document.createElement('label'), { title: 'Record the mix' })));
    const [cut, rec] = root.querySelectorAll('.mx-end label');
    cut.append(this.curve, 'Cut'); rec.append(this.rec, 'Rec');
  }

  post(message) { this.node?.port.postMessage(message); }
  // A control that sets something on the audio thread. Remembered, so the mixer can be told everything at once when it starts.
  control(input, apply) {
    input.addEventListener('input', () => { if (this.decks) apply(); });
    this.applied.push(apply);
    return input;
  }

  // One row of the mixer: deck A's slider, the name, deck B's slider.
  strip(key, label, min, max, step, value, onInput) {
    const sliders = SIDES.map((side, i) => {
      const s = this.control(slider(`m-${key}-${side}`, `${side.toUpperCase()} ${label}`, min, max, step, value), () => onInput(i, +s.value));
      s.addEventListener('dblclick', () => toCentre(s));
      return s;
    });
    return row('mx', sliders[0], caption(label), sliders[1]);
  }
  toggles(key, label, onInput) {
    const boxes = SIDES.map((side, i) => { const s = this.control(toggle(`m-${key}-${side}`, `${side.toUpperCase()} ${label}`), () => onInput(i, s.checked ? 1 : 0)); return s; });
    return row('mx', boxes[0], caption(label, 'Hear this deck in the left ear before it goes out. The right ear keeps the mix.'), boxes[1]);
  }

  // The channel faders, the crossfader and the master.
  levels() {
    if (!this.decks) return;
    const cross = crossGains(+this.cross.value, this.curve.checked), master = faderGain(+this.master.value);
    SIDES.forEach((side, i) => this.post({ ch: i, key: 'gain', value: faderGain(+$(`m-level-${side}`).value) * cross[i] }));
    this.post({ key: 'master', value: master });
  }

  async attach(decks) {
    this.decks = decks;
    this.root.hidden = false;
    const me = ++this.session, ctx = audioContext();
    try {
      await ctx.audioWorklet.addModule(new URL('./desk-worklet.js', import.meta.url));
      if (me !== this.session) return;
      this.node = new AudioWorkletNode(ctx, 'desk', { numberOfInputs: 2, numberOfOutputs: 2, outputChannelCount: [2, 2] });
      this.node.port.onmessage = ({ data }) => { this.readings = data; data.at = performance.now(); };
      this.node.connect(ctx.destination);
      this.echoTime = null;                   // a fresh mixer has been told nothing yet
      for (const apply of this.applied) apply();
      decks.forEach((d, i) => d.plugInto(this.node, i));
    } catch (err) { console.error(err); this.say('Mixer', 'could not start: ' + err.message); }
  }
  // Back to one deck: nothing is left on screen to undo these with.
  detach() {
    const [a] = this.decks, node = this.node;
    this.session++;
    if (this.recorder) this.stopRecording();
    for (const s of this.root.querySelectorAll('input')) if (s !== this.rec) toCentre(s);
    a.plugInto(null);
    this.decks = null; this.node = this.readings = null;
    this.root.hidden = true;
    if (node) {                                 // the deck has already started back towards the speakers: let the mixer fade out under it
      node.port.postMessage({ key: 'master', value: 0 });
      setTimeout(() => { node.port.postMessage({ end: true }); node.disconnect(); }, FADE_MS);
    }
  }

  // What the meters read, or null if there is nothing recent: { pre, post, master, reduced, at }.
  get meters() { return this.readings && performance.now() - this.readings.at < FRESH_MS ? this.readings : null; }

  // ---------- recording the mix ----------
  startRecording() {
    const type = RECORD_TYPES.find(([t]) => MediaRecorder.isTypeSupported(t));
    if (!this.node || !type) { this.rec.checked = false; this.say('Mixer', 'this browser cannot record the mix'); return; }
    const out = audioContext().createMediaStreamDestination(), chunks = [], started = performance.now(), recorder = new MediaRecorder(out.stream, { mimeType: type[0], audioBitsPerSecond: 256000 });
    this.node.connect(out, 1);
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      try { this.node?.disconnect(out, 1); } catch {}
      this.say('Mixer', '');
      this.saveRecording(new Blob(chunks, { type: type[0] }), type[1], started);
    };
    recorder.start(1000);
    this.recorder = recorder; this.recStart = started;
  }
  stopRecording() {
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.recorder = null; this.rec.checked = false;
  }
  saveRecording(blob, extension, started) {
    const stamp = new Date(performance.timeOrigin + started).toISOString().slice(0, 16).replace(/[:T]/g, '-'), url = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), { href: url, download: `vinyl-mix-${stamp}.${extension}` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ---------- each frame ----------
  tick(controllers) {
    if (!this.decks || this.frame++ % TICK_FRAMES) return;
    if (this.recorder) this.say('Mixer', `recording ${clock((performance.now() - this.recStart) / 1000)}`);
    // the echo keeps time with whichever deck is being sent to it
    const sends = SIDES.map((side) => +$(`m-echo-${side}`).value), from = sends[1] > sends[0] ? 1 : 0;
    const bpm = controllers[from]?.speedBpm() ?? controllers[1 - from]?.speedBpm();
    const seconds = bpm ? ECHO_BEATS * 60 / bpm : ECHO_DEFAULT;
    if (Math.abs(seconds - this.echoTime) > 1e-3 || this.echoTime == null) { this.echoTime = seconds; this.post({ key: 'echoTime', value: seconds }); }
  }
}
