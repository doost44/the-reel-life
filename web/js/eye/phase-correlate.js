// OpenCV's phaseCorrelate (imgproc/src/phasecorr.cpp), which OpenCV.js
// doesn't have: how far one picture moved from the last, and how clearly.
//
// Like OpenCV's, it multiplies both pictures by the window in place. The
// swipe detector was tuned with that (the previous picture reaches it
// already windowed once, so it's windowed twice), so it's kept.

// A mixed-radix FFT for lengths made of 2s, 3s and 5s, unscaled, as OpenCV's dft.
class FFT {
  constructor(n) {
    this.n = n;
    this.factors = [];
    let rest = n;
    for (const p of [4, 2, 3, 5]) while (rest % p === 0) { this.factors.push(p); rest /= p; }
    if (rest !== 1) throw new Error(`FFT: ${n} isn't made of 2s, 3s and 5s`);
    this.cos = Float64Array.from({ length: n }, (_, k) => Math.cos((2 * Math.PI * k) / n));
    this.sin = Float64Array.from({ length: n }, (_, k) => -Math.sin((2 * Math.PI * k) / n));
    this.outRe = new Float64Array(n);
    this.outIm = new Float64Array(n);
    const most = Math.max(...this.factors);
    this.tRe = new Float64Array(most);
    this.tIm = new Float64Array(most);
  }

  // Transforms re/im (length n, read with a stride from an offset) into this.outRe/outIm.
  run(re, im, offset = 0, stride = 1) {
    this.step(re, im, offset, stride, this.n, 0, 0);
    return [this.outRe, this.outIm];
  }

  step(re, im, inAt, stride, n, outAt, depth) {
    const { outRe, outIm } = this;
    if (n === 1) {
      outRe[outAt] = re[inAt];
      outIm[outAt] = im[inAt];
      return;
    }
    const p = this.factors[depth];
    const m = n / p;
    if (m === 1) {
      for (let r = 0; r < p; r++) {
        outRe[outAt + r] = re[inAt + r * stride];
        outIm[outAt + r] = im[inAt + r * stride];
      }
    } else {
      for (let r = 0; r < p; r++) this.step(re, im, inAt + r * stride, stride * p, m, outAt + r * m, depth + 1);
    }
    const scale = this.n / n; // twiddles for length n from the table for this.n (r·k·scale stays under n)
    const { cos, sin, tRe, tIm } = this;
    for (let k = 0; k < m; k++) {
      // Each sub-transform's value at k, turned by its twiddle.
      for (let r = 0; r < p; r++) {
        const e = r * k * scale;
        const a = outRe[outAt + r * m + k];
        const b = outIm[outAt + r * m + k];
        tRe[r] = a * cos[e] - b * sin[e];
        tIm[r] = a * sin[e] + b * cos[e];
      }
      const at = outAt + k;
      if (p === 4) {
        const aRe = tRe[0] + tRe[2], aIm = tIm[0] + tIm[2];
        const bRe = tRe[0] - tRe[2], bIm = tIm[0] - tIm[2];
        const cRe = tRe[1] + tRe[3], cIm = tIm[1] + tIm[3];
        const dRe = tRe[1] - tRe[3], dIm = tIm[1] - tIm[3];
        outRe[at] = aRe + cRe; outIm[at] = aIm + cIm;
        outRe[at + m] = bRe + dIm; outIm[at + m] = bIm - dRe;          // b − i·d
        outRe[at + 2 * m] = aRe - cRe; outIm[at + 2 * m] = aIm - cIm;
        outRe[at + 3 * m] = bRe - dIm; outIm[at + 3 * m] = bIm + dRe;  // b + i·d
      } else if (p === 2) {
        outRe[at] = tRe[0] + tRe[1]; outIm[at] = tIm[0] + tIm[1];
        outRe[at + m] = tRe[0] - tRe[1]; outIm[at + m] = tIm[0] - tIm[1];
      } else if (p === 3) {
        const uRe = tRe[1] + tRe[2], uIm = tIm[1] + tIm[2];
        const vRe = tRe[1] - tRe[2], vIm = tIm[1] - tIm[2];
        const mRe = tRe[0] - 0.5 * uRe, mIm = tIm[0] - 0.5 * uIm;
        const s = -Math.sqrt(3) / 2; // the imaginary part of e^(−2πi/3)
        outRe[at] = tRe[0] + uRe; outIm[at] = tIm[0] + uIm;
        outRe[at + m] = mRe - s * vIm; outIm[at + m] = mIm + s * vRe;
        outRe[at + 2 * m] = mRe + s * vIm; outIm[at + 2 * m] = mIm - s * vRe;
      } else {
        for (let q = 0; q < p; q++) {
          let sumRe = 0;
          let sumIm = 0;
          for (let r = 0; r < p; r++) {
            const e = ((r * q) % p) * m * scale;
            sumRe += tRe[r] * cos[e] - tIm[r] * sin[e];
            sumIm += tRe[r] * sin[e] + tIm[r] * cos[e];
          }
          outRe[at + q * m] = sumRe;
          outIm[at + q * m] = sumIm;
        }
      }
    }
  }
}

