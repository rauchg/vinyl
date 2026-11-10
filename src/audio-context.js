// The one audio context on the page. Both decks and the mixer share it, so they run off one clock.
let ctx = null;
export const audioContext = () => (ctx ||= new AudioContext({ latencyHint: 'interactive' }));
