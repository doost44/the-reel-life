// The cameras a page shows, in the Chrome version: each page opens the ones it
// needs itself, straight from Chrome, and hands their frames to the page as
// the Python eye's WebSocket does (onFrame(name, ImageBitmap)). "@face" is the
// face camera (or the test clip); "@detection" comes from the eye instead.

import { cameraModes } from './config.js';
import { applyExposure, camerasAllowed, constraintsFor, listCameras, statusForError } from './devices.js';

const FACE_VIEW = '@face';
const DETECTION_VIEW = '@detection';

export class LocalCameras {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.setup = null;
    this.faceClip = '';
    this.fps = 30;
    this.retrySeconds = 2;
    this.watching = [];
    this.sources = new Map(); // a camera's name (or "clip: <url>") → { names, stream, video, status, ... }
    navigator.mediaDevices?.addEventListener('devicechange', () => this.retryAll());
  }

  configure({ face_clip: faceClip, preview_fps: fps, reconnect_seconds: retry } = {}) {
    this.faceClip = faceClip ?? '';
    this.fps = fps ?? 30;
    this.retrySeconds = retry ?? 2;
    this.sync();
  }

  useSetup(setup) {
    this.setup = setup;
    this.sync();
  }

  watch(names) {
    this.watching = names;
    this.sync();
  }

  // The source a watched name comes from.
  sourceOf(name) {
    if (name === DETECTION_VIEW) return null;
    if (name === FACE_VIEW) {
      const face = this.setup?.face_camera;
      if (face) return face;
      return this.faceClip ? `clip: ${this.faceClip}` : null;
    }
    return name || null;
  }

  sync() {
    if (!this.setup) return;
    const wanted = new Map();
    for (const name of this.watching) {
      const source = this.sourceOf(name);
      if (!source) continue;
      if (!wanted.has(source)) wanted.set(source, new Set());
      wanted.get(source).add(name);
    }
    const modes = cameraModes(this.setup);
    for (const [source, camera] of this.sources) {
      const mode = JSON.stringify(modes[source] ?? null);
      if (!wanted.has(source) || camera.mode !== mode) {
        this.stop(camera);
        this.sources.delete(source);
      }
    }
    for (const [source, names] of wanted) {
      const existing = this.sources.get(source);
      if (existing) existing.names = names;
      else {
        const camera = { source, names, mode: JSON.stringify(modes[source] ?? null), status: 'starting', fps: 0, width: 0, height: 0, frames: 0, since: performance.now() };
        this.sources.set(source, camera);
        this.start(camera, modes[source]);
      }
    }
  }

  stop(camera) {
    camera.stopped = true;
    clearTimeout(camera.timer);
    for (const track of camera.stream?.getTracks() ?? []) track.stop();
    camera.video?.remove();
  }

  retryAll() {
    for (const camera of this.sources.values()) {
      if (!camera.stream && !camera.stopped && !camera.source.startsWith('clip: ')) {
        clearTimeout(camera.timer);
        this.start(camera, JSON.parse(camera.mode));
      }
    }
  }

  later(camera, mode) {
    clearTimeout(camera.timer);
    camera.timer = setTimeout(() => this.start(camera, mode), this.retrySeconds * 1000);
  }

  async start(camera, mode) {
    if (camera.stopped) return;
    const video = camera.video ?? Object.assign(document.createElement('video'), { muted: true, playsInline: true, autoplay: true });
    video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
    if (!video.isConnected) document.body.append(video);
    camera.video = video;
    if (camera.source.startsWith('clip: ')) {
      video.src = camera.source.slice('clip: '.length);
      video.loop = true;
    } else {
      if (!(await camerasAllowed())) {
        camera.status = 'not allowed';
        return this.later(camera, mode);
      }
      const device = (await listCameras()).find((candidate) => candidate.name === camera.source);
      if (camera.stopped) return undefined;
      if (!device) {
        camera.status = 'missing';
        return this.later(camera, mode);
      }
      try {
        camera.stream = await navigator.mediaDevices.getUserMedia(constraintsFor(device.deviceId, mode ?? { width: 720, height: 480, fps: 30 }));
      } catch (error) {
        camera.status = statusForError(error);
        return this.later(camera, mode);
      }
      if (camera.stopped) return this.stop(camera);
      const [track] = camera.stream.getVideoTracks();
      await applyExposure(track, mode?.exposure);
      track.addEventListener('ended', () => {
        if (camera.stopped) return;
        camera.stream = null;
        camera.status = 'lost';
        this.later(camera, mode);
      });
      video.srcObject = camera.stream;
    }
    video.play().catch(() => {});
    this.pump(camera, video);
    return undefined;
  }

  // A picture of each frame for every name watching it, at most fps a second.
  pump(camera, video) {
    let last = 0;
    const next = (now) => {
      if (camera.stopped || camera.video !== video) return;
      if (now - last >= 1000 / this.fps - 2 && video.videoWidth) {
        last = now;
        camera.frames += 1;
        for (const name of camera.names) createImageBitmap(video).then((bitmap) => this.onFrame(name, bitmap), () => {});
      }
      if (now - camera.since >= 1000) {
        camera.fps = Math.round((camera.frames * 1000 / (now - camera.since)) * 10) / 10;
        camera.frames = 0;
        camera.since = now;
        camera.width = video.videoWidth;
        camera.height = video.videoHeight;
        camera.status = camera.fps > 0 ? 'ok' : camera.status === 'ok' ? 'lost' : camera.status;
      }
      video.requestVideoFrameCallback(next);
    };
    video.requestVideoFrameCallback(next);
  }

  // How the cameras open here are doing, by name, as the eye's status message has them.
  info() {
    const cameras = {};
    for (const camera of this.sources.values()) {
      if (camera.source.startsWith('clip: ')) continue;
      cameras[camera.source] = { status: camera.status, fps: camera.fps, width: camera.width, height: camera.height };
    }
    return cameras;
  }
}
