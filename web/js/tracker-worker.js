// MediaPipe's Face Landmarker on a thread of its own, so finding the face
// never holds up drawing it. Gets one picture at a time from tracker.js and
// sends back the face's points and how open the eyes and mouth are. A classic
// worker that imports MediaPipe's module: its runtime loads with
// importScripts, which only classic workers have.

const MEDIAPIPE = '/vendor/mediapipe';

const ready = (async () => {
  const { FaceLandmarker, FilesetResolver } = await import(`${MEDIAPIPE}/vision_bundle.mjs`);
  const files = await FilesetResolver.forVisionTasks(`${MEDIAPIPE}/wasm`);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: `${MEDIAPIPE}/face_landmarker.task`, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
  });
  try {
    return await FaceLandmarker.createFromOptions(files, options('GPU'));
  } catch {
    return FaceLandmarker.createFromOptions(files, options('CPU'));
  }
})();

ready.then(() => postMessage({ type: 'ready' }), (error) => postMessage({ type: 'failed', error: String(error) }));

onmessage = async ({ data: { picture, time } }) => {
  const landmarker = await ready;
  const result = landmarker.detectForVideo(picture, time);
  const { width, height } = picture;
  picture.close();
  const found = result.faceLandmarks?.[0];
  if (!found) {
    postMessage({ type: 'face', face: null });
    return;
  }
  const points = new Float32Array(found.length * 3);
  found.forEach(({ x, y, z }, i) => points.set([x, y, z], i * 3));
  const shapes = {};
  for (const { categoryName, score } of result.faceBlendshapes?.[0]?.categories ?? []) shapes[categoryName] = score;
  postMessage({ type: 'face', face: { points, shapes, width, height } }, [points.buffer]);
};
