// One deck's controls, laid out the way a DJ deck has them: Play and Cue, a jog wheel, pitch, hot cues, loops and a tempo readout.
import { TAU } from './dsp.js';
import { W33 } from './geometry.js';

const PITCH = 0.08, PADS = 4, BEATS = [1, 2, 4, 8];
const GUESS_BPM = 120;           // what a loop's beats are counted in until the tempo is known
const AT_CUE = 0.02;             // rad of groove, about 6 ms: closer than this counts as being on the cue point
const LOOP_MARGIN = 0.6;         // rad of groove: further than this outside a loop means the needle has left it
const RING = 0.72;               // the jog's outer ring starts at this fraction of its radius
const NUDGE = 0.012, BEND_MAX = 0.08;   // the ring: speed change per rad/s it is turned, and the most it can change
const TAP_GAP_MS = 2000, TAPS = 8, HOLD_MS = 600;
const LOCK_GAIN = 0.12, LOCK_MAX = 0.02, LOCK_DEAD = 0.005, SNAP = 0.02, FLASH = 0.16;   // Sync's corrections, as speed per beat of error, at most, and how small an error is left alone; how far out a press of Sync jumps; how much of a beat the light stays on
const NOTE_MS = 4000;
const wrap = (x) => x - Math.round(x);       // the nearest way round a beat: -0.5 to 0.5

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const make = (name, className, props) => Object.assign(document.createElement(name), { className, ...props });
const button = (className, textContent, title = '') => make('button', className, { type: 'button', textContent, title });
// Pressed on pointerdown, so a pad or Cue answers the moment it is touched; a key press (a click with no pointer) does the same.
const press = (el, fn) => { el.addEventListener('pointerdown', fn); el.addEventListener('click', (e) => { if (e.detail === 0) fn(e); }); };
const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch {} };

