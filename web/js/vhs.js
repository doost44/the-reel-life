// The camcorder look, drawn over a camera source: scanlines, grain, a slow
// tracking band, a vignette and the on-screen display (REC, battery, date,
// tape counter). Nothing here flashes more than once a second.

import { drawText, textWidth } from './osdfont.js';

const GRAIN_TILES = Array.from({ length: 4 }, () => makeGrain(192));
const MONTHS = ['JAN.', 'FEB.', 'MAR.', 'APR.', 'MAY', 'JUN.', 'JUL.', 'AUG.', 'SEP.', 'OCT.', 'NOV.', 'DEC.'];

// Patterns and gradients belong to one canvas and size, so they're made once per canvas.
const layerCache = new WeakMap();

export function drawVHS(ctx, w, h, now, startedAt, osd = true) {
  const layers = layersFor(ctx, w, h);

  // Tracking band: for 4 s out of every 11 a strip drifts down the picture, nudged sideways.
  const cycle = (now / 1000) % 11;
  if (cycle < 4) {
    const bandHeight = Math.max(4, Math.round(h * 0.05));
    const y = Math.round((cycle / 4) * (h - bandHeight));
    ctx.drawImage(ctx.canvas, 0, y, w, bandHeight, Math.round(w * 0.01), y, w, bandHeight);
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = layers.grain[0];
    ctx.fillRect(0, y, w, bandHeight);
    ctx.globalAlpha = 1;
  }

  ctx.fillStyle = layers.scanlines;
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.globalAlpha = 0.07;
  ctx.translate(Math.random() * 192, Math.random() * 192);
  ctx.fillStyle = layers.grain[Math.floor(now / 70) % layers.grain.length];
  ctx.fillRect(-192, -192, w + 192, h + 192);
  ctx.restore();

  ctx.fillStyle = layers.vignette;
  ctx.fillRect(0, 0, w, h);

  if (osd) drawOSD(ctx, w, h, now, startedAt);
}

export function drawNoSignal(ctx, w, h, label) {
  ctx.fillStyle = '#1730c4';
  ctx.fillRect(0, 0, w, h);
  const px = Math.max(1, Math.min(Math.round(h / 60), Math.floor((w * 0.8) / (label.length * 6))));
  drawText(ctx, label, (w - textWidth(label, px)) / 2, (h - 7 * px) / 2, px);
}

function drawOSD(ctx, w, h, now, startedAt) {
  const px = Math.max(1, Math.round(h / 130));
  const margin = 7 * px;
  const line = 10 * px;
  const date = new Date();

  if (Math.floor(now / 500) % 2 === 0) drawText(ctx, '●', margin, margin, px, '#ff3b30');
  drawText(ctx, 'REC', margin + 8 * px, margin, px);
  drawBattery(ctx, w - margin - 16 * px, margin, px);

  drawText(ctx, clock(date), margin, h - margin - 7 * px - line, px);
  drawText(ctx, `${MONTHS[date.getMonth()]} ${date.getDate()} ${date.getFullYear()}`, margin, h - margin - 7 * px, px);

  const counter = `SP ${tapeCounter(now - startedAt)}`;
  drawText(ctx, counter, w - margin - textWidth(counter, px), h - margin - 7 * px, px);
}

function drawBattery(ctx, x, y, px) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(x + px, y + px, 15 * px, 7 * px);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, 14 * px, px);
  ctx.fillRect(x, y + 6 * px, 14 * px, px);
  ctx.fillRect(x, y, px, 7 * px);
  ctx.fillRect(x + 13 * px, y, px, 7 * px);
  ctx.fillRect(x + 14 * px, y + 2 * px, px, 3 * px);
  for (let bar = 0; bar < 3; bar++) ctx.fillRect(x + (2 + bar * 4) * px, y + 2 * px, 3 * px, 3 * px);
}

function clock(date) {
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours < 12 ? 'AM' : 'PM'} ${hours % 12 || 12}:${minutes}`;
}

function tapeCounter(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(seconds / 60) % 60).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `${Math.floor(seconds / 3600)}:${mm}:${ss}`;
}

function layersFor(ctx, w, h) {
  const key = `${w}x${h}`;
  const cached = layerCache.get(ctx);
  if (cached && cached.key === key) return cached;

  // About 240 visible lines, like an interlaced field.
  const pitch = Math.max(2, Math.round(h / 240));
  const lineTile = document.createElement('canvas');
  lineTile.width = 1;
  lineTile.height = pitch;
  const lineCtx = lineTile.getContext('2d');
  lineCtx.fillStyle = 'rgba(0, 0, 0, 0.32)';
  lineCtx.fillRect(0, pitch - Math.max(1, Math.floor(pitch / 2)), 1, Math.max(1, Math.floor(pitch / 2)));

  const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.5)');

  const layers = {
    key,
    scanlines: ctx.createPattern(lineTile, 'repeat'),
    grain: GRAIN_TILES.map((tile) => ctx.createPattern(tile, 'repeat')),
    vignette,
  };
  layerCache.set(ctx, layers);
  return layers;
}

function makeGrain(size) {
  const tile = document.createElement('canvas');
  tile.width = tile.height = size;
  const tileCtx = tile.getContext('2d');
  const pixels = tileCtx.createImageData(size, size);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const value = Math.random() * 255;
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = value;
    pixels.data[i + 3] = 255;
  }
  tileCtx.putImageData(pixels, 0, 0);
  return tile;
}
