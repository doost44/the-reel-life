// Pictures in the Chrome version of the eye: OpenCV.js (the global cv, loaded
// by worker.js) for the image work the Python eye does with OpenCV, and
// OffscreenCanvas for JPEGs, which OpenCV.js can't write.
//
// Pictures are ImageData (RGBA). OpenCV Mats are freed as soon as they're
// done with: OpenCV.js has no garbage collector of its own.

export const cvLib = () => globalThis.cv;

// Runs fn with the Mats it makes, then frees them all.
export function withMats(fn) {
  const made = [];
  const mat = (...args) => {
    const m = new (cvLib().Mat)(...args);
    made.push(m);
    return m;
  };
  const keep = (m) => {
    made.push(m);
    return m;
  };
  try {
    return fn(mat, keep);
  } finally {
    for (const m of made) if (!m.isDeleted()) m.delete();
  }
}

export function toImageData(mat) {
  return new ImageData(new Uint8ClampedArray(mat.data), mat.cols, mat.rows);
}

// A JPEG of a picture, at quality 0-100.
export async function encodeJpeg(picture, quality) {
  const canvas = new OffscreenCanvas(picture.width, picture.height);
  canvas.getContext('2d').putImageData(picture, 0, 0);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
}

export async function decodeJpeg(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

export async function base64Of(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

// A picture saved as a JPEG and read back, as the Python eye's imencode/imdecode.
export async function throughJpeg(picture, quality) {
  return decodeJpeg(await encodeJpeg(picture, quality));
}

// Round half to even, as Python's round().
export function roundEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}
