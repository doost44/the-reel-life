// The Chrome version of the eye, in a worker of its own, so it keeps time
// and watches the phone even when the page that started it is covered (Chrome
// slows down pages it can't see, not their workers). host.js starts it.
//
// A classic worker: OpenCV.js loads with importScripts; the rest are modules.
//
// From the page: start { savedSetup, devices }, join/leave/message { client, message },
//   stream { readable } (the detection camera's VideoFrames), bitmap { bitmap },
//   camera_status { status }, devices { devices }.
// To the page: send { message, to, skip }, frame { name, blob }, save { setup },
//   camera { name, mode } (open it; name null: close it), refresh_devices, ready.

importScripts('../../vendor/opencv/opencv.js');

// OpenCV.js's cv has a then() that resolves to itself, so it's never awaited: wait for it to start.
const opencvReady = new Promise((resolve) => (self.cv.Mat ? resolve() : (self.cv.onRuntimeInitialized = resolve)));

let eye = null;
const waiting = [];
let streams = 0; // the newest detection camera stream; older ones stop reading
const post = (message, transfer = []) => self.postMessage(message, transfer);

self.onmessage = ({ data }) => {
  if (data.kind === 'start') start(data).catch((error) => post({ kind: 'failed', error: String(error?.stack ?? error) }));
  else if (eye) receive(data);
  else waiting.push(data);
};

function receive(data) {
  switch (data.kind) {
    case 'join': eye.join(data.client); break;
    case 'leave': eye.leave(data.client); break;
    case 'message': eye.handle(data.client, data.message); break;
    case 'stream': readFrames(data.readable); break;
    case 'bitmap': frameFromPicture(data.bitmap); break;
    case 'camera_status': eye.cameraStatus(data.status); break;
    case 'devices': eye.setDevices(data.devices); break;
    default: break;
  }
}

async function exists(url) {
  try {
    return (await fetch(url, { method: 'HEAD', cache: 'no-store' })).ok;
  } catch {
    return false;
  }
}

// Recorded words in voice/ (more.wav, dont-stop.wav, scream.wav...): there's no folder to list, so each is asked for.
async function findClips(config, rootUrl, clipName) {
  const voice = config.reel_face.voice;
  const names = new Set([...voice.words.flat().map(clipName), 'scream']);
  const clips = new Map();
  await Promise.all([...names].map(async (name) => {
    for (const extension of ['.wav', '.mp3', '.ogg']) {
      const url = rootUrl(`${voice.clips}/${name}${extension}`);
      if (await exists(url)) {
        clips.set(name, url);
        return;
      }
    }
  }));
  return clips;
}

async function start({ savedSetup, devices }) {
  await opencvReady;
  const [{ Eye }, config, { clipName }] = await Promise.all([import('./eye.js'), import('./config.js'), import('./reel-face.js')]);
  const settings = await config.loadConfig();
  const setup = await config.loadSetup(savedSetup);
  const layout = await (await fetch(new URL('../../vendor/mediapipe/canonical_face_model.obj', self.location.href))).text();
  const faceClipUrl = settings.reel_face.test_face_clip ? config.rootUrl(settings.reel_face.test_face_clip) : '';
  const [clips, faceClip] = await Promise.all([findClips(settings, config.rootUrl, clipName), faceClipUrl ? exists(faceClipUrl) : false]);
  eye = new Eye({
    config: settings, setup, devices, layout, clips, faceClip: faceClip ? faceClipUrl : '',
    out: {
      send: (message, { to = null, skip = null }) => post({ kind: 'send', message, to, skip }),
      frame: (name, blob) => post({ kind: 'frame', name, blob }),
      saveSetup: (saved) => post({ kind: 'save', setup: saved }),
      openCamera: (name, mode) => post({ kind: 'camera', name, mode }),
      closeCamera: () => post({ kind: 'camera', name: null }),
      refreshDevices: () => post({ kind: 'refresh_devices' }),
    },
  });
  for (const data of waiting.splice(0)) receive(data);
  post({ kind: 'ready', faceClip: faceClip ? faceClipUrl : '', previewFps: settings.cameras.preview_fps });
}

// Frames as pictures, into one reused OpenCV Mat.
const canvas = new OffscreenCanvas(1, 1);
const context = canvas.getContext('2d', { willReadFrequently: true });
let mat = null;

function frameFromPicture(picture) {
  const width = picture.displayWidth ?? picture.width;
  const height = picture.displayHeight ?? picture.height;
  if (!width || !height) {
    picture.close();
    return;
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.drawImage(picture, 0, 0, width, height);
  picture.close();
  const { data } = context.getImageData(0, 0, width, height);
  if (!mat || mat.cols !== width || mat.rows !== height) {
    mat?.delete();
    mat = new self.cv.Mat(height, width, self.cv.CV_8UC4);
  }
  mat.data.set(data);
  eye.frame(mat);
}

// The detection camera's frames, as they come (MediaStreamTrackProcessor's stream, from the page).
async function readFrames(readable) {
  const mine = ++streams;
  const reader = readable.getReader();
  try {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      if (mine !== streams) {
        frame.close();
        break;
      }
      frameFromPicture(frame);
    }
  } catch {
    // the camera went away: the page reports it and opens it again
  } finally {
    reader.cancel().catch(() => {});
  }
}
