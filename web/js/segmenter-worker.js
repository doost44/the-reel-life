// MediaPipe's Image Segmenter on a thread of its own, so finding the hair never
// holds up the face. Gets one small picture at a time from segmenter.js and
// sends back, for each of its pixels, whether it's hair (first byte) or skin
// (second byte), and how bright the hair is on average. A classic worker, like
// tracker-worker.js, for the same reason.

const MEDIAPIPE = '/vendor/mediapipe';
// The model's categories: 0 background, 1 hair, 2 body skin, 3 face skin, 4 clothes, 5 others (accessories).
const HAIR = [false, true, false, false, false, true];
const SKIN = [false, false, true, true, false, false];

const ready = (async () => {
  const { ImageSegmenter, FilesetResolver } = await import(`${MEDIAPIPE}/vision_bundle.mjs`);
  const files = await FilesetResolver.forVisionTasks(`${MEDIAPIPE}/wasm`);
  // On the CPU: on the GPU, each look held up the face's own drawing (Chrome does GPU work one job at a time).
  return ImageSegmenter.createFromOptions(files, {
    baseOptions: { modelAssetPath: `${MEDIAPIPE}/selfie_multiclass_256x256.tflite`, delegate: 'CPU' },
    runningMode: 'VIDEO',
    outputCategoryMask: true,
    outputConfidenceMasks: false,
  });
})();

ready.then(
  (segmenter) => postMessage({ type: 'ready', labels: segmenter.getLabels() }),
  (error) => postMessage({ type: 'failed', error: String(error) }),
);

let lastTime = 0;
let reader = null; // a small canvas, to read the picture's pixels

// How bright these pixels of the picture are on average (0-1), or null if there are too few.
function averageLight(picture, mask, width, height) {
  if (reader?.canvas.width !== width || reader.canvas.height !== height) {
    reader = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  }
  reader.drawImage(picture, 0, 0, width, height);
  const pixels = reader.getImageData(0, 0, width, height).data;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < mask.length; i += 2) {
    if (!mask[i]) continue;
    const at = i * 2;
    sum += 0.299 * pixels[at] + 0.587 * pixels[at + 1] + 0.114 * pixels[at + 2];
    count += 1;
  }
  return count > 200 ? sum / count / 255 : null;
}

onmessage = async ({ data: { picture } }) => {
  const segmenter = await ready;
  const started = performance.now();
  lastTime = Math.max(started, lastTime + 1); // MediaPipe wants its clock to keep moving forward
  const result = segmenter.segmentForVideo(picture, lastTime);
  const { categoryMask } = result;
  const { width, height } = categoryMask;
  const categories = categoryMask.getAsUint8Array();
  const mask = new Uint8Array(width * height * 2);
  for (let i = 0; i < categories.length; i++) {
    if (HAIR[categories[i]]) mask[i * 2] = 255;
    else if (SKIN[categories[i]]) mask[i * 2 + 1] = 255;
  }
  result.close();
  const hairLight = averageLight(picture, mask, width, height);
  picture.close();
  postMessage({ type: 'mask', mask, width, height, hairLight, ms: performance.now() - started }, [mask.buffer]);
};
