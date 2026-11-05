// Runs the swipe detector on the detection camera's frames and hands phone
// and swipe events to the eye. The Chrome version's copy of eye/watcher.py.
//
// It also makes the detection view: the camera picture with the phone
// outline, the straightened screen and live numbers, which pages show like a
// camera called "@detection". And it passes frames and swipes on to the reel
// sampler (the reel face's stills).

import { Detector, WARP_HEIGHT, WARP_WIDTH } from './detector.js';
import { cvLib, withMats } from './imaging.js';

export const DETECTION_VIEW = '@detection';
const VIEW_EVERY = 1 / 15; // the view only needs to be watchable, not every frame

export class SwipeWatcher {
  constructor(settings, onEvent, sampler) {
    this.settings = settings;
    this.onEvent = onEvent;
    this.sampler = sampler;
    this.detector = new Detector(settings);
    this.cameraName = '';
    this.frameSize = [0, 0];
    this.viewAt = -1e9;
    this.viewBusy = false;
  }

  // The camera to watch, and the phone's locked corners (or null to find it).
  watch(cameraName, zone) {
    if ((cameraName ?? '') !== this.cameraName) {
      this.detector.dispose();
      this.detector = new Detector(this.settings); // a different camera starts from nothing
      this.cameraName = cameraName ?? '';
    }
    this.detector.lock(zone);
  }

  info() {
    const detector = this.detector;
    return {
      camera: this.cameraName,
      present: detector.present,
      zone: detector.zone !== null ? 'locked' : 'auto',
      found: detector.quad !== null,
      swipes: detector.swipes,
      last: detector.lastSwipe,
      recording: null,
      recording_folder: null,
    };
  }

  // One frame (an RGBA Mat) that arrived at t. view(blob) gets the detection view when one's wanted.
  process(frame, t, wantView, view) {
    this.frameSize = [frame.cols, frame.rows];
    for (const event of this.detector.process(frame, t)) {
      this.onEvent(event);
      if (event.type === 'swipe') this.sampler?.offerSwipe(event);
    }
    if (this.sampler && this.detector.present && this.detector.quad !== null) this.sampler.offerFrame(frame, this.detector.quad, t);
    if (wantView && !this.viewBusy && t - this.viewAt >= VIEW_EVERY) {
      this.viewAt = t;
      this.viewBusy = true;
      this.debugFrame(frame, t).then(view, () => {}).finally(() => { this.viewBusy = false; });
    }
  }

  // The camera picture with the phone outline, the straightened screen and live numbers: a JPEG.
  async debugFrame(frame, t) {
    const detector = this.detector;
    const canvas = new OffscreenCanvas(frame.cols, frame.rows);
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.cols, frame.rows), 0, 0);
    if (detector.quad !== null) {
      const colour = detector.present ? 'rgb(80, 255, 80)' : 'rgb(255, 200, 0)';
      ctx.strokeStyle = colour;
      ctx.lineWidth = 2;
      ctx.beginPath();
      detector.quad.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = colour;
      ctx.beginPath();
      ctx.arc(detector.quad[0][0], detector.quad[0][1], 6, 0, 2 * Math.PI);
      ctx.fill();
    }
    if (detector.warped !== null) {
      const inset = new ImageData(WARP_WIDTH, WARP_HEIGHT);
      detector.warped.forEach((v, i) => inset.data.set([v, v, v, 255], i * 4));
      const small = new OffscreenCanvas(WARP_WIDTH, WARP_HEIGHT);
      small.getContext('2d').putImageData(inset, 0, 0);
      if (WARP_HEIGHT * 2 <= frame.rows && WARP_WIDTH * 2 <= frame.cols) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(small, frame.cols - WARP_WIDTH * 2, 0, WARP_WIDTH * 2, WARP_HEIGHT * 2);
      }
    }
    const last = detector.lastSwipe;
    const readout = detector.readout;
    const following = detector.zone !== null ? 'locked zone' : detector.quadFound ? `tracking ${Math.round(detector.tracking * 100)}%` : 'searching';
    const signed = (v, places) => `${v >= 0 ? '+' : ''}${v.toFixed(places)}`;
    const lines = [
      `phone ${detector.present ? 'IN' : 'out'}  ${following}`,
      `move ${signed(readout.step ?? 0, 3)}  clarity ${(readout.response ?? 0).toFixed(2)}`,
      `travel ${signed(readout.travel ?? 0, 2)} / ${this.settings.swipe_travel.toFixed(2)}`,
      `swipes ${detector.swipes}`,
    ];
    if (last) lines.push(`last: ${last.direction} after ${last.dwell !== null ? `${last.dwell.toFixed(1)}s` : '-'}, ${last.speed.toFixed(1)} screens/s`);
    ctx.font = '15px monospace';
    const width = Math.max(...lines.map((text) => ctx.measureText(text).width));
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.fillRect(4, 4, width + 16, 8 + lines.length * 22);
    ctx.fillStyle = '#fff';
    lines.forEach((text, row) => ctx.fillText(text, 10, 24 + row * 22));
    if (last && t - last.detected_at < 0.4) {
      ctx.font = 'bold 32px sans-serif';
      ctx.fillStyle = 'rgb(80, 255, 80)';
      ctx.fillText('SWIPE', 10, frame.rows - 16);
    }
    return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  }
}

// The capture card keeps sending frames with nothing plugged in: black, or the converter's blue screen.
export function looksLikeNoSignal(frame, flatness) {
  const cv = cvLib();
  return withMats((mat) => {
    const small = mat();
    cv.resize(frame, small, new cv.Size(80, 60), 0, 0, cv.INTER_AREA);
    const sums = [0, 0, 0];
    const squares = [0, 0, 0];
    const n = small.data.length / 4;
    for (let i = 0; i < small.data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        sums[c] += small.data[i + c];
        squares[c] += small.data[i + c] ** 2;
      }
    }
    const [red, green, blue] = sums.map((sum) => sum / n);
    const flat = Math.max(...squares.map((square, c) => Math.sqrt(Math.max(0, square / n - (sums[c] / n) ** 2)))) < flatness;
    const black = Math.max(blue, green, red) < 12;
    const converterBlue = blue > 120 && green < 60 && red < 60;
    return flat && (black || converterBlue);
  });
}
