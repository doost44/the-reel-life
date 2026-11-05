// The Chrome version's swipe detector (web/js/eye/detector.js), run in Node on
// frames from tools/check_browser_eye.py. Not for running on its own.
//
// Reads from stdin: one line of JSON ({"width", "height", "detection"}), then
// for each frame its time (8 bytes, a little-endian double) and its pixels
// (width × height × 3 bytes, BGR). Writes one line of JSON per event.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const cv = require(`${root}web/vendor/opencv/opencv.js`);
// Its `then` resolves to itself, so it can't be awaited: wait for it to start instead.
await new Promise((resolve) => (cv.Mat ? resolve() : (cv.onRuntimeInitialized = resolve)));
globalThis.cv = cv;
const { Detector } = await import(`${root}web/js/eye/detector.js`);

const chunks = [];
let buffered = 0;
let header = null;
let detector = null;
let frameBytes = 0;
let frames = 0;
let busy = 0;

function take(count) {
  const out = Buffer.alloc(count);
  let at = 0;
  while (at < count) {
    const chunk = chunks[0];
    const used = Math.min(chunk.length, count - at);
    chunk.copy(out, at, 0, used);
    at += used;
    if (used === chunk.length) chunks.shift();
    else chunks[0] = chunk.subarray(used);
  }
  buffered -= count;
  return out;
}

function work() {
  if (!header) {
    const all = Buffer.concat(chunks);
    const end = all.indexOf(10);
    if (end < 0) return;
    header = JSON.parse(all.subarray(0, end).toString());
    chunks.length = 0;
    chunks.push(all.subarray(end + 1));
    buffered = all.length - end - 1;
    detector = new Detector(header.detection);
    if (header.zone) detector.lock(header.zone);
    frameBytes = 8 + header.width * header.height * 3;
  }
  const bgr = new cv.Mat(header.height, header.width, cv.CV_8UC3);
  const rgba = new cv.Mat();
  while (buffered >= frameBytes) {
    const frame = take(frameBytes);
    const t = frame.readDoubleLE(0);
    bgr.data.set(frame.subarray(8));
    cv.cvtColor(bgr, rgba, cv.COLOR_BGR2RGBA);
    const started = performance.now();
    for (const event of detector.process(rgba, t)) process.stdout.write(`${JSON.stringify(event)}\n`);
    busy += performance.now() - started;
    frames += 1;
  }
  bgr.delete();
  rgba.delete();
}

process.stdin.on('data', (chunk) => {
  chunks.push(chunk);
  buffered += chunk.length;
  work();
});
process.stdin.on('end', () => {
  work();
  process.stdout.write(`${JSON.stringify({ type: 'done', frames, ms_per_frame: frames ? busy / frames : 0 })}\n`);
});
