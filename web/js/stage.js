// Draws one screen. Every item is an element positioned in screen pixels on
// a stage the size of the screen, and the stage is scaled to fit its
// container. The editor and the fullscreen screens both draw with this, so
// the editor's preview is exactly what the screen shows.
//
// To add a new kind of source, add an entry to SOURCE_TYPES: its defaults,
// the fields the editor shows, and a view. A view has an element (el) and
// update(item); it can also have draw(now) for animation, journey(snapshot)
// for where the visit is, oracle(line) for the oracle speaking, and
// reelFace(info) for the reel face's state.

import { OracleView, ORACLE_DEFAULTS } from './oracle.js';
import { REEL_FACE_DEFAULTS, FACE_VIEW, ReelFaceView } from './reelface.js';
import { drawVHS, drawNoSignal } from './vhs.js';

const FONTS = ['Consolas', 'Arial Black', 'Impact', 'Georgia', 'Segoe UI', 'Courier New'];
// The journey's stages (journey.py).
export const STAGES = ['empty', 'awake', 'asking', 'forming', 'climax', 'dark', 'still', 'ended'];
export const DETECTION_VIEW = '@detection';

const fontField = { key: 'font', label: 'Font', kind: 'select', options: FONTS };

export const SOURCE_TYPES = {
  reelface: {
    label: 'Reel face',
    box: [1, 1], // a new one's size, as shares of the screen
    defaults: REEL_FACE_DEFAULTS,
    fields: [
      { key: 'background', label: 'Background', kind: 'color' },
      { key: 'shade', label: 'Facet shading %', kind: 'number', min: 0, max: 100 },
      { key: 'fill', label: 'Face fills % of height', kind: 'number', min: 20, max: 150 },
      { key: 'size', label: 'Text size', kind: 'number', min: 4, max: 400 },
      fontField,
      { key: 'color', label: 'Text colour', kind: 'color' },
    ],
    create: (stage) => new ReelFaceView(stage),
  },
  oracle: {
    label: 'Oracle',
    box: [0.8, 0.12],
    defaults: ORACLE_DEFAULTS,
    fields: [
      { key: 'size', label: 'Size', kind: 'number', min: 4, max: 400 },
      fontField,
      { key: 'color', label: 'Colour', kind: 'color' },
      { key: 'align', label: 'Align', kind: 'select', options: ['left', 'center', 'right'] },
      { key: 'speak', label: 'Speak it (screens with sound)', kind: 'checkbox' },
    ],
    create: (stage) => new OracleView(stage),
  },
  camera: {
    label: 'Camera',
    defaults: { camera: '', fit: 'cover', vhs: true, crop: { top: 0, right: 0, bottom: 0, left: 0 } },
    fields: [
      { key: 'camera', label: 'Device', kind: 'camera' },
      { key: 'fit', label: 'Fit', kind: 'select', options: ['cover', 'contain', 'stretch'] },
      { key: 'vhs', label: 'VHS overlay', kind: 'checkbox' },
      { key: 'crop.top', label: 'Crop top %', kind: 'number', min: 0, max: 95 },
      { key: 'crop.bottom', label: 'Crop bottom %', kind: 'number', min: 0, max: 95 },
      { key: 'crop.left', label: 'Crop left %', kind: 'number', min: 0, max: 95 },
      { key: 'crop.right', label: 'Crop right %', kind: 'number', min: 0, max: 95 },
    ],
    create: (stage) => new CameraView(stage),
  },
  text: {
    label: 'Text',
    defaults: { text: 'TEXT', size: 96, color: '#ffffff', font: 'Consolas', align: 'center' },
    fields: [
      { key: 'text', label: 'Text', kind: 'textarea' },
      { key: 'size', label: 'Size', kind: 'number', min: 4, max: 1000 },
      { key: 'color', label: 'Colour', kind: 'color' },
      fontField,
      { key: 'align', label: 'Align', kind: 'select', options: ['left', 'center', 'right'] },
    ],
    create: () => new TextView(),
  },
  color: {
    label: 'Colour',
    defaults: { color: '#b4b1ab' },
    fields: [{ key: 'color', label: 'Colour', kind: 'color' }],
    create: () => new ColorView(),
  },
  detection: {
    label: 'Detection view',
    box: [0.4, 0.4],
    defaults: {},
    fields: [],
    create: (stage) => new CameraView(stage, DETECTION_VIEW),
  },
};

