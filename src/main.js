// The page around the turntables: one to begin with (turntable.js), and a second one and a mixer for the DJ setup.
import { createTurntable } from './turntable.js';
import { Mixer } from './mixer.js';
import { Controller } from './controller.js';
import { stylusXY } from './geometry.js';

const $ = (id) => document.getElementById(id), root = document.documentElement;
// ?og renders just the deck on black, with no interface and no audio: it is how og.png (the share image) is made
const OG = new URLSearchParams(location.search).has('og');
if (OG) root.classList.add('og');
const inDj = () => root.classList.contains('dj');

// What one turntable has on the page. A second deck gets clean copies, taken here before the first deck fills its own in.
const PARTS = ['gl', 'toggles', 'hud', 'ctl', 'shelf'].map((id) => $(id).cloneNode(true));
function copyPart(part, suffix) {
  const copy = part.cloneNode(true);
  for (const x of [copy, ...copy.querySelectorAll('*')]) {
    if (x.id) x.id += suffix;
    if (x.hasAttribute('for')) x.setAttribute('for', x.getAttribute('for') + suffix);
  }
  $(part.id).after(copy);
}

// The status line: what each deck is busy with.
const notes = new Map();
function say(name, msg) {
  if (msg) notes.set(name, msg); else notes.delete(name);
  $('status').textContent = [...notes].map(([n, m]) => (inDj() ? `${n}: ${m}` : m)).join('   ');
}
// One failing part must never stop the frame loop: that froze the picture while the sound carried on.
// The first error is shown in the status line so it can be read off a phone.
const seen = new Set();
function guard(name, fn) {
  try { fn(); } catch (err) {
    if (seen.has(name)) return;
    seen.add(name); console.error(name, err); say('page', `${name} error: ${(err && err.message) || err}`);
  }
}
addEventListener('error', (e) => { if (!seen.size) { seen.add('page'); say('page', `error: ${e.message}`); } });

let focused = null;   // the deck the keyboard works on: the one last touched
const touched = (deck) => { focused = deck; };
const makeDeck = (opts) => createTurntable({ og: OG, inDj, say, guard, touched, ...opts });
const A = focused = makeDeck({ onStart: () => { $('t-deck').hidden = $('t-pro').hidden = false; } });
const decks = [A], mixer = new Mixer($('mixer'), say);

// ---------- the deck controllers ----------
// With one deck its controller is optional; with two they are both out. On a phone only one is shown at a time.
let wantController = false;
const panels = [$('dx-a'), $('dx-b')];
const showFront = (i) => panels.forEach((p, k) => p.classList.toggle('front', k === i));
const nextFront = () => showFront(panels.findIndex((p) => p.classList.contains('front')) ? 0 : 1);
const controllers = [new Controller(panels[0], A, { onName: nextFront })];
function syncConsole() {
  const on = decks.length > 1 || wantController;
  root.classList.toggle('pro', on);
  $('console').hidden = !on;
  if (!on) controllers[0].release();
  for (const d of decks) d.pushParams();
}
$('t-pro').addEventListener('click', () => {
  wantController = !wantController;
  $('t-pro').setAttribute('aria-pressed', String(wantController));
  syncConsole();
});
panels[0].addEventListener('pointerdown', () => touched(A));
panels[1].addEventListener('pointerdown', () => touched(decks[1]));
showFront(0);

// ---------- the second deck ----------
function addDeck() {
  if (decks.length > 1) return;
  root.classList.add('dj');
  for (const part of PARTS) copyPart(part, '-b');
  $('t-deck-b').remove();
  $('t-pro-b').remove();
  const B = makeDeck({ suffix: '-b', name: 'B' });
  decks.push(B);
  B.powerUp();
  controllers.push(new Controller(panels[1], B, { onName: nextFront }));
  controllers[0].partner = controllers[1]; controllers[1].partner = controllers[0];
  panels[1].hidden = false;
  mixer.attach(decks);
  syncConsole();
  $('r-remove-b').hidden = false;
  $('b-remove-b').addEventListener('click', removeDeck);
  focused = B;
  B.openShelf();                       // it starts empty: choose what goes on it
}
function removeDeck() {
  mixer.detach();                      // first: it still works on both decks
  controllers[1].endSync(); controllers[0].endSync(); controllers[0].partner = null;
  controllers.pop();
  panels[1].hidden = true;
  panels[1].replaceChildren();
  showFront(0);
  const B = decks.pop();
  B.destroy();
  for (const part of PARTS) $(part.id + '-b').remove();
  root.classList.remove('dj');
  focused = A;
  syncConsole();
  say('B', '');
}
$('t-deck').addEventListener('click', addDeck);

// ---------- what is shared by the decks ----------
// tapping anywhere outside an open panel closes it, and that tap does nothing else (it won't drop the needle
// or grab the record), so the toggles and a tap on the scene both work as open / close; so does Escape
const openPanels = () => decks.flatMap((d) => d.panels).filter(([panel]) => !panel.hidden);
addEventListener('pointerdown', (e) => {
  let closed = false;
  for (const [panel, btn] of openPanels()) if (!panel.contains(e.target) && !btn.contains(e.target)) { btn.click(); closed = true; }
  if (closed && e.target.classList?.contains('deck-gl')) e.stopPropagation();
}, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape') for (const [, btn] of openPanels()) btn.click(); });
$('t-reset').addEventListener('click', () => decks.forEach((d) => d.resetView()));
$('b-more').addEventListener('click', () => { $('more').showModal(); $('more').scrollTop = 0; });
$('more').addEventListener('click', (e) => { if (e.target === $('more')) $('more').close(); });   // click outside closes
// a file dropped on a deck goes on that deck
const deckAt = (x, y) => decks.find((d) => { const r = d.canvas.getBoundingClientRect(); return x >= r.left && x < r.right && y >= r.top && y < r.bottom; }) || focused;
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); deckAt(e.clientX, e.clientY).cutFiles(e.dataTransfer.files); });
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  focused.onKey(e);
});

let resetShown = false;
function tick() {
  requestAnimationFrame(tick);      // first, so nothing below can end the loop
  guard('mixer', () => mixer.tick(controllers));
  for (const d of decks) d.tick();
  for (const c of controllers) guard('controller', () => c.tick());
  const moved = decks.some((d) => d.moved);
  if (moved !== resetShown) { resetShown = moved; $('t-reset').hidden = !moved; }
}
tick();
window.__rp = { S: A.S, get ctx() { return A.ctx; }, send: A.send, renderer: A.renderer, stylusXY, decks, mixer, controllers };   // debugging handle
