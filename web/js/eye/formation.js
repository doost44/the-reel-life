// How the reel face forms: each reel watched breaks into fragments of the
// face. The Chrome version's copy of eye/formation.py (where it's
// described): change both together.
//
// Fragments sit on MediaPipe's face layout (canonical_face_model.obj, 0-1),
// or, for the hair and ears, on the head layout round it. Each is a torn piece
// of one of the reel's stills, damaged as far as the face has got.

import { progressOf } from './distortion.js';
import { base64Of, cvLib, encodeJpeg, roundEven, throughJpeg, toImageData, withMats } from './imaging.js';
import { lookValue } from './look-settings.js';
import { Random } from './random.js';
import { STILL_SIZE } from './sampler.js';

const ATLAS_PIXELS = 1024; // the face layout's size on the screens (reelface.js)
export const GRID = 48;    // how finely it keeps track of where the face is still missing
const HEAD_REACH = 1.2;
const FACE_HEIGHT_ON_HEAD = 1 / (2 * HEAD_REACH);
const FACE_HEIGHT_ON_EAR = 0.5;
const EAR_PATCHES = [[0.02, 0.87, 0.30, 0.12], [0.68, 0.87, 0.30, 0.12]];

// The face's outline and features, by MediaPipe's landmark numbers.
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176,
  149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const TOP = 10;
const CHIN = 152;
const SIDES = [234, 454];
const FEATURES = [
  [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],
  [300, 293, 334, 296, 336, 285, 295, 282, 283, 276],
  [1, 2, 98, 327, 168, 6, 197, 195, 5, 4, 45, 275, 64, 294],
  [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185],
];

const round4 = (value) => Math.round(value * 1e4) / 1e4;

// Where each point of the face sits on the face layout, 0-1.
function layoutPlaces(text) {
  const places = [];
  const placeOf = new Map();
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'vt') places.push([Number(parts[1]), 1 - Number(parts[2])]);
    else if (parts[0] === 'f') {
      for (const corner of parts.slice(1, 4)) {
        const [point, place] = corner.split('/').slice(0, 2).map((n) => Number(n) - 1);
        if (!placeOf.has(point)) placeOf.set(point, places[place]);
      }
    }
  }
  return placeOf;
}

// A grid of 0s and 1s from a Mat (8-bit, GRID × GRID).
const gridOf = (mat) => Float32Array.from(mat.data, (value) => (value > 0 ? 1 : 0));

const polygon = (points) => cvLib().matFromArray(points.length, 1, cvLib().CV_32SC2, points.flat());

// Where hair can be on the head layout: round the head, not on the face, not far below the chin.
function headRing(text) {
  const cv = cvLib();
  const model = text.split('\n').filter((line) => line.startsWith('v ')).map((line) => line.trim().split(/\s+/).slice(1, 4).map(Number));
  const middle = [0, 1, 2].map((axis) => [TOP, CHIN, ...SIDES].reduce((sum, p) => sum + model[p][axis], 0) / 4);
  const tall = Math.hypot(...[0, 1, 2].map((axis) => model[TOP][axis] - model[CHIN][axis]));
  const toGrid = (across, up) => [(across / (2 * HEAD_REACH) + 0.5) * GRID, (0.5 - up / (2 * HEAD_REACH)) * GRID];
  return withMats((mat, keep) => {
    const oval = keep(polygon(OVAL.map((p) => toGrid((model[p][0] - middle[0]) / tall, (model[p][1] - middle[1]) / tall).map(Math.trunc))));
    const face = mat(GRID, GRID, cv.CV_8UC1, new cv.Scalar(0));
    const ovals = new cv.MatVector();
    ovals.push_back(oval);
    cv.fillPoly(face, ovals, new cv.Scalar(1));
    ovals.delete();
    const kernel = keep(cv.Mat.ones(5, 5, cv.CV_8U));
    cv.erode(face, face, kernel);
    const roundHead = mat(GRID, GRID, cv.CV_8UC1, new cv.Scalar(0));
    const [cx, cy] = toGrid(0, 0.1).map(Math.trunc);
    cv.circle(roundHead, new cv.Point(cx, cy), Math.trunc(1.05 / (2 * HEAD_REACH) * GRID), new cv.Scalar(1), -1);
    const below = Math.trunc(toGrid(0, -0.85)[1]);
    const head = new Float32Array(GRID * GRID);
    for (let i = 0; i < GRID * GRID; i++) head[i] = roundHead.data[i] > 0 && face.data[i] === 0 && Math.floor(i / GRID) < below ? 1 : 0;
    return head;
  });
}

