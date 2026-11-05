// OpenCV's intersectConvexConvex (imgproc/src/geometry.cpp, after O'Rourke's
// "Computational Geometry in C"), which OpenCV.js doesn't have: the area two
// convex shapes share.
//
// Ported as it is, in OpenCV's 32-bit arithmetic, quirks and all. On nearly
// degenerate shapes (an edge passing all but exactly through a corner) it can
// return more than the true area, and the swipe detector's choice of the
// phone's outline was tuned with that, so it's kept.

const f = Math.fround;
const sub = (a, b) => [f(a[0] - b[0]), f(a[1] - b[1])];
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

function areaSign(a, b, c) {
  const area2 = f(b[0] - a[0]) * f(c[1] - a[1]) - f(c[0] - a[0]) * f(b[1] - a[1]);
  return area2 > 1e-5 ? 1 : area2 < -1e-5 ? -1 : 0;
}

// Whether c lies on the closed segment ab, when it's known abc are collinear.
function between(a, b, c) {
  if (a[0] !== b[0]) return (a[0] <= c[0] && c[0] <= b[0]) || (a[0] >= c[0] && c[0] >= b[0]);
  return (a[1] <= c[1] && c[1] <= b[1]) || (a[1] >= c[1] && c[1] >= b[1]);
}

const NONE = 0;
const SINGLE = 1;
const OVERLAP = 2;
const ENDPOINT = 3;

function parallelInt(a, b, c, d) {
  if (areaSign(a, b, c) !== 0) return [NONE];
  if (between(a, b, c) && between(a, b, d)) return [OVERLAP, c, d];
  if (between(c, d, a) && between(c, d, b)) return [OVERLAP, a, b];
  if (between(a, b, c) && between(c, d, b)) return [OVERLAP, c, b];
  if (between(a, b, c) && between(c, d, a)) return [OVERLAP, c, a];
  if (between(a, b, d) && between(c, d, b)) return [OVERLAP, d, b];
  if (between(a, b, d) && between(c, d, a)) return [OVERLAP, d, a];
  return [NONE];
}

// Where segments ab and cd meet: [code, p, q].
function intersectSegments(a, b, c, d) {
  const denominator = f(a[0] - b[0]) * f(d[1] - c[1]) - f(a[1] - b[1]) * f(d[0] - c[0]);
  if (denominator === 0) return parallelInt(a, b, c, d);
  const s = (f(d[1] - a[1]) * f(a[0] - c[0]) + f(a[0] - d[0]) * f(a[1] - c[1])) / denominator;
  const t = (f(b[1] - a[1]) * f(a[0] - c[0]) + f(c[1] - a[1]) * f(b[0] - a[0])) / denominator;
  const p = [f(a[0] + s * f(b[0] - a[0])), f(a[1] + s * f(b[1] - a[1]))];
  const code = s < 0 || s > 1 || t < 0 || t > 1 ? NONE : s === 0 || s === 1 || t === 0 || t === 1 ? ENDPOINT : SINGLE;
  return [code, p, p];
}

const P_IN = 0;
const Q_IN = 1;
const UNKNOWN = 2;

