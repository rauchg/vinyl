// The page around the turntable (turntable.js): the status line, the shared buttons, and the frame loop.
import { createTurntable } from './turntable.js';
import { stylusXY } from './geometry.js';

const $ = (id) => document.getElementById(id);
// ?og renders just the deck on black, with no interface and no audio: it is how og.png (the share image) is made
const OG = new URLSearchParams(location.search).has('og');
if (OG) document.documentElement.classList.add('og');

const say = (name, msg) => { $('status').textContent = msg; };   // empty when nothing is happening
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

const A = createTurntable({ og: OG, say, guard });

// tapping anywhere outside an open panel closes it, and that tap does nothing else (it won't drop the needle
// or grab the record), so the toggles and a tap on the scene both work as open / close; so does Escape
const openPanels = () => A.panels.filter(([panel]) => !panel.hidden);
addEventListener('pointerdown', (e) => {
  let closed = false;
  for (const [panel, btn] of openPanels()) if (!panel.contains(e.target) && !btn.contains(e.target)) { btn.click(); closed = true; }
  if (closed && e.target === A.canvas) e.stopPropagation();
}, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape') for (const [, btn] of openPanels()) btn.click(); });
$('t-reset').addEventListener('click', () => A.resetView());
$('b-more').addEventListener('click', () => { $('more').showModal(); $('more').scrollTop = 0; });
$('more').addEventListener('click', (e) => { if (e.target === $('more')) $('more').close(); });   // click outside closes
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); A.cutFiles(e.dataTransfer.files); });
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  A.onKey(e);
});

let resetShown = false;
function tick() {
  requestAnimationFrame(tick);      // first, so nothing below can end the loop
  A.tick();
  if (A.moved !== resetShown) { resetShown = A.moved; $('t-reset').hidden = !resetShown; }
}
tick();
window.__rp = { S: A.S, get ctx() { return A.ctx; }, send: A.send, renderer: A.renderer, stylusXY };   // debugging handle