// 2D transforms of rows × columns pictures, in place.
class FFT2D {
  constructor(rows, columns) {
    this.rows = rows;
    this.columns = columns;
    this.rowFFT = new FFT(columns);
    this.columnFFT = new FFT(rows);
  }

  run(re, im) {
    const { rows, columns } = this;
    for (let y = 0; y < rows; y++) {
      const [outRe, outIm] = this.rowFFT.run(re, im, y * columns, 1);
      re.set(outRe, y * columns);
      im.set(outIm, y * columns);
    }
    for (let x = 0; x < columns; x++) {
      const [outRe, outIm] = this.columnFFT.run(re, im, x, columns);
      for (let y = 0; y < rows; y++) {
        re[y * columns + x] = outRe[y];
        im[y * columns + x] = outIm[y];
      }
    }
  }
}

// OpenCV's createHanningWindow, as rows × columns.
export function hanningWindow(columns, rows) {
  const window = new Float32Array(rows * columns);
  for (let y = 0; y < rows; y++) {
    const wr = 0.5 * (1 - Math.cos((2 * Math.PI * y) / (rows - 1)));
    for (let x = 0; x < columns; x++) {
      const wc = 0.5 * (1 - Math.cos((2 * Math.PI * x) / (columns - 1)));
      window[y * columns + x] = Math.sqrt(wr * wc);
    }
  }
  return window;
}

const FLT_EPSILON = 1.1920928955078125e-7;

export class PhaseCorrelator {
  constructor(columns, rows) {
    for (const size of [columns, rows]) if (size % 2) throw new Error('PhaseCorrelator: sizes must be even');
    this.columns = columns;
    this.rows = rows;
    this.fft = new FFT2D(rows, columns);
    this.re = new Float64Array(rows * columns);
    this.im = new Float64Array(rows * columns);
    this.c = new Float64Array(rows * columns);
    this.pRe = new Float64Array(rows * columns);
    this.pIm = new Float64Array(rows * columns);
  }

  // [[dx, dy], response]: how far b moved from a (positive dy: down), and how clearly (0-1).
  // a and b (Float32Array, rows × columns) are multiplied by the window, in place.
  correlate(a, b, window) {
    const { rows, columns, re, im, c, pRe, pIm } = this;
    const size = rows * columns;
    for (let i = 0; i < size; i++) {
      a[i] *= window[i];
      b[i] *= window[i];
      re[i] = a[i]; // both real pictures in one transform: a as the real part, b as the imaginary
      im[i] = b[i];
    }
    this.fft.run(re, im);
    // Their spectra apart (A at k is (Z[k] + conj Z[-k]) / 2, B is (Z[k] - conj Z[-k]) / 2i),
    // then A·conj(B), normalised to its phase.
    for (let y = 0; y < rows; y++) {
      const my = (rows - y) % rows;
      for (let x = 0; x < columns; x++) {
        const k = y * columns + x;
        const mk = my * columns + ((columns - x) % columns);
        const aRe = (re[k] + re[mk]) / 2;
        const aIm = (im[k] - im[mk]) / 2;
        const bRe = (im[k] + im[mk]) / 2;
        const bIm = (re[mk] - re[k]) / 2;
        const real = aRe * bRe + aIm * bIm;
        const imag = aIm * bRe - aRe * bIm;
        const magnitude = Math.sqrt(real * real + imag * imag);
        // OpenCV's divSpectrums: P / |P| with a little against dividing by 0.
        const isReal = (x === 0 || x === columns / 2) && (y === 0 || y === rows / 2);
        if (isReal) {
          pRe[k] = real / (magnitude + FLT_EPSILON);
          pIm[k] = 0;
        } else {
          const denominator = magnitude * magnitude + FLT_EPSILON;
          pRe[k] = (real * magnitude) / denominator;
          pIm[k] = (imag * magnitude) / denominator;
        }
      }
    }
    // The inverse transform, unscaled: conj(FFT(conj(P))), whose real part is the answer.
    for (let i = 0; i < size; i++) pIm[i] = -pIm[i];
    this.fft.run(pRe, pIm);
    // Shifted so no movement is in the middle.
    const halfRows = rows / 2;
    const halfColumns = columns / 2;
    let peak = 0;
    let peakValue = -Infinity;
    for (let y = 0; y < rows; y++) {
      const sy = (y + halfRows) % rows;
      for (let x = 0; x < columns; x++) c[sy * columns + ((x + halfColumns) % columns)] = pRe[y * columns + x];
    }
    for (let i = 0; i < size; i++) {
      if (c[i] > peakValue) {
        peakValue = c[i];
        peak = i;
      }
    }
    // The peak to a fraction of a pixel: the weighted middle of the 5×5 round it.
    const py = Math.floor(peak / columns);
    const px = peak % columns;
    let sx = 0;
    let sy = 0;
    let sum = 0;
    for (let y = Math.max(0, py - 2); y <= Math.min(rows - 1, py + 2); y++) {
      for (let x = Math.max(0, px - 2); x <= Math.min(columns - 1, px + 2); x++) {
        const value = c[y * columns + x];
        sx += x * value;
        sy += y * value;
        sum += value;
      }
    }
    const response = sum / size;
    sum += Number.EPSILON;
    return [[halfColumns - sx / sum, halfRows - sy / sum], response];
  }
}