export class Controller {
  // onName: the deck letter was pressed (on a phone it switches between the decks)
  constructor(root, deck, { onName } = {}) {
    this.root = root; this.deck = deck; this.pick = null; this.frame = 0;
    this.reset();

    const name = button('dx-name', deck.name, 'Switch deck');
    name.addEventListener('click', () => onName?.());
    this.time = make('span', 'dx-time', { textContent: '-:--' });
    this.tempo = make('b', '', { textContent: '---' });
    const tempo = make('span', 'dx-tempo', { title: 'Beats per minute at this speed' });
    tempo.append(this.tempo, make('span', 'dx-unit', { textContent: ' BPM' }));
    this.pitch = make('span', 'dx-pitch', { textContent: '+0.0%' });
    const tap = button('dx-tap', 'Tap', 'Tap on the beat four or more times to set the tempo');
    press(tap, () => this.tap());
    this.led = make('i', 'dx-led', { title: 'On the beat' });
    this.syncBtn = button('dx-sync', 'Sync', 'Match the other deck: the same tempo, with the beats together. Press again to let go.');
    press(this.syncBtn, () => this.toggleSync());
    const read = make('div', 'dx-read');
    read.append(name, this.time, this.led, tempo, this.pitch, this.syncBtn, tap);

    this.cueBtn = button('dx-cue', 'Cue', 'Stopped: set the cue point here, or hold to hear it. Playing: back to the cue point.');
    this.cueBtn.addEventListener('pointerdown', (e) => { capture(this.cueBtn, e); this.cueDown(); });
    this.cueBtn.addEventListener('click', (e) => { if (e.detail === 0) { this.cueDown(); this.cueUp(); } });
    for (const type of ['pointerup', 'pointercancel']) this.cueBtn.addEventListener(type, () => this.cueUp());
    this.playBtn = button('dx-play', 'Play');
    press(this.playBtn, () => this.play());
    const trans = make('div', 'dx-trans');
    trans.append(this.cueBtn, this.playBtn);

    this.jog = make('div', 'dx-jog', { title: 'Middle: hold and turn the record. Outer ring: speed up or slow down for a moment.' });
    this.plate = make('i', 'dx-plate');
    this.plate.append(make('u', ''));
    this.jog.append(this.plate);
    this.wire(this.jog);

    this.fader = make('input', 'dx-fader', { type: 'range', min: -PITCH, max: PITCH, step: 0.001, title: 'Pitch. Double-click to centre.' });
    this.fader.defaultValue = this.fader.value = 0;
    this.fader.setAttribute('aria-label', `${deck.name} pitch`);
    this.fader.addEventListener('input', (e) => { if (e.isTrusted) this.endSync(); deck.setPitch(+this.fader.value); });
    this.fader.addEventListener('dblclick', () => this.centre());

    const pads = make('div', 'dx-pads');
    this.padBtns = Array.from({ length: PADS }, (_, i) => {
      const b = button('dx-pad', '', 'Empty: set a hot cue here. Set: jump to it. Shift-click, right-click or hold to clear it.');
      press(b, (e) => this.pressPad(i, e));
      for (const type of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(type, () => clearTimeout(this.hold));
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      pads.append(b);
      return b;
    });
    this.drawPads();

    this.inBtn = button('dx-loop', 'In', 'Mark where a loop starts');
    press(this.inBtn, () => this.loopIn());
    this.outBtn = button('dx-loop', 'Out', 'Close the loop here. While looping: leave the loop.');
    press(this.outBtn, () => this.loopOut());
    this.beatBtns = BEATS.map((beats) => {
      const b = button('dx-loop', String(beats), `Loop ${beats} ${beats === 1 ? 'beat' : 'beats'} from here. Press again to leave it.`);
      press(b, () => this.autoLoop(beats));
      return b;
    });
    const inOut = make('div', 'dx-inout'), beats = make('div', 'dx-beats');
    inOut.append(this.inBtn, this.outBtn);
    beats.append(...this.beatBtns);
    const loops = make('div', 'dx-loops');
    loops.append(make('span', 'dx-cap', { textContent: 'Loop' }), inOut, beats);
    const side = make('div', 'dx-side');
    side.append(pads, loops);

    root.replaceChildren(read, trans, this.jog, this.fader, side);
  }

  // A new record: nothing marked on the last one means anything on this one.
  reset() {
    this.cue = null; this.loop = null; this.inPoint = null; this.preview = false; this.track = null;
    this.pads = new Array(PADS).fill(null); this.tapped = new Map(); this.anchors = new Map(); this.taps = []; this.bend = 0; this.grip = null;
  }

  centre() { this.fader.value = this.fader.defaultValue; this.fader.dispatchEvent(new Event('input')); }
  // Back to one deck with its controller put away: nothing is left on screen to undo these with.
  release() { this.endSync(); this.centre(); this.endLoop(); }

  // ---------- Play and Cue ----------
  play() {
    if (this.preview) { this.preview = false; return; }   // holding Cue and pressing Play: it stays playing when Cue is let go
    this.deck.transport();
  }
  home() { return this.cue ?? this.deck.tracks[0]?.theta0; }
  cueDown() {
    const d = this.deck, home = this.home();
    if (home == null) return d.openShelf();
    const pos = d.position();
    if (d.motor || pos == null || d.fresh) { this.endLoop(); this.cue = home; d.jumpTo(home, true); }
    else if (Math.abs(pos - home) < AT_CUE) { this.preview = true; d.transport(); }
    else this.cue = pos;                                  // stopped somewhere new: this is the cue point now
  }
  cueUp() {
    if (!this.preview) return;
    this.preview = false;
    this.deck.jumpTo(this.home(), true);
  }

  // ---------- hot cues ----------
  pressPad(i, e) {
    const d = this.deck, at = this.pads[i];
    if (e.button === 2 || e.shiftKey) return this.clearPad(i);
    if (at == null) {
      const pos = d.position();
      if (pos == null) { if (!d.loaded) d.openShelf(); return; }
      this.pads[i] = pos;
      return this.drawPads();
    }
    this.preview = false;
    d.startAt(at);
    clearTimeout(this.hold);
    if (e.pointerType === 'touch') this.hold = setTimeout(() => this.clearPad(i), HOLD_MS);
  }
  clearPad(i) { this.pads[i] = null; this.drawPads(); }
  drawPads() {
    this.padBtns.forEach((b, i) => {
      const at = this.pads[i], k = at == null ? null : this.deck.tracks.find((t) => at < t.theta1);
      b.textContent = at == null ? `Cue ${i + 1}` : fmt(Math.max(0, at - (k?.theta0 ?? 0)) / W33);
      b.classList.toggle('set', at != null);
    });
  }

  // ---------- loops ----------
  setLoop(a, b, beats = null) { this.loop = { a, b, beats }; this.deck.setLoop(a, b); }
  endLoop() { if (this.loop) { this.loop = null; this.deck.setLoop(); } }
  autoLoop(beats) {
    if (this.loop?.beats === beats) return this.endLoop();
    const d = this.deck, pos = d.position();
    if (pos == null) return;
    const on = this.beat(), a = this.loop ? this.loop.a : on ? pos - on.phase * on.per : pos, b = a + beats * W33 * 60 / (this.bpm() ?? GUESS_BPM);   // resizing a loop keeps its start; a new one starts on the beat just gone, so it keeps time
    this.setLoop(a, b, beats);
    if (pos >= b) d.jumpTo(a + (pos - a) % (b - a));
  }
  loopIn() {
    const pos = this.deck.position();
    if (pos != null) { this.endLoop(); this.inPoint = pos; }
  }
  loopOut() {
    if (this.loop) return this.endLoop();
    const pos = this.deck.position();
    if (pos != null && this.inPoint != null && pos > this.inPoint + AT_CUE) { this.setLoop(this.inPoint, pos); this.deck.jumpTo(this.inPoint); }
  }

  // ---------- tempo ----------
  // beats per minute as the record was cut: tapped in, or measured from the groove; null if neither
  bpm() { const k = this.track ?? this.deck.tracks[0]; return k ? this.tapped.get(k) ?? k.bpm ?? null : null; }
  tap() {
    const now = performance.now(), T = this.taps, k = this.track ?? this.deck.tracks[0];
    if (T.length && now - T[T.length - 1] > TAP_GAP_MS) T.length = 0;
    T.push(now);
    if (T.length > TAPS) T.shift();
    if (k && T.length >= 4) this.tapped.set(k, 60000 * (T.length - 1) / (now - T[0]) / this.deck.tempoRatio);
    const pos = this.deck.position();
    if (k && pos != null) this.anchors.set(k, pos);       // a tap is on the beat, so the beats can be counted from here
  }
  // The tempo at the speed the deck is running at now, or null.
  speedBpm() { const b = this.bpm(); return b ? b * this.deck.tempoRatio : null; }
  // Where this deck is in its beat, 0 on the beat and just under 1 right before the next, or null when that is not known.
  beat() {
    const d = this.deck, pos = d.position();
    if (pos == null) return null;
    const k = d.tracks.find((t) => pos >= t.theta0 && pos < t.theta1), bpm = k && (this.tapped.get(k) ?? k.bpm), zero = k && (this.anchors.get(k) ?? k.beat0);
    if (!bpm || zero == null) return null;
    const per = W33 * 60 / bpm, turns = (pos - zero) / per;
    return { phase: turns - Math.floor(turns), per, pos };
  }

  // ---------- Sync: this deck follows the other ----------
  // What the pitch would have to be to match the other deck, and which of half, the same or double tempo is nearest. Null if a tempo is unknown.
  sought() {
    const theirs = this.partner?.speedBpm(), mine = this.bpm();
    if (!theirs || !mine) return null;
    const base = mine * this.deck.S.rpm / 33.3333;
    return [0.5, 1, 2].map((m) => ({ m, pitch: theirs * m / base - 1 })).reduce((a, b) => (Math.abs(b.pitch) < Math.abs(a.pitch) ? b : a));
  }
  toggleSync() {
    if (this.synced) return this.endSync();
    const want = this.sought();
    if (!want) return this.note('needs a tempo on both decks: tap one in');
    if (Math.abs(want.pitch) > PITCH) return this.note(`too far apart: this deck would need ${want.pitch > 0 ? '+' : ''}${(want.pitch * 100).toFixed(1)}%`);
    if (this.partner.synced) this.partner.endSync();
    this.note('');
    this.synced = { m: want.m, snap: true };
    this.setPitch(want.pitch);
    this.syncBtn.classList.add('on');
  }
  endSync() {
    if (!this.synced) return;
    this.synced = null; this.syncBtn.classList.remove('on'); this.deck.setLock(0);
  }
  note(msg) { clearTimeout(this.noted); this.deck.say(msg); if (msg) this.noted = setTimeout(() => this.deck.say(''), NOTE_MS); }
  setPitch(pitch) { this.fader.value = pitch; this.fader.dispatchEvent(new Event('input')); this.deck.setPitch(pitch); }   // the slider rounds; the deck does not
  // Keeps following: the other deck's tempo, and then its beats, by very small changes of speed.
  follow() {
    const s = this.synced, d = this.deck;
    if (!s) return;
    const other = this.partner;
    if (!other) return this.endSync();
    const want = this.sought();
    if (want && Math.abs(want.m / s.m - 1) < 1e-6 && Math.abs(want.pitch) <= PITCH && Math.abs(want.pitch - d.S.pitch) > 1e-5) this.setPitch(want.pitch);
    const a = this.beat(), b = other.beat(), hand = this.grip || other.grip || d.S.grabbed || other.deck.S.grabbed;
    if (!a || !b || hand || !d.motor || !other.deck.motor) { d.setLock(0); return; }
    const e = s.m >= 1 ? wrap(b.phase * s.m - a.phase) : wrap(b.phase - a.phase / s.m) * s.m;
    if (s.snap) {
      s.snap = false;
      if (Math.abs(e) > SNAP) { d.jumpTo(a.pos + e * a.per); d.setLock(0); return; }
    }
    d.setLock(Math.abs(e) < LOCK_DEAD ? 0 : clamp(e * LOCK_GAIN, -LOCK_MAX, LOCK_MAX));
  }

  // ---------- the jog wheel: the middle is the record under a hand, the outer ring nudges the speed ----------
  wire(jog) {
    const d = this.deck;
    const polar = (e) => {
      const r = jog.getBoundingClientRect(), x = e.clientX - r.left - r.width / 2, y = e.clientY - r.top - r.height / 2;
      return { ang: Math.atan2(y, x), out: Math.hypot(x, y) / (r.width / 2) };
    };
    jog.addEventListener('pointerdown', (e) => {
      if (!d.loaded) return;
      capture(jog, e);
      const p = polar(e), ring = p.out > RING;
      this.grip = { ang: p.ang, t: performance.now(), ring };
      jog.classList.add(ring ? 'nudging' : 'held');
      if (!ring) d.send({ t: 'platter', on: true });
    });
    jog.addEventListener('pointermove', (e) => {
      const g = this.grip;
      if (!g) return;
      const { ang } = polar(e), now = performance.now();
      let turn = ang - g.ang;
      if (turn > Math.PI) turn -= TAU; else if (turn < -Math.PI) turn += TAU;
      g.ang = ang;
      if (!g.ring) return d.send({ t: 'platterMove', d: turn });       // clockwise on screen is forwards, as on the record
      if (now === g.t) return;
      this.bend = clamp(NUDGE * turn / ((now - g.t) / 1000), -BEND_MAX, BEND_MAX);
      g.t = now;
      d.setBend(this.bend);
    });
    const letGo = () => {
      const g = this.grip;
      if (!g) return;
      this.grip = null;
      jog.classList.remove('nudging', 'held');
      if (g.ring) { this.bend = 0; d.setBend(0); } else d.send({ t: 'platter', on: false });
    };
    for (const type of ['pointerup', 'pointercancel']) jog.addEventListener(type, letGo);
  }

  // ---------- each frame ----------
  readout(pos) {
    const d = this.deck, k = pos == null ? null : d.tracks.find((t) => pos >= t.theta0 && pos < t.theta1);
    if (k) this.track = k;
    this.time.textContent = k ? `${fmt((pos - k.theta0) / W33)} / ${fmt((k.theta1 - k.theta0) / W33)}` : '-:--';
    const bpm = this.bpm();
    this.tempo.textContent = bpm ? (bpm * d.tempoRatio).toFixed(1) : '---';
    const pct = (+this.fader.value + this.bend) * 100;
    this.pitch.textContent = `${pct < 0 ? '' : '+'}${pct.toFixed(1)}%`;
  }
  tick() {
    const d = this.deck;
    if (d.pick !== this.pick) { this.pick = d.pick; this.reset(); this.endLoop(); this.endSync(); this.drawPads(); }
    const beat = this.beat();
    this.led.classList.toggle('on', !!beat && d.motor && beat.phase < FLASH);
    const turned = d.S.pose?.thp;
    if (turned != null) this.plate.style.transform = `rotate(${turned % TAU}rad)`;
    if (this.bend && !this.grip?.ring) { this.bend = 0; d.setBend(0); }
    else if (this.bend && performance.now() - this.grip.t > 70) { this.bend *= 0.8; d.setBend(this.bend); }   // the ring has stopped turning under the hand
    const playing = d.motor;
    if (playing !== this.playing) { this.playing = playing; this.playBtn.classList.toggle('on', playing); this.playBtn.textContent = playing ? 'Stop' : 'Play'; }
    if (this.frame++ % 6) return;
    this.follow();
    const pos = d.position();
    if (this.loop && pos != null && (pos < this.loop.a - LOOP_MARGIN || pos > this.loop.b + LOOP_MARGIN)) this.endLoop();   // a hot cue or a hand took it out of the loop
    this.cueBtn.classList.toggle('on', this.preview || (!playing && pos != null && Math.abs(pos - (this.home() ?? Infinity)) < AT_CUE));
    this.inBtn.classList.toggle('on', this.inPoint != null && !this.loop);
    this.outBtn.classList.toggle('on', !!this.loop);
    this.beatBtns.forEach((b, i) => b.classList.toggle('on', this.loop?.beats === BEATS[i]));
    this.readout(pos);
  }
}
