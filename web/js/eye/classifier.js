// Sorting a reel into a category: CLIP, in this browser, never online. The
// Chrome version's copy of eye/classifier.py (where it's described): change
// both together.
//
// The same model file as the Python eye, run by ONNX Runtime Web in a worker
// of its own (classifier-worker.js), so the swipe detector never waits for
// it. It loads the first time a reel needs it; if it can't, every reel is
// Unreadable and the visit goes on.

import { cvLib, withMats } from './imaging.js';

export const MODEL_NAME = 'Xenova/clip-vit-base-patch32 vision_model_bnb4';
const SIZE = 224;
const MEAN = [0.48145466, 0.4578275, 0.40821073];
const STD = [0.26862954, 0.26130258, 0.27577711];

// A fingerprint of the categories and their sentences (FNV-1a, 32 bits), as prompts_hash() in Python.
export function promptsHash(categories) {
  const text = categories.map((category) => `${category.name}\x1f${category.prompts.join('\x1e')}`).join('\x1d');
  let value = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) value = Math.imul(value ^ byte, 0x01000193) >>> 0;
  return value.toString(16).padStart(8, '0');
}

// Python's round() (half to even), for the resize, so both eyes cut the same square.
const roundEven = (value) => {
  const floor = Math.floor(value);
  const diff = value - floor;
  return diff > 0.5 ? floor + 1 : diff < 0.5 ? floor : floor % 2 === 0 ? floor : floor + 1;
};

// A picture (ImageData) as CLIP wants it: its short side to 224, the middle 224 × 224, normalised, 3×224×224.
export function preprocess(image) {
  const cv = cvLib();
  return withMats((mat, keep) => {
    const { width, height } = image;
    const scale = SIZE / Math.min(width, height);
    const resized = mat();
    const size = new cv.Size(Math.max(SIZE, roundEven(width * scale)), Math.max(SIZE, roundEven(height * scale)));
    cv.resize(keep(cv.matFromImageData(image)), resized, size, 0, 0, cv.INTER_AREA);
    const y0 = (resized.rows - SIZE) >> 1;
    const x0 = (resized.cols - SIZE) >> 1;
    const out = new Float32Array(3 * SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const at = ((y + y0) * resized.cols + (x + x0)) * 4;
        for (let c = 0; c < 3; c++) out[c * SIZE * SIZE + y * SIZE + x] = (resized.data[at + c] / 255 - MEAN[c]) / STD[c];
      }
    }
    return out;
  });
}

// The closest category, its confidence and the runner-up, from an image embedding.
export function verdict(embedding, names, text, settings) {
  let norm = 0;
  for (const v of embedding) norm += v * v;
  norm = Math.sqrt(norm) + 1e-9;
  const logits = text.map((row) => settings.logit_scale * row.reduce((sum, v, i) => sum + v * (embedding[i] / norm), 0));
  const top = Math.max(...logits);
  const odds = logits.map((logit) => Math.exp(logit - top));
  const total = odds.reduce((a, b) => a + b, 0);
  for (let i = 0; i < odds.length; i++) odds[i] /= total;
  const order = odds.map((_, i) => i).sort((a, b) => odds[b] - odds[a] || a - b);
  const [best, second] = order;
  const confidence = odds[best];
  const round3 = (v) => Math.round(v * 1000) / 1000;
  return {
    category: confidence >= settings.floor ? names[best] : settings.unreadable,
    guess: names[best],
    confidence: round3(confidence),
    runner_up: second === undefined ? null : names[second],
    runner_up_confidence: second === undefined ? null : round3(odds[second]),
  };
}

export class Classifier {
  // rootUrl: the repository's address for a path in it (config.js).
  constructor(settings, rootUrl) {
    this.settings = settings;
    this.rootUrl = rootUrl;
    this.state = 'off';  // off (not needed yet), loading, ready, failed
    this.detail = 'loads the first time a reel needs it';
    this.stale = false;
    this.seconds = 0;
    this.worker = null;
    this.loading = null;
    this.waiting = new Map();
    this.next = 0;
  }

  load() {
    this.loading ??= (async () => {
      this.state = 'loading';
      this.detail = 'loading the model';
      try {
        const response = await fetch(this.rootUrl(this.settings.embeddings), { cache: 'no-store' });
        if (!response.ok) throw new Error(`${this.settings.embeddings}: ${response.status}`);
        const data = await response.json();
        this.names = data.categories.map((category) => category.name);
        this.text = data.categories.map((category) => category.embedding);
        this.stale = data.prompts_hash !== promptsHash(this.settings.categories);
        this.worker = new Worker(new URL('./classifier-worker.js', import.meta.url));
        this.worker.onmessage = ({ data: reply }) => {
          const done = this.waiting.get(reply.id);
          this.waiting.delete(reply.id);
          done?.(reply);
        };
        this.worker.onerror = (event) => this.fail(event.message ?? 'the worker stopped');
        const ready = await this.ask({
          kind: 'load', model: this.rootUrl(this.settings.model), runtime: this.rootUrl('web/vendor/onnxruntime-web/'),
        });
        if (ready.error) throw new Error(ready.error);
        this.state = 'ready';
        this.detail = `${this.names.length} categories${this.stale ? ' (categories changed: run tools/embed_categories.py)' : ''}`;
      } catch (error) {
        this.fail(String(error?.message ?? error));
      }
    })();
    return this.loading;
  }

  fail(message) {
    this.state = 'failed';
    this.detail = `couldn't load: ${message}`.slice(0, 160);
    console.error(`The classifier couldn't load, so every reel is ${this.settings.unreadable}:`, message);
    for (const done of this.waiting.values()) done({ error: message });
    this.waiting.clear();
  }

  ask(message, transfer = []) {
    const id = ++this.next;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  unreadable() {
    return { category: this.settings.unreadable, guess: null, confidence: 0, runner_up: null, runner_up_confidence: null };
  }

  // A private picture's (ImageData) category.
  async classify(image) {
    if (this.state === 'off' || this.state === 'loading') await this.load();
    if (this.state !== 'ready') return this.unreadable();
    const pixels = preprocess(image);
    const reply = await this.ask({ kind: 'classify', pixels }, [pixels.buffer]);
    if (reply.error) return this.unreadable();
    this.seconds = reply.seconds;
    return verdict(reply.embedding, this.names, this.text, this.settings);
  }

  info() {
    return { state: this.state, detail: this.detail, stale: this.stale, ms: Math.round(this.seconds * 1000) };
  }
}
