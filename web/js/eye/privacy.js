// What anything sees of a capture: the reel, never the phone's own words.
// The Chrome version's copy of eye/privacy.py (where it's described): change
// both together. Pictures are ImageData (RGBA).

import { cvLib, encodeJpeg, toImageData, withMats } from './imaging.js';

const TEXT_PAD = 4; // pixels round each blurred line of text

// Python's round() for the crop's edges (half to even) only matters exactly on .5; Math.round is close enough there.
const edge = (value) => Math.round(value);

// The upright screen with its edges cut away (each a fraction of the screen).
export function crop(still, edges) {
  const { width, height } = still;
  const top = edge(height * edges.top);
  const bottom = Math.max(top + 1, edge(height * (1 - edges.bottom)));
  const left = edge(width * edges.left);
  const right = Math.max(left + 1, edge(width * (1 - edges.right)));
  const out = new ImageData(right - left, bottom - top);
  for (let y = top; y < bottom; y++) {
    out.data.set(still.data.subarray((y * width + left) * 4, (y * width + right) * 4), (y - top) * (right - left) * 4);
  }
  return out;
}

// Boxes [x, y, w, h] round what looks like lines of text.
export function textBoxes(image) {
  const cv = cvLib();
  return withMats((mat, keep) => {
    const { width, height } = image;
    const gray = mat();
    cv.cvtColor(keep(cv.matFromImageData(image)), gray, cv.COLOR_RGBA2GRAY);
    const gradient = mat();
    const round3 = keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3)));
    cv.morphologyEx(gray, gradient, cv.MORPH_GRADIENT, round3);
    const strokes = mat();
    cv.threshold(gradient, strokes, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    if (cv.countNonZero(strokes) > 0.5 * width * height) return []; // all texture, no strokes to speak of
    const lines = mat();
    const wide = keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 1)));
    cv.morphologyEx(strokes, lines, cv.MORPH_CLOSE, wide);
    const contours = keep(new cv.MatVector());
    const hierarchy = mat();
    cv.findContours(lines, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const boxes = [];
    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const { x, y, width: w, height: h } = cv.boundingRect(contour);
      contour.delete();
      if (!(h >= 4 && h <= 0.12 * height && w >= 2 * h && w >= 12)) continue;
      const region = strokes.roi(new cv.Rect(x, y, w, h));
      const filled = cv.countNonZero(region) / (w * h);
      region.delete();
      if (filled >= 0.25) boxes.push([x, y, w, h]);
    }
    return boxes;
  });
}

// A still made safe to look at: the edges cut away and text blurred (capture settings).
export function makePrivate(still, settings) {
  const image = crop(still, settings.crop);
  if (settings.blur_text === false) return image;
  const boxes = textBoxes(image);
  if (!boxes.length) return image;
  const cv = cvLib();
  return withMats((mat, keep) => {
    const picture = keep(cv.matFromImageData(image));
    for (const [x, y, w, h] of boxes) {
      const x0 = Math.max(0, x - TEXT_PAD);
      const y0 = Math.max(0, y - TEXT_PAD);
      const x1 = Math.min(image.width, x + w + TEXT_PAD);
      const y1 = Math.min(image.height, y + h + TEXT_PAD);
      const region = picture.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
      cv.GaussianBlur(region, region, new cv.Size(0, 0), 6);
      region.delete();
    }
    return toImageData(picture);
  });
}

// How sharp a still is: the variance of its Laplacian.
export function sharpness(still) {
  const cv = cvLib();
  return withMats((mat, keep) => {
    const gray = mat();
    cv.cvtColor(keep(cv.matFromImageData(still)), gray, cv.COLOR_RGBA2GRAY);
    const edges = mat();
    cv.Laplacian(gray, edges, cv.CV_64F);
    const mean = mat();
    const deviation = mat();
    cv.meanStdDev(edges, mean, deviation);
    return deviation.data64F[0] ** 2;
  });
}

// A tiny, degraded JPEG (a Blob): enough to recognise what kind of picture it was, no more.
export function thumbnail(image, width) {
  const cv = cvLib();
  const small = withMats((mat, keep) => {
    const out = mat();
    const height = Math.max(1, Math.round((image.height * width) / image.width));
    cv.resize(keep(cv.matFromImageData(image)), out, new cv.Size(width, height), 0, 0, cv.INTER_AREA);
    return toImageData(out);
  });
  return encodeJpeg(small, 35);
}
