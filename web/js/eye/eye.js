// The Chrome version of the eye: what eye/server.py does, without a server.
// It runs in a worker (worker.js) in one of the open pages (host.js), and
// talks to every page over a BroadcastChannel with the same messages the
// Python eye sends over its WebSockets (see server.py for the list).
//
// It runs the swipe detector on the detection camera, the journey and the
// reel face's formation. Pages show the other cameras themselves, straight
// from Chrome (cameras.js). Nothing about a visit is ever stored.

import { cameraModes, defaultSetup, isValid } from './config.js';
import { completeLook, describedLook } from './look-settings.js';
import { Journey } from './journey.js';
import { ReelFace } from './reel-face.js';
import { ReelSampler } from './sampler.js';
import { DETECTION_VIEW, SwipeWatcher, looksLikeNoSignal } from './watcher.js';

const UPDATES_PER_SECOND = 10;
const FACE_REPORT_SECONDS = 2;      // a page's "I see a face" holds this long without another
const MOVEMENT_REPORT_SECONDS = 3;  // ...and its "I see movement"
const SAVE_AFTER = 0.5;             // the editor sends changes many times a second while dragging

const now = () => performance.now() / 1000;

function validZone(zone) {
  if (!Array.isArray(zone) || zone.length !== 4) return null;
  const corners = zone.map((corner) => (Array.isArray(corner) && corner.length === 2 ? corner.map(Number) : null));
  if (corners.some((corner) => !corner || corner.some((v) => !(v >= 0 && v <= 1)))) return null;
  return corners.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
}

export class Eye {
  // out: { send(message, { to, skip }), frame(name, blob), saveSetup(setup), openCamera(name, mode), closeCamera() }
  constructor({ config, setup, devices, layout, clips, faceClip, out }) {
    this.config = config;
    this.out = out;
    this.devices = devices;
    this.faceClip = faceClip; // the test clip's address, if there is one
    this.setup = setup ?? defaultSetup(devices, config.cameras.default_device);
    this.setup.look = completeLook(this.setup.look);
    const t = now();
    this.journey = new Journey(config.journey, (message) => this.broadcast(message), t);
    this.reelFace = new ReelFace(config.reel_face, layout);
    this.reelFace.clips = clips;
    this.visitSeen = this.journey.visits;
    this.stageSeen = this.journey.stage;
    this.sampler = new ReelSampler(config.reel_face, config.detection.rotate, (reel) => this.onReel(reel));
    this.watcher = new SwipeWatcher(config.detection, (event) => this.onDetection(event), this.sampler);
    this.clients = new Map(); // id → { watching, faceSeenAt, movementSeenAt }
    this.camera = { status: 'starting', fps: 0, width: 0, height: 0 }; // the detection camera
    this.frames = 0;
    this.framesSince = t;
    this.saveTimer = null;
    this.still = null; // this visit's still, in memory only
    this.syncCameras();
    this.watchDetectionCamera();
    this.timers = [
      setInterval(() => this.pumpJourney(), 1000 / UPDATES_PER_SECOND),
      setInterval(() => this.broadcast(this.status()), 1000),
    ];
  }

  // Pages

  join(id) {
    this.clients.set(id, { watching: new Set(), faceSeenAt: -1e9, movementSeenAt: -1e9 });
    const t = now();
    this.send(id, {
      type: 'hello', setup: this.setup, devices: this.devices, monitors: [], status: this.status(),
      journey: this.journey.snapshot(t), reel_face: this.reelFace.message(), still: this.stillMessage(),
      look_settings: describedLook(),
      // For the pages, which open their own cameras in the Chrome version (cameras.js).
      local: { face_clip: this.faceClip, preview_fps: this.config.cameras.preview_fps, reconnect_seconds: this.config.cameras.reconnect_seconds },
    });
    for (const tile of this.reelFace.shownTiles()) this.send(id, ReelFace.tileMessage(tile, false)); // the face so far, at once
  }

  leave(id) {
    this.clients.delete(id);
  }

  send(id, message) {
    this.out.send(message, { to: id });
  }

  broadcast(message, skip = null) {
    this.out.send(message, { skip });
  }

  notice(id, text) {
    this.send(id, { type: 'notice', text });
  }

