// AudioWorklet wrapper around the mixer's audio. Two stereo inputs (one per deck); outputs: what the speakers get, and the mix alone for recording.
import { Desk } from './desk.js';

const METER_FRAMES = 1536;           // about 30 readings a second

class DeskNode extends AudioWorkletProcessor {
  constructor() {
    super();
    this.desk = new Desk(sampleRate); this.count = 0;
    this.port.onmessage = ({ data }) => { if (data.end) this.ended = true; else this.desk.set(data); };
  }
  process([a, b], [out, rec]) {
    if (this.ended) return false;
    this.desk.process(a, b, out, rec);
    if ((this.count += out[0].length) >= METER_FRAMES) { this.count = 0; this.port.postMessage(this.desk.meters()); }
    return true;
  }
}
registerProcessor('desk', DeskNode);