function intersectPolygons(P, Q) {
  const n = P.length;
  const m = Q.length;
  const result = [[f(3.4028234663852886e38), f(3.4028234663852886e38)]];
  const last = () => result[result.length - 1];
  const add = (p) => {
    if (!same(p, last())) result.push(p);
  };
  let a = 0;
  let b = 0;
  let inflag = UNKNOWN;
  let aa = 0;
  let ba = 0;
  let firstPoint = true;
  const advance = (index, count, length, inside, vertex) => {
    if (inside) add(vertex);
    return [(index + 1) % length, count + 1];
  };
  do {
    const a1 = (a + n - 1) % n;
    const b1 = (b + m - 1) % m;
    const A = sub(P[a], P[a1]);
    const B = sub(Q[b], Q[b1]);
    const cross = areaSign([0, 0], A, B);
    const aHB = areaSign(Q[b1], Q[b], P[a]);
    const bHA = areaSign(P[a1], P[a], Q[b]);
    const [code, p, q] = intersectSegments(P[a1], P[a], Q[b1], Q[b]);
    if (code === SINGLE || code === ENDPOINT) {
      if (inflag === UNKNOWN && firstPoint) {
        aa = 0;
        ba = 0;
        firstPoint = false;
        result.push(p);
      }
      add(p);
      inflag = aHB > 0 ? P_IN : bHA > 0 ? Q_IN : inflag;
    }
    // These two return before OpenCV works out any area: it stays 0.
    if (code === OVERLAP && A[0] * B[0] + A[1] * B[1] < 0) {
      add(p);
      add(q);
      return [result.length, 0];
    }
    if (cross === 0 && aHB < 0 && bHA < 0) return [result.length, 0];
    if (cross === 0 && aHB === 0 && bHA === 0) {
      if (inflag === P_IN) [b, ba] = advance(b, ba, m, inflag === Q_IN, Q[b]);
      else [a, aa] = advance(a, aa, n, inflag === P_IN, P[a]);
    } else if (cross >= 0) {
      if (bHA > 0) [a, aa] = advance(a, aa, n, inflag === P_IN, P[a]);
      else [b, ba] = advance(b, ba, m, inflag === Q_IN, Q[b]);
    } else if (aHB > 0) [b, ba] = advance(b, ba, m, inflag === Q_IN, Q[b]);
    else [a, aa] = advance(a, aa, n, inflag === P_IN, P[a]);
  } while ((aa < n || ba < m) && aa < 2 * n && ba < 2 * m);

  // The first entry was only a marker: the area goes round the rest, closing on it as OpenCV does.
  let nr = result.length;
  let area = 0;
  let previous = result[nr - 1];
  for (let i = 1; i < nr; i++) {
    result[i - 1] = result[i];
    area += previous[0] * result[i][1] - previous[1] * result[i][0];
    previous = result[i];
  }
  if (nr > 1 && same(result[nr - 2], result[0])) nr--;
  return [nr - 1, f(area * 0.5)];
}

// Whether a point is inside a shape (pointPolygonTest without distances: 1 in, 0 on the edge, -1 out).
function pointPolygonTest(contour, point) {
  let counter = 0;
  let v = contour[contour.length - 1];
  for (const next of contour) {
    const v0 = v;
    v = next;
    if ((v0[1] <= point[1] && v[1] <= point[1]) || (v0[1] > point[1] && v[1] > point[1]) || (v0[0] < point[0] && v[0] < point[0])) {
      if (point[1] === v[1] && (point[0] === v[0] || (point[1] === v0[1]
        && ((v0[0] <= point[0] && point[0] <= v[0]) || (v[0] <= point[0] && point[0] <= v0[0]))))) return 0;
      continue;
    }
    let distance = f(point[1] - v0[1]) * f(v[0] - v0[0]) - f(point[0] - v0[0]) * f(v[1] - v0[1]);
    if (distance === 0) return 0;
    if (v[1] < v0[1]) distance = -distance;
    if (distance > 0) counter++;
  }
  return counter % 2 === 0 ? -1 : 1;
}

function shoelace(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}

// Both turned the same way round, as OpenCV does before intersecting.
function oriented(points) {
  const copy = points.map((p) => p.map(f));
  const first = sub(copy[0], copy[copy.length - 1]);
  for (let i = 1; i < copy.length; i++) {
    const edge = sub(copy[i], copy[i - 1]);
    const s = first[0] * edge[1] - first[1] * edge[0];
    if (s !== 0) {
      if (s < 0) copy.reverse();
      break;
    }
  }
  return copy;
}

// The area two convex shapes ([[x, y], ...]) share, as cv2.intersectConvexConvex (handleNested on).
export function intersectConvexConvex(first, second) {
  if (first.length < 2 || second.length < 2) return 0;
  const P = oriented(first);
  const Q = oriented(second);
  let [count, area] = intersectPolygons(P, Q);
  if (count === 0) {
    // No crossing edges: one inside the other, or apart.
    if (Q.every((point) => pointPolygonTest(P, point) >= 0)) area = f(shoelace(Q));
    else if (P.every((point) => pointPolygonTest(Q, point) >= 0)) area = f(shoelace(P));
    else return 0;
  }
  return Math.abs(area);
}
