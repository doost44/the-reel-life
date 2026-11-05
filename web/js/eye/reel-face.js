// The reel face: the participant's own face, formed out of the reels they
// watch. The Chrome version's copy of eye/reel_face.py and eye/distortion.py
// (where it's described): change them together.
//
// Each reel is cut into tiles (formation.js) once the queue runs short, and
// its tiles are released one at a time, so the face visibly builds. Held in
// memory for one visit; nothing is saved.

import { completeLook, defaultLook } from './look-settings.js';
import { progressOf } from './distortion.js';
import { FaceMap, Planner } from './formation.js';
import { Random } from './random.js';
import { testReel } from './sampler.js';

const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;

// The words' recorded clips are named after them: "don't stop" is dont-stop.wav.
export function clipName(text) {
  return text.toLowerCase().replaceAll("'", '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export class ReelFace {
  constructor(settings, faceLayout) {
    this.settings = settings;
    this.override = null;       // the operator's intensity, for testing; null follows the session
    this.faceFeed = 'none';     // the face camera: camera, test (a recorded clip) or none; set by the eye
    this.speechPaused = false;  // the operator: no words for now
    this.muted = false;         // the operator: words shown and mouthed, not heard
    this.clips = new Map();     // recorded words found in voice/, by name: set by the eye
    this.nextWordAt = 0;
    this.look = defaultLook();  // set by the eye from the setup
    this.faceMap = new FaceMap(faceLayout);
    this.random = new Random();
    this.visit = 0;
    this.wipe();
  }

  wipe() {
    this.on = false;            // a visit is on
    this.reels = [];            // the reels counted this visit, oldest first
    this.tiles = [];            // every tile planned, in order; shown once due
    this.shown = 0;             // how many of them are out
    this.scrubTo = null;        // show the face as it was after this many reels
    this.planner = new Planner(this.settings, this.faceMap, this.visit * 1000 + this.random.integers(1000));
    this.planned_ = 0;          // reels planned into tiles so far
    this.job = null;            // the reel being cut now, if any
  }

  // What happens

  begin() {
    this.visit += 1;
    this.wipe();
    this.on = true;
  }

  end() {
    this.visit += 1;
    this.override = null;
    this.wipe();
  }

  addReel(reel) {
    if (!this.on) return false;
    this.reels.push(reel);
    return true;
  }

  // Made-up reels, for trying it without a phone.
  addTestReels(count, t) {
    if (!this.on) return false;
    for (let i = 0; i < Math.max(0, Math.min(count, 50)); i++) this.reels.push(testReel(this.reels.length + 1, t, this.random));
    return true;
  }

  // Back to no face at all: the reels so far are dropped (the visit goes on).
  resetCopy() {
    if (this.on) {
      this.wipe();
      this.on = true;
    }
  }

  scrub(reels) {
    this.scrubTo = reels === null ? null : Math.max(0, Math.trunc(reels));
  }

  setIntensity(value) {
    this.override = value === null ? null : Math.min(1, Math.max(0, Number(value)));
  }

  // The next reel to cut, once the queue of tiles runs short; one at a time.
  nextToPlan() {
    const waiting = this.tiles.length - this.shown;
    if (this.job || this.planned_ >= this.reels.length || waiting >= this.settings.queue_tiles) return null;
    const reel = this.reels[this.planned_];
    this.planned_ += 1;
    const planner = this.planner;
    const look = structuredClone(this.look);
    this.job = { reel, plan: () => planner.plan(reel, look) };
    return this.job;
  }

  // A reel's fragments, cut: queued to be released one at a time. Dropped if
  // the face was wiped while they were being cut.
  planned(job, tiles, t) {
    if (job !== this.job) return;
    this.job = null;
    const seconds = this.settings.reel_seconds * (this.reels.length - this.planned_ > 3 ? 0.5 : 1);
    const gap = seconds / Math.max(1, tiles.length);
    let last = this.tiles.length ? this.tiles[this.tiles.length - 1].due : t;
    for (const tile of tiles) {
      last = Math.max(last + gap, t);
      tile.number = this.tiles.length + 1;
      tile.due = last;
      this.tiles.push(tile);
    }
  }

  // The tiles due by now that haven't been shown.
  tick(t) {
    const due = [];
    while (this.shown < this.tiles.length && this.tiles[this.shown].due <= t) {
      due.push(this.tiles[this.shown]);
      this.shown += 1;
    }
    return due;
  }

  // The next word, when it's time: chosen by how desiring the face is.
  speak(t, allowed) {
    const voice = this.settings.voice;
    if (!(allowed && this.on && !this.speechPaused && this.progress >= voice.speak_from)) {
      this.nextWordAt = Math.max(this.nextWordAt, t + 1.5); // never the instant it's allowed again
      return null;
    }
    if (t < this.nextWordAt) return null;
    const { desire } = this.message();
    const bands = voice.words;
    const words = bands[Math.min(bands.length - 1, Math.trunc(desire * bands.length))];
    const text = words[this.random.integers(words.length)];
    const [calm, urgent] = voice.gap_seconds;
    this.nextWordAt = t + (calm + (urgent - calm) * desire) * this.random.uniform(0.85, 1.15);
    return { type: 'word', text, desire, clip: this.clipFor(text), muted: this.muted };
  }

  clipFor(text) {
    return this.clips.get(clipName(text)) ?? null;
  }

  // How far it has got

  // The reels whose tiles are all out: the face as it stands.
  formed() {
    const complete = new Set(this.tiles.slice(0, this.shown).map((tile) => tile.reel));
    if (this.shown < this.tiles.length) complete.delete(this.tiles[this.shown].reel);
    const reels = this.reels.filter((reel) => complete.has(reel.number));
    return this.scrubTo === null ? reels : reels.slice(0, this.scrubTo);
  }

  shownReels() {
    const reels = this.formed();
    return [reels.length, reels.reduce((sum, reel) => sum + reel.watched, 0)];
  }

  reelMarks() {
    const marks = [];
    let watched = 0;
    this.formed().forEach((reel, index) => {
      watched += reel.watched;
      marks.push(round(progressOf(index + 1, watched, this.settings), 3));
    });
    return marks;
  }

  get progress() {
    const [reels, watched] = this.shownReels();
    return progressOf(reels, watched, this.settings);
  }

  setLook(look) {
    this.look = completeLook(look);
  }

  // What pages see

  message() {
    const [reels, watched] = this.shownReels();
    const at = this.override === null ? progressOf(reels, watched, this.settings) : this.override;
    const desire = Math.min(this.settings.desire_cap, at); // never quite 1: it never resolves
    return {
      type: 'reel_face',
      on: this.on,
      face_feed: this.faceFeed,
      reels: this.reels.length,
      formed_reels: reels,
      waiting_reels: this.scrubTo === null ? Math.max(0, this.reels.length - reels) : 0,
      watched: round(this.reels.reduce((sum, reel) => sum + reel.watched, 0), 1),
      fragments: this.shown,
      scrub: this.scrubTo,
      progress: round(at, 3),
      desire: round(desire, 3),
      override: this.override,
      covered: round(this.planner.covered, 3),
      reel_marks: this.reelMarks(),
      speech_paused: this.speechPaused,
      muted: this.muted,
    };
  }

  static tileMessage(tile, animate = true) {
    return {
      type: 'tile', number: tile.number, reel: tile.reel, rect: tile.rect, outline: tile.outline,
      layer: tile.layer, image: tile.image, animate,
    };
  }

  shownTiles() {
    return this.tiles.slice(0, this.shown);
  }
}