function earPatch([x, y, width, height]) {
  [x, y, width, height] = [x, y, width, height].map((n) => roundEven(n * GRID));
  const where = new Float32Array(GRID * GRID);
  for (let row = y; row < Math.min(GRID, y + height); row++) for (let column = x; column < Math.min(GRID, x + width); column++) where[row * GRID + column] = 1;
  return where;
}

// Where the face is on the layout and where its features are, on a coarse
// grid; and where the hair and ears go on the head layout.
export class FaceMap {
  constructor(layoutText) {
    const cv = cvLib();
    const placeOf = layoutPlaces(layoutText);
    this.head = headRing(layoutText);
    this.ears = EAR_PATCHES.map(earPatch);
    const onGrid = (points) => points.map((p) => placeOf.get(p).map((v) => Math.trunc(v * GRID)));
    withMats((mat, keep) => {
      const face = mat(GRID, GRID, cv.CV_8UC1, new cv.Scalar(0));
      const ovals = new cv.MatVector();
      ovals.push_back(keep(polygon(onGrid(OVAL))));
      cv.fillPoly(face, ovals, new cv.Scalar(1));
      ovals.delete();
      this.face = gridOf(face);
      const features = mat(GRID, GRID, cv.CV_8UC1, new cv.Scalar(0));
      for (const feature of FEATURES) {
        const hull = mat();
        cv.convexHull(keep(polygon(onGrid(feature))), hull, false, true);
        cv.fillConvexPoly(features, hull, new cv.Scalar(1));
      }
      cv.dilate(features, features, keep(cv.Mat.ones(3, 3, cv.CV_8U)));
      this.features = gridOf(features);
    });
    this.faceCells = this.face.reduce((sum, inside) => sum + inside, 0);
  }
}

// A place on a layout, 0-1: somewhere in where, mostly where least has landed.
function leastCovered(where, cover, random) {
  const weights = new Float64Array(where.length);
  for (let i = 0; i < where.length; i++) weights[i] = where[i] / (1 + cover[i]) ** 2;
  const index = random.choice(weights);
  const row = Math.floor(index / GRID);
  const column = index % GRID;
  return [(column + random.uniform()) / GRID, (row + random.uniform()) / GRID];
}

// Breaks each reel into fragments of the face, reel by reel.
export class Planner {
  constructor(settings, faceMap, seed) {
    this.settings = settings;
    this.map = faceMap;
    this.random = new Random(seed);
    this.cover = new Float32Array(GRID * GRID);     // how many pieces have landed on each part of the face
    this.headCover = new Float32Array(GRID * GRID); // ...and of the head layout
    this.reels = 0;
    this.watched = 0;
  }

  get progress() {
    return progressOf(this.reels, this.watched, this.settings);
  }

  // The share of the face at least one piece has landed on.
  get covered() {
    let landed = 0;
    for (let i = 0; i < this.cover.length; i++) if (this.map.face[i] && this.cover[i] > 0) landed++;
    return this.map.faceCells ? landed / this.map.faceCells : 0;
  }

  // This reel's fragments: their places, edges and pictures (numbers and times come later).
  async plan(reel, look) {
    this.reels += 1;
    this.watched += reel.watched;
    const at = this.progress;
    const stills = reel.stills.length ? reel.stills : [colourTile(reel.colour, this.random)];
    const count = Math.max(1, roundEven(lookValue(look, 'fragments', at) * this.random.uniform(0.75, 1.25)));
    const size = lookValue(look, 'fragment_size', at);
    const jagged = lookValue(look, 'jagged', at);
    const jpeg = lookValue(look, 'jpeg', at);
    const bleed = lookValue(look, 'bleed', at);
    const pending = [];
    for (let i = 0; i < count; i++) {
      const centre = this.where(at);
      const radius = size / 2 * this.random.uniform(0.6, 1.4);
      const outline = this.torn(centre, radius, jagged);
      const side = radius * 4; // room for the torn outline at its widest
      const rect = [centre[0] - side / 2, centre[1] - side / 2, side];
      const still = stills[this.random.integers(stills.length)];
      pending.push(this.piece(still, side, jpeg, bleed).then((image) => ({ number: 0, reel: reel.number, rect, outline, image, due: 0, layer: 'face' })));
      land(this.cover, centre, radius);
    }
    pending.push(...this.planHead(reel, stills, look, at, jagged, jpeg, bleed));
    const tiles = await Promise.all(pending);
    return this.random.shuffle(tiles); // the face and its hair form together
  }

