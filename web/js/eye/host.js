// Which page runs the Chrome version of the eye, and its side of it.
//
// Every open page asks for the same lock; the first to get it runs the eye
// (in worker.js) until it's closed, and the next page in line takes over then,
// starting afresh. All pages, this one too, talk to it over the BroadcastChannel.
//
// This page also opens the detection camera for the eye: Chrome only gives
// cameras to pages, so its frames go to the worker as a stream. And it keeps
// the setup in this browser's storage.

import { applyExposure, camerasAllowed, constraintsFor, listCameras, statusForError } from './devices.js';

export const CHANNEL = 'the-reel-life';
const LOCK = 'the-reel-life-eye';
const SETUP_KEY = 'the-reel-life.setup';
const RETRY_SECONDS = 2;

let hosting = false;

export function isHost() {
  return hosting;
}

// Runs the eye in this page once no other page does. Returns at once.
export function hostWhenFree() {
  if (!navigator.locks) {
    host(); // no locks (an old browser): this page runs it
    return;
  }
  navigator.locks.request(LOCK, () => new Promise(() => host())); // never settles: held while the page is open
}

function readSavedSetup() {
  try {
    return JSON.parse(localStorage.getItem(SETUP_KEY) ?? 'null');
  } catch {
    return null;
  }
}

async function host() {
  hosting = true;
  const bus = new BroadcastChannel(CHANNEL);
  const worker = new Worker(new URL('./worker.js', import.meta.url));
  const camera = new DetectionCamera(worker);
  const names = async () => (await listCameras()).map((device) => device.name);
  worker.postMessage({ kind: 'start', savedSetup: readSavedSetup(), devices: await names() });

  bus.onmessage = ({ data }) => {
    if (data.kind === 'join' || data.kind === 'leave' || data.kind === 'message') worker.postMessage(data);
  };
  worker.onmessage = async ({ data }) => {
    switch (data.kind) {
      case 'send': bus.postMessage({ kind: 'message', message: data.message, to: data.to, skip: data.skip }); break;
      case 'frame': bus.postMessage({ kind: 'frame', name: data.name, blob: data.blob }); break;
      case 'save':
        try {
          localStorage.setItem(SETUP_KEY, JSON.stringify(data.setup));
        } catch {
          // storage full or blocked: the setup lasts until the page closes
        }
        break;
      case 'camera': camera.open(data.name, data.mode); break;
      case 'refresh_devices': worker.postMessage({ kind: 'devices', devices: await names() }); camera.retry(); break;
      case 'ready': bus.postMessage({ kind: 'host' }); break; // pages (re)join: they get the eye's hello
      case 'failed': console.error('The eye could not start:', data.error); bus.postMessage({ kind: 'failed', error: data.error }); break;
      default: break;
    }
  };
  navigator.mediaDevices?.addEventListener('devicechange', async () => {
    worker.postMessage({ kind: 'devices', devices: await names() });
    camera.retry();
  });
}

// The detection camera, opened here and read in the worker.
class DetectionCamera {
  constructor(worker) {
    this.worker = worker;
    this.name = null;
    this.mode = null;
    this.stream = null;
    this.timer = null;
    this.opening = 0;
  }

  status(status) {
    this.worker.postMessage({ kind: 'camera_status', status });
  }

  close() {
    clearTimeout(this.timer);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.video?.remove();
    this.video = null;
  }

  open(name, mode) {
    this.close();
    this.name = name;
    this.mode = mode;
    if (name) this.connect();
  }

  // Again, if it isn't open (it was missing, or busy, or just plugged in).
  retry() {
    if (this.name && !this.stream) {
      clearTimeout(this.timer);
      this.connect();
    }
  }

  later() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), RETRY_SECONDS * 1000);
  }

  async connect() {
    const attempt = ++this.opening;
    const { name, mode } = this;
    if (!(await camerasAllowed())) {
      this.status('not allowed');
      return this.later();
    }
    const device = (await listCameras()).find((candidate) => candidate.name === name);
    if (attempt !== this.opening) return undefined;
    if (!device) {
      this.status('missing');
      return this.later();
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraintsFor(device.deviceId, mode));
    } catch (error) {
      if (attempt === this.opening) {
        this.status(statusForError(error));
        this.later();
      }
      return undefined;
    }
    if (attempt !== this.opening) {
      for (const track of stream.getTracks()) track.stop();
      return undefined;
    }
    this.stream = stream;
    const [track] = stream.getVideoTracks();
    await applyExposure(track, mode.exposure);
    track.addEventListener('ended', () => {
      if (this.stream !== stream) return;
      this.stream = null;
      this.status('lost');
      this.later();
    });
    this.status('starting');
    if (globalThis.MediaStreamTrackProcessor) {
      // Chrome: the frames go straight to the worker, which reads them even when this page is covered.
      const { readable } = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 });
      this.worker.postMessage({ kind: 'stream', readable }, [readable]);
    } else {
      this.readWithVideo(stream);
    }
    return undefined;
  }

  // Other browsers: a video element, and a picture of each frame for the worker.
  readWithVideo(stream) {
    const video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, srcObject: stream });
    video.style.display = 'none';
    document.body.append(video);
    this.video = video;
    video.play().catch(() => {});
    const next = () => {
      if (this.stream !== stream) return;
      createImageBitmap(video).then((bitmap) => this.worker.postMessage({ kind: 'bitmap', bitmap }, [bitmap]), () => {});
      video.requestVideoFrameCallback(next);
    };
    video.requestVideoFrameCallback(next);
  }
}