  handle(id, message) {
    if (!this.clients.has(id)) this.join(id); // a page that spoke before joining (the eye restarted, say)
    const client = this.clients.get(id);
    const kind = message?.type;
    const t = now();
    switch (kind) {
      case 'watch':
        client.watching = new Set(message.cameras ?? []);
        break;
      case 'setup': {
        const setup = message.setup;
        if (!isValid(setup)) {
          this.notice(id, "The eye ignored a setup it couldn't read.");
          return;
        }
        setup.look = completeLook(setup.look ?? this.setup.look);
        this.setup = setup;
        this.syncCameras();
        this.watchDetectionCamera();
        this.saveSoon();
        this.broadcast({ type: 'setup', setup }, id);
        break;
      }
      case 'refresh_devices':
        this.out.refreshDevices();
        break;
      case 'lock_zone': case 'unlock_zone': case 'set_zone': {
        let zone = null;
        if (kind === 'lock_zone') zone = this.watcher.detector.zoneFromQuad(this.watcher.frameSize);
        else if (kind === 'set_zone') zone = validZone(message.zone);
        if (kind !== 'unlock_zone' && zone === null) {
          this.notice(id, kind === 'lock_zone' ? 'No phone outline to lock yet. Put the phone under the camera first.'
            : "The eye couldn't use those corners. Click four on the detection view.");
          return;
        }
        this.setup.detection_zone = zone;
        this.watchDetectionCamera();
        this.saveSoon();
        this.broadcast({ type: 'setup', setup: this.setup });
        break;
      }
      case 'record':
        this.notice(id, 'Recording footage needs the Python eye (run.ps1 or run.sh).');
        break;
      case 'face_seen':
        client.faceSeenAt = message.present ? t : -1e9;
        if (message.moving) client.movementSeenAt = t;
        break;
      case 'place_phone':
        this.journey.overridePhone(message.present ? true : null, t);
        this.broadcast(this.status());
        break;
      case 'reset':
        this.journey.reset(t);
        break;
      case 'reelface_intensity':
        this.reelFace.setIntensity(typeof message.value === 'number' ? message.value : null);
        this.broadcast(this.reelFace.message());
        break;
      case 'reelface_scrub':
        this.reelFace.scrub(Number.isInteger(message.reels) ? message.reels : null);
        this.broadcast(this.reelFace.message());
        break;
      case 'reelface_reset':
        this.reelFace.resetCopy();
        this.broadcast(this.reelFace.message());
        break;
      case 'speech_pause':
        this.reelFace.speechPaused = Boolean(message.paused);
        this.broadcast(this.reelFace.message());
        break;
      case 'speech_mute':
        this.reelFace.muted = Boolean(message.muted);
        this.broadcast(this.reelFace.message());
        break;
      case 'reelface_test_reels':
        this.journey.beginWatching(t);
        if (!(this.journey.stage === 'forming' && this.reelFace.addTestReels(Math.trunc(message.count ?? 1), t))) {
          this.notice(id, 'Test reels count once the oracle has asked to watch some: wait for it to ask for the phone, then press Phone placed.');
        }
        this.broadcast(this.reelFace.message());
        break;
      case 'climax_now':
        if (this.journey.stage === 'forming' && this.reelFace.shown) this.beginClimax(t);
        else this.notice(id, 'The climax needs a face to break: add reels first.');
        break;
      case 'still_picture':
        this.receiveStill(message.jpeg);
        break;
      default:
        break;
    }
  }

  status() {
    const cameras = {};
    // Frames that stop coming: the camera's gone quiet (unplugged, or the page that opened it froze).
    if (this.camera.status === 'ok' && now() - (this.lastFrameAt ?? 0) > 2) this.camera = { ...this.camera, status: 'lost', fps: 0 };
    if (this.setup.detection_camera) cameras[this.setup.detection_camera] = { ...this.camera };
    return {
      type: 'status', cameras, open_screens: [], detection: this.watcher.info(),
      phone_override: this.journey.phoneOverride,
    };
  }

  // The cameras

  // The face camera, which the reel face tracks live: camera, test (the test clip) or none.
  faceFeed() {
    if (this.setup.face_camera) return 'camera';
    return this.faceClip ? 'test' : 'none';
  }

  syncCameras() {
    this.reelFace.faceFeed = this.faceFeed();
    this.reelFace.setLook(this.setup.look);
    const name = this.setup.detection_camera ?? '';
    const mode = name ? cameraModes(this.setup)[name] : null;
    const wanted = JSON.stringify([name, mode]);
    if (wanted !== this.cameraWanted) {
      this.cameraWanted = wanted;
      this.camera = { status: name ? 'starting' : 'stopped', fps: 0, width: 0, height: 0 };
      if (name) this.out.openCamera(name, mode);
      else this.out.closeCamera();
    }
  }

  watchDetectionCamera() {
    this.watcher.watch(this.setup.detection_camera ?? '', this.setup.detection_zone);
  }

  setDevices(devices) {
    this.devices = devices;
    this.broadcast({ type: 'devices', devices, monitors: [] });
  }