  // This reel's pieces for the hair and ears, on the head layout.
  planHead(reel, stills, look, at, jagged, jpeg, bleed) {
    if (Math.max(...look.values.hair) <= 0) return []; // switched off
    const count = roundEven(lookValue(look, 'hair_fragments', at) * this.random.uniform(0.75, 1.25));
    const size = lookValue(look, 'hair_size', at);
    const ears = count >= this.map.ears.length ? this.map.ears : [];
    const pending = [];
    for (let number = 0; number < count; number++) {
      const onEar = number < ears.length;
      const where = onEar ? ears[number] : this.map.head;
      const scale = onEar ? FACE_HEIGHT_ON_EAR : FACE_HEIGHT_ON_HEAD;
      const centre = leastCovered(where, this.headCover, this.random);
      const radius = Math.min(size, onEar ? 0.25 : size) * scale / 2 * this.random.uniform(0.6, 1.4);
      const side = radius * 4;
      const rect = [centre[0] - side / 2, centre[1] - side / 2, side];
      const still = stills[this.random.integers(stills.length)];
      const outline = this.torn(centre, radius, jagged);
      pending.push(this.piece(still, side, jpeg, bleed).then((image) => ({ number: 0, reel: reel.number, rect, outline, image, due: 0, layer: 'head' })));
      land(this.headCover, centre, radius);
    }
    return pending;
  }

  // Where a piece lands: mostly where the face is still missing, and, once it's under way, towards the features.
  where(at) {
    const where = new Float32Array(GRID * GRID);
    for (let i = 0; i < where.length; i++) where[i] = this.map.face[i] * (at > 0.1 && this.map.features[i] ? 2.5 : 1);
    return leastCovered(where, this.cover, this.random);
  }

  // A torn, irregular outline round a centre: stretched and turned, its edge pulled in and out, with the odd spike.
  torn(centre, radius, jagged) {
    const random = this.random;
    const points = 8 + Math.trunc(jagged * 14);
    const stretch = random.uniform(0.55, 1.45);
    const turn = random.uniform(0, Math.PI);
    const angles = Array.from({ length: points }, () => random.uniform(0, 2 * Math.PI)).sort((a, b) => a - b);
    return angles.map((angle) => {
      let reach = radius * (1 - jagged * 0.55 * random.uniform());
      if (random.uniform() < jagged * 0.25) reach *= 1.35; // a spike
      const x = Math.cos(angle) * reach * stretch;
      const y = Math.sin(angle) * reach / stretch;
      return [round4(centre[0] + x * Math.cos(turn) - y * Math.sin(turn)), round4(centre[1] + x * Math.sin(turn) + y * Math.cos(turn))];
    });
  }

  // A piece of a still, turned at its own angle, at the size it's drawn, damaged: a base64 JPEG.
  async piece(still, side, jpeg, bleed) {
    const cv = cvLib();
    const random = this.random;
    const crop = Math.trunc(Math.min(still.width, still.height) * random.uniform(0.45, 1.0));
    const x = random.integers(0, still.width - crop + 1);
    const y = random.integers(0, still.height - crop + 1);
    const pixels = Math.trunc(Math.min(512, Math.max(24, side * ATLAS_PIXELS)));
    const angle = random.uniform(-35, 35);
    const turned = withMats((mat, keep) => {
      const source = keep(cv.matFromImageData(still));
      const cut = keep(source.roi(new cv.Rect(x, y, crop, crop)));
      const sized = mat();
      cv.resize(cut, sized, new cv.Size(pixels, pixels), 0, 0, cv.INTER_AREA);
      const turn = keep(cv.getRotationMatrix2D(new cv.Point(pixels / 2, pixels / 2), angle, 1.15));
      const out = mat();
      cv.warpAffine(sized, out, turn, new cv.Size(pixels, pixels), cv.INTER_LINEAR, cv.BORDER_REFLECT);
      return toImageData(out);
    });
    const damaged = await damage(turned, jpeg, bleed, random);
    return base64Of(await encodeJpeg(damaged, 82));
  }
}