// Statuses where the camera isn't giving a picture worth showing.
const NO_PICTURE = {
  no_signal: 'NO SIGNAL',
  missing: 'CAMERA NOT FOUND',
  busy: 'CAMERA BUSY',
  lost: 'CAMERA LOST',
  stopped: 'CAMERA OFF',
};

// The cameras a screen needs frames from.
export function camerasIn(screen) {
  if (!screen) return [];
  // The reel face needs the face camera too: it tracks the face live.
  const fixed = { detection: [DETECTION_VIEW], reelface: [FACE_VIEW] };
  return screen.items.flatMap((item) => (item.type === 'camera' ? [item.camera] : fixed[item.type] ?? []));
}

export class Stage {
  constructor(container) {
    this.container = container;
    this.el = document.createElement('div');
    this.el.className = 'stage';
    this.itemsEl = layer('stage-items');
    this.el.append(this.itemsEl);
    container.append(this.el);
    this.speechAllowed = false; // screens with sound may speak; the editor doesn't
    this.editing = false; // the editor's preview, which shows stand-ins for what isn't there
    this.tool = false;    // a page for whoever runs the exhibit, which may show notes a visitor shouldn't see
    this.send = null; // to the eye, for views that report back (the reel face says when it sees a face)
    this.reelFaceInfo = null; // the reel face's latest state from the eye
    this.look = null; // the reel face's look, from the setup (look.py)
    this.journeySnapshot = null; // where the visit is, from the eye
    this.previewStage = null; // the editor can show a stage other than the live one

    this.screen = null;
    this.views = new Map();
    this.feeds = new Map();
    this.cameraStatus = {};
    this.scale = 1;
    this.inset = null; // room kept clear around the screen: { top, right, bottom, left } in pixels
    this.onLayout = () => {};

    new ResizeObserver(() => this.fit()).observe(container);
    const tick = (now) => {
      for (const view of this.views.values()) view.draw?.(now);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  get stage() {
    return this.previewStage ?? this.journeySnapshot?.stage ?? 'empty';
  }

  isShown(item) {
    return item.visible !== false && (!item.states || item.states.includes(this.stage));
  }

  show(screen) {
    this.screen = screen;
    this.el.hidden = !screen;
    if (!screen) return;
    Object.assign(this.el.style, {
      width: `${screen.width}px`,
      height: `${screen.height}px`,
      background: screen.background || '#000',
    });

    const shown = new Set();
    screen.items.forEach((item, index) => {
      const type = SOURCE_TYPES[item.type];
      if (!type) return;
      let view = this.views.get(item.id);
      if (view && view.type !== item.type) {
        view.el.remove();
        view = null;
      }
      if (!view) {
        view = type.create(this);
        view.type = item.type;
        view.el.classList.add('stage-item');
        this.views.set(item.id, view);
        if (this.journeySnapshot) view.journey?.(this.journeySnapshot);
      }
      view.item = item;
      Object.assign(view.el.style, {
        left: `${item.x}px`,
        top: `${item.y}px`,
        width: `${item.w}px`,
        height: `${item.h}px`,
        display: this.isShown(item) ? '' : 'none',
        opacity: String((item.opacity ?? 100) / 100),
      });
      view.update(item);
      // Later items sit on top, like layers.
      if (this.itemsEl.children[index] !== view.el) this.itemsEl.insertBefore(view.el, this.itemsEl.children[index] ?? null);
      shown.add(item.id);
    });
    for (const [id, view] of this.views) {
      if (!shown.has(id)) {
        view.el.remove();
        this.views.delete(id);
      }
    }
    this.fit();
  }

  // The screen scaled to fit the container, less any inset (the look editor
  // keeps the face clear of its cards).
  fit() {
    if (!this.screen) return;
    const { top: insetTop = 0, right = 0, bottom = 0, left: insetLeft = 0 } = this.inset ?? {};
    const width = Math.max(1, this.container.clientWidth - insetLeft - right);
    const height = Math.max(1, this.container.clientHeight - insetTop - bottom);
    const scale = Math.min(width / this.screen.width, height / this.screen.height) || 1;
    const left = insetLeft + (width - this.screen.width * scale) / 2;
    const top = insetTop + (height - this.screen.height * scale) / 2;
    this.el.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
    this.scale = scale;
    this.onLayout();
  }

  frame(camera, bitmap) {
    this.feeds.get(camera)?.close();
    this.feeds.set(camera, bitmap);
  }

  setStatus(cameras) {
    this.cameraStatus = cameras ?? {};
  }

  journey(snapshot) {
    const changed = snapshot.stage !== this.journeySnapshot?.stage;
    this.journeySnapshot = snapshot;
    for (const view of this.views.values()) view.journey?.(snapshot);
    if (changed) this.refreshVisibility();
  }

  oracle(line) {
    for (const view of this.views.values()) view.oracle?.(line);
  }

  reelFace(info) {
    if (!info) return;
    this.reelFaceInfo = info;
    for (const view of this.views.values()) view.reelFace?.(info);
  }

  tile(message) {
    for (const view of this.views.values()) view.tile?.(message);
  }

  word(message) {
    for (const view of this.views.values()) view.word?.(message);
  }

  still(message) {
    if (!message) return;
    for (const view of this.views.values()) view.still?.(message);
  }

  scream(message) {
    for (const view of this.views.values()) view.scream?.(message);
  }

  setPreviewStage(stage) {
    this.previewStage = stage || null;
    this.refreshVisibility();
  }

  refreshVisibility() {
    for (const view of this.views.values()) view.el.style.display = this.isShown(view.item) ? '' : 'none';
    this.onLayout();
  }
}

class CameraView {
  constructor(stage, fixedCamera = null) {
    this.stage = stage;
    this.fixedCamera = fixedCamera;
    this.el = document.createElement('canvas');
    this.ctx = this.el.getContext('2d');
    this.startedAt = performance.now();
  }

  update(item) {
    const w = Math.max(2, Math.round(item.w));
    const h = Math.max(2, Math.round(item.h));
    if (this.el.width !== w || this.el.height !== h) {
      this.el.width = w;
      this.el.height = h;
    }
  }

  draw(now) {
    const { ctx, item } = this;
    if (!item || this.el.style.display === 'none') return;
    const { width: w, height: h } = this.el;
    const camera = this.fixedCamera ?? item.camera;
    const bitmap = this.stage.feeds.get(camera);
    if (this.fixedCamera) {
      if (bitmap) drawFeed(ctx, bitmap, { fit: 'contain' }, w, h);
      else drawNoSignal(ctx, w, h, 'NO DETECTION CAMERA');
      return;
    }
    const status = this.stage.cameraStatus[camera]?.status;
    const problem = !camera ? 'NO CAMERA CHOSEN' : NO_PICTURE[status] ?? (bitmap ? null : 'STARTING');
    if (problem) drawNoSignal(ctx, w, h, problem);
    else drawFeed(ctx, bitmap, item, w, h);
    if (item.vhs) drawVHS(ctx, w, h, now, this.startedAt, !problem);
  }
}

function drawFeed(ctx, bitmap, item, w, h) {
  const crop = item.crop ?? {};
  const sx = (bitmap.width * (crop.left || 0)) / 100;
  const sy = (bitmap.height * (crop.top || 0)) / 100;
  const sw = Math.max(1, bitmap.width * (1 - ((crop.left || 0) + (crop.right || 0)) / 100));
  const sh = Math.max(1, bitmap.height * (1 - ((crop.top || 0) + (crop.bottom || 0)) / 100));
  let dx = 0;
  let dy = 0;
  let dw = w;
  let dh = h;
  if (item.fit !== 'stretch') {
    const scale = (item.fit === 'contain' ? Math.min : Math.max)(w / sw, h / sh);
    dw = sw * scale;
    dh = sh * scale;
    dx = (w - dw) / 2;
    dy = (h - dh) / 2;
  }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.filter = item.vhs ? 'saturate(1.3) contrast(1.08) blur(0.6px)' : 'none';
  ctx.drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh);
  ctx.filter = 'none';
}

class TextView {
  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'text-source';
  }

  update(item) {
    this.el.textContent = item.text;
    Object.assign(this.el.style, {
      fontSize: `${item.size}px`,
      color: item.color,
      fontFamily: `"${item.font}", sans-serif`,
      textAlign: item.align,
      justifyContent: justify(item.align),
    });
  }
}

class ColorView {
  constructor() {
    this.el = document.createElement('div');
  }

  update(item) {
    this.el.style.background = item.color;
  }
}

function layer(className) {
  const element = document.createElement('div');
  element.className = className;
  return element;
}

export function justify(align) {
  return { left: 'flex-start', center: 'center', right: 'flex-end' }[align] ?? 'center';
}
