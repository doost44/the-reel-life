// config.yaml (edited by hand) and the setup (saved by the editor). The
// Chrome version's copy of eye/settings.py: change both together.
//
// The Python eye saves the setup to setup.json. The Chrome version keeps it
// in this browser's storage, and starts from setup.json in the repository
// when it has none of its own.

import { completeLook, defaultLook } from './look-settings.js';

const ROOT = new URL('../../../', import.meta.url); // the repository: config.yaml, setup.json, voice/, faces/

export const rootUrl = (path) => new URL(path, ROOT).href;

export const DEFAULT_MODE = { width: 720, height: 480, fps: 30 };
// The detection camera defaults to 60 fps: half the movement between frames, so fast swipes measure cleanly.
export const DETECTION_MODE = { ...DEFAULT_MODE, fps: 60 };

export async function loadConfig() {
  const yaml = await import('../../vendor/js-yaml/js-yaml.mjs');
  const response = await fetch(rootUrl('config.yaml'), { cache: 'no-store' });
  if (!response.ok) throw new Error(`config.yaml: ${response.status}`);
  return yaml.load(await response.text());
}

export function isValid(setup) {
  return Boolean(setup) && typeof setup === 'object' && Array.isArray(setup.screens)
    && setup.screens.every((screen) => screen && typeof screen === 'object' && Array.isArray(screen.items));
}

// The setup saved in this browser, or else the repository's setup.json, or null.
export async function loadSetup(saved) {
  if (isValid(saved)) return migrated(saved);
  try {
    const response = await fetch(rootUrl('setup.json'), { cache: 'no-store' });
    if (response.ok) {
      const setup = await response.json();
      if (isValid(setup)) return migrated(setup);
    }
  } catch {
    // no setup.json: the default layout
  }
  return null;
}

// The exhibit used to be a casino game (archive/the-reel-life-game-version-*.zip).
const RETIRED = new Set(['stat', 'meter', 'callout', 'banner', 'gauge', 'reservoir', 'heartbeat', 'flush', 'hits', 'voice',
  'face', 'payout', 'mirror']);
const RETIRED_SCREENS = new Set(['game', 'game-casino-v1']);

// An older setup made fit for the reel face (see settings.py).
export function migrated(setup) {
  if ('mirror_camera' in setup) {
    setup.face_camera = setup.mirror_camera;
    delete setup.mirror_camera;
  }
  const screens = [];
  for (const screen of setup.screens) {
    if (RETIRED_SCREENS.has(screen.id)) continue;
    const kept = screen.items.filter((item) => !RETIRED.has(item.type));
    for (const item of kept) {
      if (item.type !== 'oracle') delete item.states; // the game's phases mean nothing to the journey
      else if ((item.states ?? []).includes('seen') || (item.states ?? []).includes('oracle')) item.states = ['awake', 'asking', 'forming'];
    }
    screens.push({ ...screen, items: kept });
  }
  setup.screens = screens;
  const home = screens.find((screen) => screen.items.some((item) => item.type === 'reelface'));
  if (!home) screens.unshift(reelFaceScreen());
  else if (!screens.some((screen) => screen.items.some((item) => item.type === 'oracle'))) home.items.push(reelFaceScreen().items[1]);
  setup.look = completeLook(setup.look);
  return setup;
}

// Every camera the setup uses (by any source, by the detector, or as the face
// camera), with the capture size and frame rate to open it at.
export function cameraModes(setup, face = '') {
  const names = new Set();
  for (const screen of setup.screens) for (const item of screen.items) if (item.type === 'camera') names.add(item.camera);
  const detection = setup.detection_camera;
  names.add(detection);
  names.add(face);
  names.delete(undefined);
  names.delete(null);
  names.delete('');
  const chosen = setup.cameras ?? {};
  return Object.fromEntries([...names].map((name) => [name, { ...(name === detection ? DETECTION_MODE : DEFAULT_MODE), ...chosen[name] }]));
}

export function reelFaceScreen() {
  const background = '#b4b1ab';
  return {
    id: 'reelface', name: 'Reel face', width: 1920, height: 1080, background, monitor: '', sound: true,
    items: [
      { id: 'reel-face', type: 'reelface', name: 'Reel face', visible: true, x: 0, y: 0, w: 1920, h: 1080, background, shade: 40, fill: 60,
        size: 40, font: 'Consolas', color: '#141414' },
      { id: 'oracle', type: 'oracle', name: 'Oracle', visible: true, x: 160, y: 950, w: 1600, h: 100, size: 44, font: 'Consolas', color: '#141414',
        align: 'center', speak: true, states: ['awake', 'asking', 'forming'] },
    ],
  };
}

export function operatorScreen() {
  return {
    id: 'operator', name: 'Operator', width: 1280, height: 720, background: '#000000', monitor: '', sound: false,
    items: [{ id: 'operator-detection', type: 'detection', name: 'Detection view', visible: true, x: 0, y: 0, w: 1280, h: 720 }],
  };
}

// A first layout: the reel face, and an operator screen showing what the phone tracker sees.
export function defaultSetup(devices, preferred) {
  const camera = devices.find((name) => name.includes(preferred)) ?? devices[0] ?? '';
  return {
    detection_camera: camera,
    detection_zone: null,
    face_camera: '',
    cameras: camera ? { [camera]: { ...DETECTION_MODE } } : {},
    look: defaultLook(),
    screens: [reelFaceScreen(), operatorScreen()],
  };
}