// Lands a piece: the cover rises by one on a disc round its centre.
function land(cover, centre, radius) {
  const cv = cvLib();
  withMats((mat) => {
    const mark = mat(GRID, GRID, cv.CV_8UC1, new cv.Scalar(0));
    cv.circle(mark, new cv.Point(Math.trunc(centre[0] * GRID), Math.trunc(centre[1] * GRID)), Math.max(1, Math.trunc(radius * 0.8 * GRID)), new cv.Scalar(1), -1);
    for (let i = 0; i < cover.length; i++) cover[i] += mark.data[i];
  });
}

// A piece of still, damaged as far as the face has got: its exposure and
// colour knocked off its neighbours', pixelated, and saved as a JPEG again
// and again at a falling quality, nudged a little each time (generation loss).
async function damage(still, jpeg, bleed, random) {
  const cv = cvLib();
  const gain = 1 + random.normal(0, 0.25 * bleed);
  const cast = [random.normal(0, 22 * bleed), random.normal(0, 22 * bleed), random.normal(0, 22 * bleed)];
  const { width, height } = still;
  let damaged = new ImageData(width, height);
  for (let i = 0; i < still.data.length; i += 4) {
    for (let c = 0; c < 3; c++) damaged.data[i + c] = Math.trunc(Math.min(255, Math.max(0, still.data[i + c] * gain + cast[c])));
    damaged.data[i + 3] = 255;
  }
  if (jpeg > 0.15) {
    const factor = 1 + 5 * jpeg * random.uniform(0.5, 1.0);
    damaged = withMats((mat, keep) => {
      const source = keep(cv.matFromImageData(damaged));
      const small = mat();
      cv.resize(source, small, new cv.Size(Math.max(4, Math.trunc(width / factor)), Math.max(4, Math.trunc(height / factor))), 0, 0, cv.INTER_AREA);
      const back = mat();
      cv.resize(small, back, new cv.Size(width, height), 0, 0, cv.INTER_NEAREST);
      return toImageData(back);
    });
  }
  const quality = Math.max(4, Math.trunc(roundEven(85 - 80 * jpeg)));
  for (let generation = 0; generation < 1 + Math.trunc(jpeg * 3); generation++) {
    damaged = rolled(damaged, random.integers(-2, 3), random.integers(-2, 3));
    damaged = await throughJpeg(damaged, quality);
  }
  return damaged;
}

// The picture shifted by whole pixels, wrapping round (numpy.roll).
function rolled(picture, down, right) {
  const { width, height } = picture;
  const out = new ImageData(width, height);
  const source = new Uint32Array(picture.data.buffer);
  const target = new Uint32Array(out.data.buffer);
  for (let y = 0; y < height; y++) {
    const fromY = (((y - down) % height) + height) % height;
    for (let x = 0; x < width; x++) target[y * width + x] = source[fromY * width + ((((x - right) % width) + width) % width)];
  }
  return out;
}

// A reel with no usable still: its main colour, blurred and uneven.
function colourTile(colour, random) {
  const cv = cvLib();
  const [width, height] = STILL_SIZE;
  return withMats((mat, keep) => {
    const rows = Math.floor(height / 24);
    const columns = Math.floor(width / 24);
    const noise = keep(cv.matFromArray(rows, columns, cv.CV_32FC1, Array.from({ length: rows * columns }, () => random.normal(0, 18))));
    const big = mat();
    cv.resize(noise, big, new cv.Size(width, height), 0, 0, cv.INTER_CUBIC);
    const tile = mat(height, width, cv.CV_8UC4);
    for (let i = 0; i < width * height; i++) {
      for (let c = 0; c < 3; c++) tile.data[i * 4 + c] = Math.min(255, Math.max(0, Math.trunc(colour[c] + big.data32F[i])));
      tile.data[i * 4 + 3] = 255;
    }
    const blurred = mat();
    cv.GaussianBlur(tile, blurred, new cv.Size(0, 0), 6);
    return toImageData(blurred);
  });
}