  // The detection camera's state, from the page that opened it.
  cameraStatus(status) {
    this.camera = { ...this.camera, status };
    if (status !== 'ok') this.camera.fps = 0;
  }

  // A frame from the detection camera (an RGBA Mat).
  frame(mat, t = now()) {
    this.lastFrameAt = t;
    this.frames += 1;
    if (t - this.framesSince >= 1) {
      const noSignal = looksLikeNoSignal(mat, this.config.cameras.no_signal_flatness);
      this.camera = {
        status: noSignal ? 'no_signal' : 'ok',
        fps: Math.round((this.frames / (t - this.framesSince)) * 10) / 10,
        width: mat.cols,
        height: mat.rows,
      };
      this.frames = 0;
      this.framesSince = t;
    }
    const watched = [...this.clients.values()].some((client) => client.watching.has(DETECTION_VIEW));
    try {
      this.watcher.process(mat, t, watched, (blob) => this.out.frame(DETECTION_VIEW, blob));
    } catch (error) {
      // One bad frame mustn't stop detection for the rest of the day.
      if (t - (this.lastErrorAt ?? 0) > 10) {
        this.lastErrorAt = t;
        console.error('Swipe watcher:', error);
      }
    }
  }

  // The visit

  onDetection(event) {
    if (event.type === 'phone') this.journey.onPhone(event.present, event.t);
    else if (event.type === 'swipe') this.broadcast(event); // every detected swipe, for testing and tuning
  }

  // A reel was watched long enough. It counts only once the phone is on the platform.
  onReel(reel) {
    this.journey.beginWatching(now());
    if (this.journey.counting && this.reelFace.addReel(reel)) this.broadcast(this.reelFace.message());
  }

  followVisit() {
    let changed = false;
    if (this.journey.visits !== this.visitSeen) {
      this.visitSeen = this.journey.visits;
      this.reelFace.begin();
      changed = true;
    } else if ((this.journey.stage === 'empty' || this.journey.stage === 'ended') && this.reelFace.on) {
      this.reelFace.end();
      changed = true;
    }
    if (this.journey.stage !== this.stageSeen) {
      if (this.journey.stage === 'asking') this.sampler.reset(); // reels watched before the phone went down don't count
      this.stageSeen = this.journey.stage;
    }
    if (changed) {
      this.sampler.reset();
      this.broadcast(this.reelFace.message());
    }
  }

  beginClimax(t) {
    this.journey.beginClimax(t);
    this.broadcast({ type: 'scream', clip: this.reelFace.clipFor('scream') });
  }

  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.out.saveSetup(this.setup), SAVE_AFTER * 1000);
  }

  pumpJourney() {
    const t = now();
    const clients = [...this.clients.values()];
    const face = clients.some((client) => t - client.faceSeenAt < FACE_REPORT_SECONDS);
    const moving = clients.some((client) => t - client.movementSeenAt < MOVEMENT_REPORT_SECONDS);
    this.journey.onPresence(face || moving, face, t);
    this.journey.tick(t);
    this.followVisit();
    this.dropOldStill(t);
    const job = this.reelFace.nextToPlan();
    if (job) this.plan(job);
    const tiles = this.reelFace.tick(t);
    for (const tile of tiles) this.broadcast(ReelFace.tileMessage(tile));
    if (tiles.length) this.broadcast(this.reelFace.message());
    // The face speaks while it's forming and someone is there to speak for.
    const word = this.reelFace.speak(t, this.journey.stage === 'forming' && this.journey.present);
    if (word) this.broadcast(word);
    if (this.journey.stage === 'forming' && this.reelFace.progress >= 1) this.beginClimax(t); // the face is complete
    this.broadcast(this.journey.snapshot(t));
  }

  async plan(job) {
    let tiles = [];
    try {
      tiles = await job.plan();
    } catch (error) {
      console.error(`Couldn't cut reel ${job.reel.number} into fragments:`, error);
    }
    this.reelFace.planned(job, tiles, now());
  }

  // The visitor's still. With no server here, no other device can fetch it, so
  // there's no code: their face shows on its own.

  receiveStill(jpeg) {
    if (!['climax', 'dark', 'still'].includes(this.journey.stage) || this.still || !(jpeg instanceof Blob)) return;
    this.still = { jpeg, visit: this.journey.visits, expires: now() + this.config.still.keep_seconds };
    this.broadcast(this.stillMessage());
  }

  stillMessage() {
    return { type: 'still', url: null, qr: null };
  }

  dropOldStill(t) {
    if (this.still && (t >= this.still.expires || this.still.visit !== this.journey.visits)) this.still = null;
  }
}

