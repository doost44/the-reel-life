// Swipe detection: find the phone screen in the camera picture and turn its
// motion into swipes. The Chrome version's copy of eye/detector.py (where
// it's described): change both together. tools/check_browser_eye.py runs the
// two side by side on the same frames.
//
// Frames are RGBA OpenCV Mats; corners are [[x, y], ...] in frame pixels:
// top-left, top-right, bottom-right, bottom-left.

import { intersectConvexConvex } from './convex.js';
import { cvLib, roundEven, withMats } from './imaging.js';
import { PhaseCorrelator, hanningWindow } from './phase-correlate.js';
import { rotated } from './sampler.js';

export const WARP_WIDTH = 108;
export const WARP_HEIGHT = 192; // the straightened phone screen, 9:16

const norm = ([x, y]) => Math.hypot(x, y);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const scale = (a, s) => [a[0] * s, a[1] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const meanOf = (points) => scale(points.reduce(add, [0, 0]), 1 / points.length);
const sides = (quad) => [0, 1, 2, 3].map((i) => norm(sub(quad[(i + 1) % 4], quad[i])));

function median(values) {
  const sorted = Float64Array.from(values).sort();
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Shoelace area, as cv2.contourArea.
function area(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}

const pointsOf = (mat) => {
  const data = mat.type() === cvLib().CV_32SC2 ? mat.data32S : mat.data32F;
  const points = [];
  for (let i = 0; i < data.length; i += 2) points.push([data[i], data[i + 1]]);
  return points;
};

const floatMat = (points) => cvLib().matFromArray(points.length, 1, cvLib().CV_32FC2, points.flat());

function isConvex(points) {
  return withMats((_mat, keep) => cvLib().isContourConvex(keep(floatMat(points))));
}

// Intersection over union of two convex shapes.
function overlap(quad, hull) {
  if (!isConvex(quad)) return 0;
  const inter = intersectConvexConvex(quad, hull);
  const union = area(quad) + area(hull) - inter;
  return union > 0 ? inter / union : 0;
}

// A line through points, least squares (cv2.fitLine with DIST_L2, for 2D): [origin, direction].
function fitLineL2(points) {
  let x = 0, y = 0, x2 = 0, y2 = 0, xy = 0;
  for (const [px, py] of points) {
    x += px; y += py; x2 += px * px; y2 += py * py; xy += px * py;
  }
  const n = points.length;
  x /= n; y /= n; x2 /= n; y2 /= n; xy /= n;
  const t = Math.fround(Math.atan2(2 * (xy - x * y), (x2 - x * x) - (y2 - y * y)) / 2);
  return [[x, y].map(Math.fround), [Math.cos(t), Math.sin(t)].map(Math.fround)];
}

function fitLineHuber(points) {
  return withMats((mat, keep) => {
    const line = mat();
    cvLib().fitLine(keep(floatMat(points)), line, cvLib().DIST_HUBER, 0, 0.01, 0.01);
    const [vx, vy, x0, y0] = line.data32F;
    return [[x0, y0], [vx, vy]];
  });
}

// A line through the points, refitted without any more than 3 pixels off it.
function robustLine(points) {
  let [origin, direction] = fitLineHuber(points);
  const keep = points.filter((p) => Math.abs(dot(sub(p, origin), [-direction[1], direction[0]])) <= 3);
  if (keep.length >= 6 && keep.length < points.length) [origin, direction] = fitLineL2(keep);
  return [origin, direction];
}

// Where two lines (origin, direction) meet, or null if they're nearly parallel. In
// 32-bit arithmetic, as numpy does with the Python eye's float32 points: the
// tracker builds on the last frame, so the last bits matter.
function meet([p, d], [q, e]) {
  const f = Math.fround;
  const cross = f(f(d[0] * e[1]) - f(d[1] * e[0]));
  if (Math.abs(cross) < 0.2) return null;
  const s = f(f(f(f(q[0] - p[0]) * e[1]) - f(f(q[1] - p[1]) * e[0])) / cross);
  return [f(p[0] + f(s * d[0])), f(p[1] + f(s * d[1]))];
}

// The picture's brightness at points (cv2.remap, INTER_LINEAR, 8-bit, with
// its 1/32-pixel steps). Off the picture reads as bright, so it never passes for a bezel.
function sample(value, x, y) {
  const { data, cols, rows } = value;
  const X = roundEven(x * 32);
  const Y = roundEven(y * 32);
  const sx = X >> 5;
  const sy = Y >> 5;
  const fx = X & 31;
  const fy = Y & 31;
  const at = (px, py) => (px >= 0 && px < cols && py >= 0 && py < rows ? data[py * cols + px] : 255);
  const sum = at(sx, sy) * (32 - fx) * (32 - fy) + at(sx + 1, sy) * fx * (32 - fy)
    + at(sx, sy + 1) * (32 - fx) * fy + at(sx + 1, sy + 1) * fx * fy;
  return (sum * 32 + 16384) >> 15;
}

// The brightness across the edge at each point: one row per point, one column per offset outwards.
function profiles(value, points, normals, offsets) {
  return points.map((p, i) => offsets.map((offset) => sample(value, p[0] + normals[i][0] * offset, p[1] + normals[i][1] * offset)));
}

const f32 = (v) => Math.fround(v);

// Points along each side, away from the rounded corners, with the outward direction at each.
function sideSamples(quad, count) {
  const center = meanOf(quad);
  const points = [];
  const normals = [];
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const along = sub(b, a).map(f32);
    const length = f32(f32(Math.sqrt(f32(f32(along[0] * along[0]) + f32(along[1] * along[1])))) + 1e-6);
    let normal = [f32(along[1] / length), f32(-along[0] / length)];
    if (dot(normal, sub(scale(add(a, b), 0.5), center)) < 0) normal = scale(normal, -1);
    for (let k = 0; k < count; k++) {
      const share = 0.12 + ((0.88 - 0.12) * k) / (count - 1);
      points.push(add(a, scale(along, share)).map(f32));
      normals.push(normal.map(f32));
    }
  }
  return [points, normals];
}

// Share of the outline that looks like a screen's edge: clearly brighter just inside, and dark just outside.
function edgeSupport(value, quad, maxBezel) {
  const [points, normals] = sideSamples(quad, 12);
  const rows = profiles(value, points, normals, [-5, -4, -3, -2, 1, 2, 3, 4]);
  let good = 0;
  for (const row of rows) {
    const inside = median(row.slice(0, 4));
    const outside = Math.min(...row.slice(4));
    if (inside - outside > 20 && outside < maxBezel) good++;
  }
  return good / rows.length;
}

// Could this be a phone screen at some angle? Convex, corners 45°-135°, 1.3 to 3 times as long as wide.
function plausible(quad) {
  if (!isConvex(quad)) return false;
  for (let i = 0; i < 4; i++) {
    const before = quad[(i + 3) % 4];
    const corner = quad[i];
    const after = quad[(i + 1) % 4];
    const a = sub(before, corner);
    const b = sub(after, corner);
    const cosine = dot(a, b) / (norm(a) * norm(b) + 1e-6);
    const degrees = (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
    if (degrees < 45 || degrees > 135) return false;
  }
  const s = sides(quad);
  const pairs = [s[0] + s[2], s[1] + s[3]].sort((a, b) => a - b);
  const ratio = pairs[1] / Math.max(pairs[0], 1);
  return ratio >= 1.3 && ratio <= 3.0;
}

function aspect(quad) {
  const s = sides(quad);
  const pairs = [s[0] + s[2], s[1] + s[3]].sort((a, b) => a - b);
  return pairs[1] / Math.max(pairs[0], 1);
}

const roll = (quad, k) => quad.map((_, i) => quad[(((i - k) % 4) + 4) % 4]);

// Top-left, top-right, bottom-right, bottom-left at any rotation.
function orderCorners(quad) {
  const center = meanOf(quad);
  const angles = quad.map((p) => Math.atan2(p[1] - center[1], p[0] - center[0]));
  let ordered = [0, 1, 2, 3].sort((a, b) => angles[a] - angles[b] || a - b).map((i) => quad[i]);
  const s = sides(ordered);
  if (s[0] + s[2] > s[1] + s[3]) ordered = roll(ordered, -1);
  if (ordered[2][1] + ordered[3][1] < ordered[0][1] + ordered[1][1]) ordered = roll(ordered, 2);
  return ordered.map((p) => p.map(f32));
}

// Keep a short side as the top.
function portrait(quad) {
  const s = sides(quad);
  if (s[0] + s[2] <= s[1] + s[3]) return quad;
  const leftUp = roll(quad, 1);
  const rightUp = roll(quad, -1);
  return leftUp[0][1] + leftUp[1][1] <= rightUp[0][1] + rightUp[1][1] ? leftUp : rightUp;
}

// The found corners renumbered to match the current ones.
function align(found, current) {
  let best = found;
  let bestDistance = Infinity;
  for (let k = 0; k < 4; k++) {
    const candidate = roll(found, k);
    const distance = candidate.reduce((sum, p, i) => sum + norm(sub(p, current[i])), 0);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

// A believable step from one frame to the next.
function close(tracked, previous) {
  const height = norm(sub(previous[3], previous[0]));
  const size = area(tracked) / Math.max(area(previous), 1);
  const jump = Math.max(...tracked.map((p, i) => norm(sub(p, previous[i]))));
  return jump < 0.25 * height && size >= 0.7 && size <= 1.4;
}

// The combinations of k items, in order (itertools.combinations).
function* combinations(items, k, start = 0, chosen = []) {
  if (chosen.length === k) {
    yield chosen;
    return;
  }
  for (let i = start; i < items.length; i++) yield* combinations(items, k, i + 1, [...chosen, items[i]]);
}

// Corners where neighbouring edge lines meet, the lines taken in order round the shape.
function intersect(runs) {
  const middle = meanOf(runs.map((run) => meanOf(run.points)));
  const lines = runs.map((run) => (run.line ??= fitLineL2(run.points)));
  lines.sort((a, b) => Math.atan2(a[0][1] - middle[1], a[0][0] - middle[0]) - Math.atan2(b[0][1] - middle[1], b[0][0] - middle[0]));
  const corners = [];
  for (let i = 0; i < 4; i++) {
    const corner = meet(lines[i], lines[(i + 1) % 4]);
    if (!corner) return null;
    corners.push(corner.map(f32));
  }
  return corners;
}

// Four corners from a shape's longest straight runs: lines fitted to them and intersected.
function fitQuad(contour, value, maxBezel) {
  const cv = cvLib();
  return withMats((mat) => {
    const perimeter = cv.arcLength(contour, true);
    const approx = mat();
    cv.approxPolyDP(contour, approx, 0.01 * perimeter, true);
    const poly = pointsOf(approx).map((p) => p.map(f32));
    const runs = [];
    const parallelAt = Math.cos((8 * Math.PI) / 180);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const length = norm(sub(b, a));
      if (length < 0.04 * perimeter) continue;
      const direction = scale(sub(b, a), 1 / length);
      const same = runs.find((run) => Math.abs(dot(run.direction, direction)) > parallelAt
        && Math.abs(dot(run.normal, a) - run.offset) < 0.02 * perimeter);
      if (same) {
        same.length += length;
        same.points.push(a, b);
      } else {
        const normal = [-direction[1], direction[0]];
        runs.push({ direction, normal, offset: dot(normal, a), length, points: [a, b] });
      }
    }
    runs.sort((a, b) => b.length - a.length);
    const hullMat = mat();
    cv.convexHull(contour, hullMat, false, true);
    const hull = pointsOf(hullMat);
    let best = null;
    let bestScore = 0;
    for (const four of combinations(runs.slice(0, 6), 4)) {
      const quad = intersect(four);
      if (!quad) continue;
      const shared = overlap(quad, hull);
      if (shared >= 0.5) {
        const score = shared * (0.2 + edgeSupport(value, quad, maxBezel));
        if (score > bestScore) {
          best = quad;
          bestScore = score;
        }
      }
    }
    if (best === null) {
      // Too few straight runs (very rounded, or noisy): the simplest four-cornered outline.
      for (const share of [0.02, 0.04, 0.06, 0.08]) {
        const corners = mat();
        cv.approxPolyDP(hullMat, corners, share * perimeter, true);
        if (corners.rows === 4) return pointsOf(corners).map((p) => p.map(f32));
      }
    }
    return best;
  });
}

// Share of the middle of the outline that's lit (a box drawn in outline is only bright round its edge).
function fill(value, quad, level) {
  const cv = cvLib();
  const center = meanOf(quad);
  const middle = quad.map((p) => add(center, scale(sub(p, center), 0.8)).map(Math.trunc));
  return withMats((mat, keep) => {
    const mask = mat(value.rows, value.cols, cv.CV_8UC1, new cv.Scalar(0));
    cv.fillConvexPoly(mask, keep(cv.matFromArray(4, 1, cv.CV_32SC2, middle.flat())), new cv.Scalar(1));
    let inside = 0;
    let lit = 0;
    for (let i = 0; i < mask.data.length; i++) {
      if (mask.data[i]) {
        inside++;
        if (value.data[i] > level) lit++;
      }
    }
    return inside ? lit / inside : 0;
  });
}

// np.percentile (linear) of an 8-bit picture, through its histogram.
function percentiles(value, shares) {
  const counts = new Float64Array(256);
  for (const v of value.data) counts[v]++;
  const n = value.data.length;
  const nth = (k) => {
    let seen = 0;
    for (let v = 0; v < 256; v++) {
      seen += counts[v];
      if (seen > k) return v;
    }
    return 255;
  };
  return shares.map((share) => {
    const at = (share / 100) * (n - 1);
    const low = Math.floor(at);
    const a = nth(low);
    const b = nth(Math.min(n - 1, low + 1));
    return a + (b - a) * (at - low);
  });
}

// Each pixel's strongest colour, lightly blurred, so a blue or purple screen counts as lit.
export function valueOf(frame, out) {
  const cv = cvLib();
  if (out.rows !== frame.rows || out.cols !== frame.cols) out.create(frame.rows, frame.cols, cv.CV_8UC1);
  const source = frame.data;
  const target = out.data;
  for (let i = 0, j = 0; j < target.length; i += 4, j++) {
    const r = source[i];
    const g = source[i + 1];
    const b = source[i + 2];
    target[j] = r > g ? (r > b ? r : b) : (g > b ? g : b);
  }
  cv.GaussianBlur(out, out, new cv.Size(3, 3), 0);
  return out;
}

// The lit phone screen at any angle: four straight edges with a dark bezel just outside them.
export function findScreen(frame, settings) {
  const cv = cvLib();
  return withMats((mat, keep) => {
    const small = mat();
    cv.resize(frame, small, new cv.Size(0, 0), 0.5, 0.5, cv.INTER_AREA);
    const value = valueOf(small, mat());
    const frameArea = value.cols * value.rows;
    const maxBezel = settings.max_bezel_brightness;
    const otsu = cv.threshold(value, mat(), 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    const levels = [...new Set([45, 70, otsu, (otsu + 255) / 2, ...percentiles(value, [60, 80, 92])]
      .map((level) => roundEven(Math.max(settings.min_screen_brightness, level))))].sort((a, b) => a - b);
    const kernel = keep(cv.Mat.ones(3, 3, cv.CV_8U));
    let best = null;
    let bestScore = 0;
    for (const level of levels) {
      const mask = mat();
      cv.threshold(value, mask, level, 255, cv.THRESH_BINARY);
      cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
      // Nested outlines too: on a bright wall the screen is an island inside the dark phone.
      const contours = new cv.MatVector();
      const hierarchy = mat();
      cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_NONE);
      try {
        for (let i = 0; i < contours.size(); i++) {
          const contour = contours.get(i);
          try {
            const share = cv.contourArea(contour) / frameArea;
            if (share < settings.min_area || share > settings.max_area) continue;
            const { x, y, width, height } = cv.boundingRect(contour);
            if (x <= 1 || y <= 1 || x + width >= value.cols - 1 || y + height >= value.rows - 1) continue; // cut off by the edge
            const quad = fitQuad(contour, value, maxBezel);
            if (!quad || !plausible(quad)) continue;
            const support = edgeSupport(value, quad, maxBezel);
            if (support < settings.min_edge_support || fill(value, quad, level) < settings.min_screen_fill) continue;
            const score = support * Math.sqrt(area(quad) / frameArea);
            if (score > bestScore) {
              best = quad;
              bestScore = score;
            }
          } finally {
            contour.delete();
          }
        }
      } finally {
        contours.delete();
      }
    }
    return best === null ? null : orderCorners(best.map((p) => scale(p, 2)));
  });
}

// Follow the screen from last frame's outline to this frame's: along each
// side, the step from lit screen to dark bezel nearest where it was.
export function trackScreen(value, quad, settings) {
  const count = 20;
  const s = sides(quad);
  const reach = Math.trunc(Math.min(30, Math.max(6, 0.06 * (s.reduce((a, b) => a + b, 0) / 4))));
  const offsets = [];
  for (let o = -reach - 4; o <= reach + 4; o++) offsets.push(o);
  const [points, normals] = sideSamples(quad, count);
  const rows = profiles(value, points, normals, offsets);
  const width = offsets.length - 6;
  const middle = reach + 1;
  const seen = [];
  const moved = [];
  for (const row of rows) {
    const step = new Float32Array(width);
    let any = false;
    for (let j = 0; j < width; j++) {
      const inside = f32(f32(row[j] + row[j + 1] + row[j + 2]) / 3);
      const outside = Math.min(row[j + 4], row[j + 5], row[j + 6]);
      step[j] = outside < settings.max_bezel_brightness ? inside - outside : 0;
      if (step[j] > 20) any = true;
    }
    seen.push(any);
    let edgeAt = 0;
    if (any) {
      let bestDistance = null;
      let column = 0;
      while (column < width) {
        if (!(step[column] > 20)) {
          column++;
          continue;
        }
        const start = column;
        while (column < width && step[column] > 20) column++;
        let peak = start;
        for (let j = start + 1; j < column; j++) if (step[j] > step[peak]) peak = j;
        if (bestDistance === null || Math.abs(peak - middle) < bestDistance) {
          bestDistance = Math.abs(peak - middle);
          edgeAt = peak;
        }
      }
    }
    moved.push(offsets[edgeAt + 3]);
  }
  const edges = points.map((p, i) => [f32(p[0] + f32(normals[i][0] * moved[i])), f32(p[1] + f32(normals[i][1] * moved[i]))]);
  const seenShare = seen.filter(Boolean).length / seen.length;

  // How far each side moved: a phone moves as one piece, a thumb moves one side alone.
  const sideRows = (side) => [...Array(count).keys()].map((k) => side * count + k);
  const shifts = [0, 1, 2, 3].map((side) => {
    const found = sideRows(side).filter((i) => seen[i]);
    return found.length >= 6 ? median(found.map((i) => moved[i])) : null;
  });
  const limit = Math.max(6, 0.06 * Math.max(...s));
  const ignored = new Set();
  for (const [a, b] of [[0, 2], [1, 3]]) {
    if (shifts[a] !== null && shifts[b] !== null && Math.abs(shifts[a] + shifts[b]) > limit) ignored.add(Math.abs(shifts[a]) > Math.abs(shifts[b]) ? a : b);
  }
  const lines = [0, 1, 2, 3].map((side) => {
    const found = sideRows(side).filter((i) => seen[i]).map((i) => edges[i]);
    return found.length >= 6 && !ignored.has(side) ? robustLine(found) : null;
  });
  if (lines.filter((line) => line === null).length > 1) return [null, seenShare];
  lines.forEach((line, side) => {
    if (line === null) { // keep this side where it was
      const a = quad[side];
      const b = quad[(side + 1) % 4];
      const along = sub(b, a).map(f32);
      const length = f32(f32(Math.sqrt(f32(f32(along[0] * along[0]) + f32(along[1] * along[1])))) + 1e-6);
      lines[side] = [a, [f32(along[0] / length), f32(along[1] / length)]];
    }
  });
  const corners = [];
  for (let side = 0; side < 4; side++) {
    const corner = meet(lines[(side + 3) % 4], lines[side]);
    if (!corner) return [null, seenShare];
    corners.push(corner.map(f32));
  }
  return [corners, seenShare];
}

export class Detector {
  constructor(settings) {
    const cv = cvLib();
    this.settings = settings;
    this.zone = null;          // locked corners as fractions of the frame, or null to find the phone
    this.quad = null;          // phone screen corners in frame pixels
    this.quadFound = false;
    this.tracking = 0;         // share of the outline the tracker could see last frame
    this.present = false;
    this.warped = null;        // the straightened screen: a Uint8Array, WARP_WIDTH × WARP_HEIGHT
    this.swipes = 0;
    this.lastSwipe = null;
    this.readout = {};
    this.lostSince = null;
    this.searchedAt = -1e9;
    this.foundAspect = 2.0;
    this.visibleSince = null;
    this.hiddenSince = null;
    this.previous = null;
    this.previousTime = 0;
    this.run = null;
    this.landedAt = null;
    this.window = hanningWindow(WARP_WIDTH, WARP_HEIGHT);
    this.correlator = new PhaseCorrelator(WARP_WIDTH, WARP_HEIGHT);
    this.gray = new cv.Mat();
    this.value = new cv.Mat();
  }

  dispose() {
    this.gray.delete();
    this.value.delete();
  }

  lock(zone) {
    const wasLocked = this.zone !== null;
    this.zone = zone ? zone.map(([x, y]) => [f32(x), f32(y)]) : null;
    if (wasLocked && this.zone === null) this.quad = null; // unlocked: find the phone afresh
  }

  zoneFromQuad([width, height]) {
    if (this.quad === null) return null;
    return this.quad.map(([x, y]) => [Math.round((x / width) * 1e4) / 1e4, Math.round((y / height) * 1e4) / 1e4]);
  }

  // Look at one frame (an RGBA Mat) taken at time t (seconds). Returns phone and swipe events.
  process(frame, t) {
    this.updateQuad(frame, t);
    this.warped = this.quad !== null ? this.warp(frame) : null;
    const visible = this.warped !== null && this.looksLikeScreen(this.warped);
    // A dark reel can hide the outline; keep the last one while the screen area still looks like a screen.
    if (this.zone === null && !this.quadFound && this.quad !== null && !visible) {
      if (t - (this.lostSince ?? t) > this.settings.hold_seconds) this.quad = null;
    }
    const events = this.updatePresence(visible, t);
    if (visible) events.push(...this.trackMotion(this.warped, t));
    else {
      this.previous = null;
      this.run = null;
    }
    return events;
  }

  updateQuad(frame, t) {
    const { cols: width, rows: height } = frame;
    if (this.zone !== null) {
      this.quad = this.zone.map(([x, y]) => [f32(x * width), f32(y * height)]);
      this.quadFound = true;
      return;
    }
    if (this.quad !== null) {
      const value = valueOf(frame, this.value);
      const [tracked, seen] = trackScreen(value, this.quad, this.settings);
      // The phone's proportions only change so much with tilt; an outline that's drifted onto a hand changes them a lot.
      const keepsShape = tracked !== null && Math.abs(aspect(tracked) / this.foundAspect - 1) < 0.25;
      if (tracked !== null && keepsShape && plausible(tracked) && close(tracked, this.quad)) {
        this.quad = portrait(tracked);
        this.quadFound = true;
        this.tracking = seen;
        this.lostSince = null;
        return;
      }
    }
    this.quadFound = false;
    this.tracking = 0;
    if (this.quad !== null && this.lostSince === null) this.lostSince = t;
    // Searching is slow, so not every frame.
    if (t - this.searchedAt >= this.settings.search_seconds) this.search(frame, t);
  }

  search(frame, t) {
    this.searchedAt = t;
    const found = findScreen(frame, this.settings);
    if (found === null) return;
    this.quad = this.quad === null ? found : align(found, this.quad); // keep the same corner as top-left
    this.quadFound = true;
    this.lostSince = null;
    this.foundAspect = aspect(found);
  }

  // The screen straightened at twice the size, then shrunk: smooths camera noise and interlacing.
  warp(frame) {
    const cv = cvLib();
    cv.cvtColor(frame, this.gray, cv.COLOR_RGBA2GRAY);
    return withMats((mat, keep) => {
      const quad = rotated(this.quad, this.settings.rotate);
      const [w, h] = [WARP_WIDTH * 2, WARP_HEIGHT * 2];
      const transform = keep(cv.getPerspectiveTransform(keep(floatMat(quad)), keep(floatMat([[0, 0], [w, 0], [w, h], [0, h]]))));
      const straight = mat();
      cv.warpPerspective(this.gray, straight, transform, new cv.Size(w, h));
      const small = mat();
      cv.resize(straight, small, new cv.Size(WARP_WIDTH, WARP_HEIGHT), 0, 0, cv.INTER_AREA);
      return Uint8Array.from(small.data);
    });
  }

  looksLikeScreen(warped) {
    let sum = 0;
    let squares = 0;
    for (const v of warped) {
      sum += v;
      squares += v * v;
    }
    const mean = sum / warped.length;
    const deviation = Math.sqrt(Math.max(0, squares / warped.length - mean * mean));
    return mean > this.settings.screen_brightness || deviation > this.settings.screen_texture;
  }

  updatePresence(visible, t) {
    // Half a second either way, so a hand passing over doesn't count.
    if (visible) {
      this.hiddenSince = null;
      this.visibleSince ??= t;
    } else {
      this.visibleSince = null;
      this.hiddenSince ??= t;
    }
    if (!this.present && visible && t - this.visibleSince >= 0.5) {
      this.present = true;
      this.landedAt = t;
      return [{ type: 'phone', present: true, t }];
    }
    if (this.present && !visible && t - this.hiddenSince >= 0.5) {
      this.present = false;
      return [{ type: 'phone', present: false, t }];
    }
    return [];
  }

  // Turning movement into swipes
  trackMotion(warped, t) {
    const settings = this.settings;
    const current = new Float32Array(warped.length);
    let sum = 0;
    for (const v of warped) sum += v;
    const mean = f32(sum / warped.length);
    let squares = 0;
    for (const v of warped) squares += (v - mean) ** 2;
    const deviation = f32(Math.sqrt(squares / warped.length));
    for (let i = 0; i < warped.length; i++) current[i] = (warped[i] - mean) / (deviation + 1);
    const previous = this.previous;
    const previousTime = this.previousTime;
    this.previous = current;
    this.previousTime = t;
    if (previous === null) return [];

    const [[dx, dy], response] = this.correlator.correlate(previous, current, this.window);
    const step = -dy / WARP_HEIGHT; // fraction of the screen; positive when the content moves up (next reel)
    const sideways = Math.abs(dx) / WARP_WIDTH;
    const moving = Math.abs(step) >= settings.min_step && response >= settings.min_response && sideways < 1.5 * Math.abs(step) + 0.02;
    let run = this.run;
    this.readout = { step, response, travel: run ? run.travel : 0 };

    const events = [];
    if (moving) {
      if (run === null) run = this.run = { start: previousTime, travel: 0, steps: [], peakSpeed: 0, responses: [], fired: false, still: 0 };
      run.steps.push(step);
      run.responses.push(response);
      run.peakSpeed = Math.max(run.peakSpeed, Math.abs(step) / Math.max(t - previousTime, 1e-3));
      run.still = 0;
      // The run's direction from all its frames, weighted by how clear each was (see detector.py).
      const direction = run.steps.reduce((total, s, i) => total + s * run.responses[i], 0) >= 0 ? 1 : -1;
      const along = run.steps.filter((s, i) => s * direction > 0 || (Math.abs(s) >= 0.15 && run.responses[i] < 0.35)).map(Math.abs);
      const total = along.reduce((a, b) => a + b, 0);
      run.travel = direction * total;
      this.readout.travel = run.travel;
      const followThrough = total - (along.length ? Math.max(...along) : 0);
      const quick = t - run.start <= settings.max_swipe_seconds;
      const settled = this.landedAt === null || run.start - this.landedAt >= settings.refractory_seconds;
      if (!run.fired && total >= settings.swipe_travel && followThrough >= settings.min_follow_through) {
        run.fired = true; // one decision per run, whether or not it counts
        if (quick && settled) events.push(this.swipe(run, t));
        else run.ignored = true;
      }
    } else if (run !== null) {
      // "No movement" only counts as stillness when it's clearly measured.
      if (response >= settings.still_clarity) run.still += 1;
      if (run.still >= settings.settle_frames || t - run.start > 1.0) {
        if (run.fired && !run.ignored) this.landedAt = t;
        this.run = null;
      }
    }
    return events;
  }

  swipe(run, t) {
    this.swipes += 1;
    const meanResponse = run.responses.reduce((a, b) => a + b, 0) / run.responses.length;
    this.lastSwipe = {
      type: 'swipe',
      t: run.start,
      detected_at: t,
      direction: run.travel > 0 ? 'next' : 'back',
      dwell: this.landedAt !== null ? run.start - this.landedAt : null,
      speed: Math.round(run.peakSpeed * 100) / 100, // screen heights per second
      confidence: Math.round(Math.min(1, meanResponse / (3 * this.settings.min_response)) * 100) / 100,
    };
    return this.lastSwipe;
  }
}
