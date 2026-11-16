// Seeing a like on the phone's own screen: the like button turning red. The
// Chrome version's copy of eye/hearts.py (where it's described): change both
// together. Frames are RGBA Mats.

import { cvLib, withMats } from './imaging.js';
import { STILL_SIZE, rotated } from './sampler.js';

const PATCH = 24; // the square, straightened, in pixels

// Frame pixels to the upright screen (STILL_SIZE pixels), as the sampler straightens it: a 3×3 array.
export function screenTransform(quad, rotate) {
  const cv = cvLib();
  return withMats((mat, keep) => {
    const [width, height] = STILL_SIZE;
    const corners = keep(cv.matFromArray(4, 1, cv.CV_32FC2, rotated(quad, rotate).flat()));
    const upright = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1]));
    const transform = keep(cv.getPerspectiveTransform(corners, upright));
    return [0, 1, 2].map((r) => [0, 1, 2].map((c) => transform.data64F[r * 3 + c]));
  });
}

const multiply = (a, b) => a.map((row) => [0, 1, 2].map((c) => row.reduce((sum, v, k) => sum + v * b[k][c], 0)));
const apply = (m, [x, y]) => {
  const w = m[2][0] * x + m[2][1] * y + m[2][2];
  return [(m[0][0] * x + m[0][1] * y + m[0][2]) / w, (m[1][0] * x + m[1][1] * y + m[1][2]) / w];
};
function invert(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

// A point clicked on the camera picture (fractions of it) as fractions of the upright screen, or null if it's off the screen.
export function pointOnScreen(point, frameSize, quad, rotate) {
  const [u, v] = apply(screenTransform(quad, rotate), [point[0] * frameSize[0], point[1] * frameSize[1]]);
  const fu = u / (STILL_SIZE[0] - 1);
  const fv = v / (STILL_SIZE[1] - 1);
  if (!(fu >= 0 && fu <= 1 && fv >= 0 && fv <= 1)) return null;
  return [Math.round(fu * 1e4) / 1e4, Math.round(fv * 1e4) / 1e4];
}

export class HeartWatcher {
  constructor(settings) {
    this.settings = settings;
    this.button = null; // on the upright screen, as fractions
    this.state = null;  // red or outline, once learnt for the reel on screen
    this.share = 0;
    this.box = null;    // the square's corners on the camera picture, for the detection view
    this.likes = 0;
    this.reading = null;
    this.count = 0;
    this.since = 0;
    this.anchor = null; // the phone's outline when the button was last read
  }

  setButton(button) {
    this.button = button ? [Number(button[0]), Number(button[1])] : null;
    this.reset();
  }

  // A new reel (or a new button): its state is learnt afresh, not taken as a like.
  reset() {
    this.state = null;
    this.reading = null;
    this.count = 0;
    this.anchor = null;
  }

  // The outline has moved since the button was last read: the square may be off the button.
  drifted(quad) {
    if (this.anchor === null) return false;
    const diagonal = Math.hypot(this.anchor[2][0] - this.anchor[0][0], this.anchor[2][1] - this.anchor[0][1]);
    const moved = Math.max(...quad.flatMap(([x, y], i) => [Math.abs(x - this.anchor[i][0]), Math.abs(y - this.anchor[i][1])]));
    return moved > this.settings.max_drift * diagonal;
  }

  // How much of the square round the button is the heart's red (0-1).
  look(frame, quad, rotate) {
    const cv = cvLib();
    const side = this.settings.box * STILL_SIZE[0];
    const cx = this.button[0] * (STILL_SIZE[0] - 1);
    const cy = this.button[1] * (STILL_SIZE[1] - 1);
    const x0 = cx - side / 2;
    const y0 = cy - side / 2;
    const scale = PATCH / side;
    const transform = multiply([[scale, 0, -x0 * scale], [0, scale, -y0 * scale], [0, 0, 1]], screenTransform(quad, rotate));
    const back = invert(transform);
    this.box = [[0, 0], [PATCH, 0], [PATCH, PATCH], [0, PATCH]].map((corner) => apply(back, corner));
    const [low, high] = this.settings.red_hues;
    const { min_saturation: minSaturation, min_value: minValue } = this.settings;
    return withMats((mat, keep) => {
      const patch = mat();
      const m = keep(cv.matFromArray(3, 3, cv.CV_64F, transform.flat()));
      cv.warpPerspective(frame, patch, m, new cv.Size(PATCH, PATCH), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
      const rgb = mat();
      cv.cvtColor(patch, rgb, cv.COLOR_RGBA2RGB);
      const hsv = mat();
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      let red = 0;
      for (let i = 0; i < hsv.data.length; i += 3) {
        const [hue, saturation, value] = [hsv.data[i], hsv.data[i + 1], hsv.data[i + 2]];
        if ((hue >= low || hue <= high) && saturation >= minSaturation && value >= minValue) red += 1;
      }
      return red / (PATCH * PATCH);
    });
  }

  // One frame. still: the screen isn't moving (no swipe under way). Returns like and unlike events.
  process(frame, quad, rotate, t, still, landedAt) {
    if (this.button === null || quad === null) {
      this.box = null;
      return [];
    }
    this.share = this.look(frame, quad, rotate);
    const settings = this.settings;
    if (!still || (landedAt !== null && landedAt !== undefined && t - landedAt < settings.settle_seconds)
        || this.drifted(quad)) {
      this.reading = null;
      this.count = 0;
      return [];
    }
    const reading = this.share >= settings.red_share ? 'red' : this.share <= settings.outline_share ? 'outline' : null;
    if (reading === null) return [];
    if (reading !== this.reading) {
      this.reading = reading;
      this.count = 0;
      this.since = t;
    }
    this.count += 1;
    if (this.count < settings.frames) return [];
    if (this.anchor === null) this.anchor = quad.map(([x, y]) => [Number(x), Number(y)]);
    if (reading === this.state) return [];
    if (this.state === null) {
      this.state = reading; // the reel's button as it was when it landed: learnt, not a like
      return [];
    }
    this.state = reading;
    if (reading === 'red') this.likes += 1;
    return [{ type: reading === 'red' ? 'like' : 'unlike', source: 'heart', t: this.since }];
  }
}
