// Stills of the reels a visitor watches, for the reel face. The Chrome
// version's copy of eye/reel_sampler.py (where it's described): change both
// together.
//
// The watcher hands over the camera frame and the phone screen's corners a
// few times a second; this straightens the screen into an upright still.
// When a reel is swiped away, the stills taken while it was on screen become
// that reel's record, if it was watched long enough. Held in memory for the
// visit, never saved. Stills are ImageData (RGBA), colours [r, g, b].

import { cvLib, roundEven, toImageData, withMats } from './imaging.js';

export const STILL_SIZE = [270, 480]; // width, height: an upright phone screen, 9:16
const CANDIDATES = 12;                 // stills kept while one reel plays (thinned out evenly when it plays long)

// The corners turned so the screen's top comes first (np.roll of the quad).
export function rotated(quad, rotate) {
  const shift = (((-Math.floor(rotate / 90)) % 4) + 4) % 4;
  return quad.map((_, i) => quad[(((i - shift) % 4) + 4) % 4]);
}

export class ReelSampler {
  constructor(settings, rotate, onReel) {
    this.settings = settings;
    this.rotate = rotate;
    this.onReel = onReel;
    this.lastOffer = -1e9;
    this.clear();
  }

  clear() {
    this.stills = []; // [time, still] for the reel on screen now
    this.reelSince = null;
    this.count = 0;
  }

  // A camera frame (an RGBA Mat) with the phone screen in it.
  offerFrame(frame, quad, t) {
    if (t - this.lastOffer < this.settings.sample_seconds) return;
    this.lastOffer = t;
    this.takeStill(frame, quad, t);
  }

  // A reel was swiped away.
  offerSwipe(swipe) {
    this.reelEnded(swipe);
  }

  // A new visit: forget the reel on screen and count from 1 again.
  reset() {
    this.clear();
  }

  takeStill(frame, quad, t) {
    const cv = cvLib();
    if (this.reelSince === null) this.reelSince = t;
    const [width, height] = STILL_SIZE;
    const still = withMats((mat, keep) => {
      const corners = keep(cv.matFromArray(4, 1, cv.CV_32FC2, rotated(quad, this.rotate).flat()));
      const upright = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1]));
      const transform = keep(cv.getPerspectiveTransform(corners, upright));
      const out = mat();
      cv.warpPerspective(frame, out, transform, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
      return toImageData(out);
    });
    this.stills.push([t, still]);
    if (this.stills.length > CANDIDATES) this.stills = this.stills.filter((_, i) => i % 2 === 0); // keep them spread across the reel
  }

  reelEnded(swipe) {
    const ended = swipe.t; // when the swipe began
    const started = swipe.dwell !== null && swipe.dwell !== undefined ? ended - swipe.dwell : this.reelSince;
    const stills = this.stills;
    this.stills = [];
    this.reelSince = swipe.detected_at;
    if (started === null || ended - started < this.settings.min_watch_seconds) return; // scrolled past, not watched
    // Only stills from while it sat still on screen, not mid-swipe.
    const during = stills.filter(([t]) => started + 0.2 <= t && t <= ended - 0.1).map(([, still]) => still);
    let usable = during.filter(isUsable);
    const wanted = this.settings.stills_per_reel;
    if (usable.length > wanted) {
      const picks = Array.from({ length: wanted }, (_, i) => roundEven(wanted === 1 ? 0 : (i * (usable.length - 1)) / (wanted - 1)));
      usable = picks.map((i) => usable[i]);
    }
    const colour = mainColour(usable.length ? usable : during.length ? during : stills.map(([, still]) => still));
    this.count += 1;
    this.onReel({ number: this.count, started, watched: Math.round((ended - started) * 100) / 100, stills: usable, colour });
  }
}

// Not black, and not one flat colour.
function isUsable(still) {
  const cv = cvLib();
  return withMats((mat, keep) => {
    const gray = mat();
    cv.cvtColor(keep(cv.matFromImageData(still)), gray, cv.COLOR_RGBA2GRAY);
    const mean = mat();
    const deviation = mat();
    cv.meanStdDev(gray, mean, deviation);
    return mean.data64F[0] > 20 && deviation.data64F[0] > 10;
  });
}

function median(values) {
  values.sort((a, b) => a - b);
  const middle = values.length >> 1;
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

export function mainColour(stills) {
  if (!stills.length) return [90, 90, 90];
  const cv = cvLib();
  const channels = [[], [], []];
  for (const still of stills) {
    withMats((mat, keep) => {
      const small = mat();
      cv.resize(keep(cv.matFromImageData(still)), small, new cv.Size(27, 48), 0, 0, cv.INTER_AREA);
      for (let i = 0; i < small.data.length; i += 4) for (let c = 0; c < 3; c++) channels[c].push(small.data[i + c]);
    });
  }
  return channels.map((values) => Math.trunc(median(values)));
}

// An OpenCV HSV colour (hue 0-180) as CSS.
function hsv(hue, saturation, value) {
  const cv = cvLib();
  return withMats((mat, keep) => {
    const rgb = mat();
    cv.cvtColor(keep(cv.matFromArray(1, 1, cv.CV_8UC3, [hue, saturation, value])), rgb, cv.COLOR_HSV2RGB);
    return `rgb(${rgb.data[0]}, ${rgb.data[1]}, ${rgb.data[2]})`;
  });
}

// A made-up still: bold colour, stripes, a shape, "TEST" and "REEL n".
function invented(number, random, take) {
  const [width, height] = STILL_SIZE;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const hue = (number * 37 + take * 6) % 180;
  ctx.fillStyle = hsv(hue, 200, 230);
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = hsv((hue + 90) % 180, 220, 160);
  for (let stripe = 0; stripe < height; stripe += 48) ctx.fillRect(0, stripe, width, 11);
  const x = random.integers(60, width - 60);
  const y = random.integers(120, height - 120);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(x, y, random.integers(40, 110), 0, 2 * Math.PI);
  ctx.fill();
  ctx.fillStyle = 'rgb(20, 20, 20)';
  ctx.font = 'bold 44px sans-serif';
  ctx.fillText('TEST', 20, 70);
  ctx.fillText(`REEL ${number}`, 20, height - 40);
  return ctx.getImageData(0, 0, width, height);
}

// A made-up reel, for trying the reel face without a phone.
export function testReel(number, t, random) {
  const stills = [0, 1, 2].map((take) => invented(number, random, take));
  return { number, started: t, watched: Math.round(random.uniform(1.5, 7.0) * 100) / 100, stills, colour: mainColour(stills) };
}
