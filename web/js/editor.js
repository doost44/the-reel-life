// The setup editor, like a small OBS: screens, the sources on each one,
// which camera each source shows and which monitor each screen opens on.
// Every change goes to the eye, which saves it to setup.json and passes it
// straight on to the open screens. It also runs the exhibit by hand: the
// journey (phone placed, reset) and the reel face (test reels, history,
// intensity). The left panel's tabs split it: Screens, Visit, Cameras.

import { startBackdrop } from './backdrop.js';
import { connect } from './link.js';
import { FACE_VIEW } from './reelface.js';
import { Stage, SOURCE_TYPES, STAGES, DETECTION_VIEW, camerasIn } from './stage.js';

const STAGE_LABELS = { empty: 'Nobody there', awake: 'Awake', asking: 'Asking for reels', forming: 'Forming', climax: 'Climax', dark: 'Dark', still: 'Their still', ended: 'Ended' };
const TABS = ['screens', 'visit', 'cameras'];

const SIZE_PRESETS = [
  [1920, 1080, '1920×1080 · 16:9'],
  [1280, 720, '1280×720 · 16:9'],
  [1024, 768, '1024×768 · 4:3 CRT'],
  [800, 600, '800×600 · 4:3'],
  [640, 480, '640×480 · 4:3'],
  [1080, 1920, '1080×1920 · portrait'],
];
const MODE_DEFAULT = { width: 720, height: 480, fps: 30 };
// Resize handles and where they sit on the box, in percent.
const HANDLES = { nw: [0, 0], n: [50, 0], ne: [100, 0], e: [100, 50], se: [100, 100], s: [50, 100], sw: [0, 100], w: [0, 50] };
const SNAP_DISTANCE = 8; // in editor pixels, whatever the zoom
const MIN_SIZE = 8;

const $ = (selector) => document.querySelector(selector);

const state = {
  setup: null, devices: [], monitors: [], cameras: {}, openScreens: [], screenId: null, itemId: null,
  detection: null, phoneOverride: null,
  corners: null, // while clicking the phone's corners: the ones clicked so far
};
const CORNER_NAMES = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
const history = [];
let drag = null;

const stage = new Stage($('#preview'));
stage.editing = true;
stage.tool = true;
const overlay = el('div', { className: 'overlay' });
stage.el.append(overlay);
stage.onLayout = () => drawOverlay();
startBackdrop(stage, FACE_VIEW); // the face, blurred behind the panels, while the reel face screen is open

const link = connect({
  onMessage,
  onFrame: (name, bitmap) => stage.frame(name, bitmap),
  onConnection: showConnection,
});
stage.send = link.send;

$('#undo').onclick = undo;
$('#refresh').onclick = () => link.send({ type: 'refresh_devices' });
$('#add-screen').onclick = addScreen;
for (const option of document.querySelectorAll('#preview-stage button')) {
  option.onclick = () => {
    for (const other of document.querySelectorAll('#preview-stage button')) other.classList.toggle('active', other === option);
    stage.setPreviewStage(option.dataset.stage);
  };
}
for (const tab of document.querySelectorAll('#left-tabs button')) tab.onclick = () => showTab(tab.dataset.tab);
showTab(loadLocally('setup-tab'));
$('#place-phone').onclick = () => link.send({ type: 'place_phone', present: state.phoneOverride === null });
$('#journey-reset').onclick = () => link.send({ type: 'reset' });
$('#reelface-test-1').onclick = () => link.send({ type: 'reelface_test_reels', count: 1 });
$('#reelface-test-5').onclick = () => link.send({ type: 'reelface_test_reels', count: 5 });
$('#reelface-reset').onclick = () => link.send({ type: 'reelface_reset' });
$('#reelface-history').oninput = (event) => link.send({ type: 'reelface_scrub', reels: Number(event.target.value) });
$('#reelface-live').onclick = () => link.send({ type: 'reelface_scrub', reels: null });
$('#reelface-intensity').oninput = (event) => link.send({ type: 'reelface_intensity', value: Number(event.target.value) / 100 });
$('#reelface-auto').onclick = () => link.send({ type: 'reelface_intensity', value: null });
// A still of the reel face as it is now, saved as a picture by this browser. For documenting
// yourself or people who've agreed: the editor only, never the exhibit's screens.
$('#reelface-still').onclick = () => {
  const view = [...stage.views.values()].find((candidate) => candidate.type === 'reelface');
  if (!view) {
    toast('Select the Reel face screen to save a still of it.');
    return;
  }
  view.requestStill((canvas) => canvas.toBlob((blob) => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    el('a', { href: URL.createObjectURL(blob), download: `reel-face-${stamp}.png` }).click();
  }, 'image/png'));
};
$('#speech-pause').onclick = () => link.send({ type: 'speech_pause', paused: !stage.reelFaceInfo?.speech_paused });
$('#speech-mute').onclick = () => link.send({ type: 'speech_mute', muted: !stage.reelFaceInfo?.muted });

// Messages from the eye

function onMessage(message) {
  switch (message.type) {
    case 'hello':
      state.devices = message.devices;
      state.monitors = message.monitors;
      applyStatus(message.status);
      receiveSetup(message.setup);
      showJourney(message.journey);
      showReelFace(message.reel_face);
      stage.still(message.still);
      break;
    case 'journey':
      showJourney(message);
      break;
    case 'oracle':
      stage.oracle(message);
      break;
    case 'reel_face':
      showReelFace(message);
      break;
    case 'tile':
      stage.tile(message);
      break;
    case 'word':
      stage.word(message);
      break;
    case 'still':
      stage.still(message);
      break;
    case 'setup':
      if (!drag) receiveSetup(message.setup);
      break;
    case 'devices':
      state.devices = message.devices;
      state.monitors = message.monitors;
      renderAll();
      toast(`Found ${message.devices.length} cameras and ${message.monitors.length} monitors.`);
      break;
    case 'status':
      applyStatus(message);
      break;
    case 'notice':
      toast(message.text);
      break;
  }
}

function receiveSetup(setup) {
  state.setup = setup;
  stage.look = setup.look;
  if (!currentScreen()) state.screenId = setup.screens[0]?.id ?? null;
  if (!currentItem()) state.itemId = null;
  renderAll();
}

// The left panel's tabs: one open at a time, remembered.
function showTab(name) {
  const open = TABS.includes(name) ? name : TABS[0];
  for (const tab of document.querySelectorAll('#left-tabs button')) tab.classList.toggle('active', tab.dataset.tab === open);
  for (const section of document.querySelectorAll('#left-panel section[data-tab]')) section.hidden = section.dataset.tab !== open;
  saveLocally('setup-tab', open);
}

function showJourney(journey) {
  if (!journey) return;
  stage.journey(journey);
  const where = journey.stage ?? 'empty';
  $('#journey-stage').replaceChildren(
    el('span', { className: `dot ${where === 'forming' ? 'hot' : where === 'empty' ? '' : 'ok'}` }),
    el('span', { textContent: STAGE_LABELS[where] ?? where }));
  $('#journey-face-dot').className = `dot ${journey.face ? 'ok' : ''}`;
  $('#journey-face').textContent = journey.face ? 'seen' : journey.present ? 'movement' : 'none';
  $('#journey-phone-dot').className = `dot ${journey.phone ? 'ok' : ''}`;
  $('#journey-phone').textContent = journey.phone ? (journey.phone_override === null ? 'placed' : 'placed by hand') : 'not placed';
  $('#journey-readout').textContent = journey.oracle_line ? `“${journey.oracle_line}”`
    : journey.counting ? 'Reels count now.' : where === 'awake' ? 'Waiting for the phone.' : '';
}

function showReelFace(info) {
  if (!info) return;
  stage.reelFace(info);
  const waiting = info.waiting_reels ?? 0;
  $('#reelface-desire').replaceChildren(String(Math.round(100 * info.desire)), el('small', { textContent: '%' }));
  $('#reelface-reels').replaceChildren(String(info.formed_reels ?? 0), ...(waiting ? [el('small', { textContent: ` +${waiting}` })] : []));
  $('#reelface-fragments').textContent = String(info.fragments ?? 0);
  $('#reelface-covered').textContent = `${Math.round(100 * (info.covered ?? 0))}%`;
  const formed = Math.min(info.formed_reels ?? 0, 60);
  $('#reelface-punchcard').replaceChildren(
    ...Array.from({ length: formed }, () => el('i')),
    ...Array.from({ length: Math.min(waiting, 60 - formed) }, () => el('i', { className: 'waiting' })));
  $('#reelface-readout').textContent = info.on
    ? `${info.watched} s of reels watched · ${Math.round(100 * info.progress)}% formed` : 'No visit yet.';
  // History: the face as it was after each reel.
  const slider = $('#reelface-history');
  slider.max = String(Math.max(0, info.reels));
  slider.disabled = info.reels < 1;
  if (info.scrub === null) slider.value = slider.max;
  $('#reelface-history-value').textContent = info.scrub === null ? 'live' : `after ${info.scrub} reels`;
  // How far formed: by hand, or following the session.
  const auto = info.override === null || info.override === undefined;
  $('#reelface-intensity').value = String(Math.round((auto ? info.progress : info.override) * 100));
  $('#reelface-intensity-value').textContent = auto ? `auto ${Math.round(info.progress * 100)}%` : `${Math.round(info.override * 100)}%`;
  $('#speech-pause').textContent = info.speech_paused ? 'Resume speech' : 'Pause speech';
  $('#speech-mute').textContent = info.muted ? 'Unmute' : 'Mute';
}

function applyStatus(status) {
  const openChanged = status.open_screens.join() !== state.openScreens.join();
  state.cameras = status.cameras;
  state.openScreens = status.open_screens;
  state.detection = status.detection;
  state.phoneOverride = status.phone_override;
  stage.setStatus(status.cameras);
  updateCameraStatus();
  updateDetectionStatus();
  $('#place-phone').textContent = state.phoneOverride ? 'Back to tracker' : 'Phone placed';
  $('#place-phone').classList.toggle('on', Boolean(state.phoneOverride));
  if (openChanged && state.setup) {
    renderScreens();
    renderScreenProps();
  }
}

// Editing

const currentScreen = () => state.setup?.screens.find((screen) => screen.id === state.screenId) ?? null;
const currentItem = () => currentScreen()?.items.find((item) => item.id === state.itemId) ?? null;

// Every edit goes through here: keep the old setup for undo, make the edit,
// redraw, and send the new setup to the eye.
function change(edit, { undoable = true, redraw = renderAll } = {}) {
  if (undoable) remember(JSON.stringify(state.setup));
  edit();
  redraw();
  sendSoon();
}

function remember(snapshot) {
  history.push(snapshot);
  if (history.length > 200) history.shift();
}

let sendTimer = null;
function sendSoon() {
  sendTimer ??= setTimeout(sendNow, 60);
}

function sendNow() {
  clearTimeout(sendTimer);
  sendTimer = null;
  link.send({ type: 'setup', setup: state.setup });
}

function undo() {
  const previous = history.pop();
  if (!previous) return;
  receiveSetup(JSON.parse(previous));
  sendSoon();
}

function addScreen() {
  let number = state.setup.screens.length + 1;
  while (state.setup.screens.some((screen) => screen.id === `screen-${number}`)) number++;
  const screen = { id: `screen-${number}`, name: `Screen ${number}`, width: 1920, height: 1080, background: '#000000', monitor: '', items: [] };
  change(() => {
    state.setup.screens.push(screen);
    state.screenId = screen.id;
    state.itemId = null;
  });
}

function deleteScreen(screen) {
  if (!confirm(`Delete the screen "${screen.name}" and everything on it?`)) return;
  link.send({ type: 'close_screen', id: screen.id });
  change(() => {
    state.setup.screens = state.setup.screens.filter((other) => other !== screen);
    state.screenId = state.setup.screens[0]?.id ?? null;
    state.itemId = null;
  });
}

function openScreen(screen) {
  if (!screen.monitor) {
    toast('Choose a monitor for this screen first.');
    return;
  }
  sendNow(); // so the eye opens it with the monitor just chosen
  link.send({ type: 'open_screen', id: screen.id });
}

function addItem(type) {
  const screen = currentScreen();
  if (!screen) return;
  const spec = SOURCE_TYPES[type];
  const count = screen.items.filter((item) => item.type === type).length + 1;
  const [widthShare, heightShare] = spec.box ?? [0.5, 0.25];
  const w = Math.round(screen.width * widthShare);
  const h = Math.min(screen.height, ['camera', 'detection'].includes(type) ? Math.round((w * 3) / 4) : Math.round(screen.height * heightShare));
  const item = {
    id: `${type}-${Date.now().toString(36)}`,
    type,
    name: `${spec.label} ${count}`,
    visible: true,
    x: Math.round((screen.width - w) / 2),
    y: Math.round((screen.height - h) / 2),
    w,
    h,
    ...structuredClone(spec.defaults),
  };
  if (type === 'camera') item.camera = state.setup.detection_camera || state.devices[0] || '';
  change(() => {
    screen.items.push(item);
    state.itemId = item.id;
  });
}

function removeItem(screen, item) {
  change(() => {
    screen.items = screen.items.filter((other) => other !== item);
    if (state.itemId === item.id) state.itemId = null;
  });
}

function moveItem(screen, item, step) {
  const from = screen.items.indexOf(item);
  const to = from + step;
  if (to < 0 || to >= screen.items.length) return;
  change(() => {
    screen.items.splice(from, 1);
    screen.items.splice(to, 0, item);
  });
}

function matchCameraShape(item) {
  const camera = state.cameras[item.camera];
  if (!camera?.width) {
    toast('Waiting for a picture from that camera.');
    return;
  }
  const crop = item.crop ?? {};
  const width = camera.width * (1 - ((crop.left || 0) + (crop.right || 0)) / 100);
  const height = camera.height * (1 - ((crop.top || 0) + (crop.bottom || 0)) / 100);
  change(() => {
    item.h = Math.round((item.w * height) / width);
  });
}

// Panels

function renderAll() {
  if (!state.setup) return;
  renderScreens();
  renderScreenProps();
  renderDetection();
  renderFaceCamera();
  renderCameras();
  renderSources();
  renderItemProps();
  renderStage();
}

// While typing or dragging: everything except the panels being typed in.
function renderLight() {
  renderScreens();
  renderSources();
  renderStage();
  syncGeometryFields();
}

function renderStage() {
  const screen = currentScreen();
  stage.show(screen);
  link.watch(camerasIn(screen));
  drawOverlay();
}

function renderScreens() {
  $('#screens').replaceChildren(...state.setup.screens.map((screen) => {
    const row = el('li', { className: screen.id === state.screenId ? 'selected' : '' },
      el('span', { className: 'name', textContent: screen.name }),
      el('span', { className: 'meta', textContent: `${screen.width}×${screen.height} · ${monitorName(screen.monitor)}` }));
    if (state.openScreens.includes(screen.id)) row.append(el('span', { className: 'live', textContent: 'LIVE' }));
    row.onclick = () => {
      state.screenId = screen.id;
      state.itemId = null;
      renderAll();
    };
    return row;
  }));
}

function renderScreenProps() {
  const screen = currentScreen();
  const box = $('#screen-props');
  if (!screen) {
    box.replaceChildren();
    return;
  }
  const preset = SIZE_PRESETS.find(([w, h]) => w === screen.width && h === screen.height);
  const isOpen = state.openScreens.includes(screen.id);
  box.replaceChildren(
    el('h2', { textContent: 'Screen' }),
    field('Name', textInput(screen.name, (value) => { screen.name = value; })),
    field('Size', selectInput(
      [['', 'Custom'], ...SIZE_PRESETS.map(([w, h, label]) => [`${w}x${h}`, label])],
      preset ? `${preset[0]}x${preset[1]}` : '',
      (value) => {
        if (value) [screen.width, screen.height] = value.split('x').map(Number);
      },
    )),
    field('', el('div', { className: 'pair' },
      numberInput(screen.width, (value) => { screen.width = Math.max(16, Math.round(value)); }),
      numberInput(screen.height, (value) => { screen.height = Math.max(16, Math.round(value)); }))),
    field('Background', colorInput(screen.background, (value) => { screen.background = value; })),
    field('Sound', checkboxInput(screen.sound, (value) => { screen.sound = value; })),
    field('Monitor', selectInput(monitorOptions(screen.monitor), screen.monitor ?? '', (value) => { screen.monitor = value; })),
    el('div', { className: 'button-row' },
      isOpen
        ? button('Close fullscreen', () => link.send({ type: 'close_screen', id: screen.id }))
        : button('Open fullscreen', () => openScreen(screen), 'primary'),
      button('Open in a tab', () => window.open(`/screen/${encodeURIComponent(screen.id)}`, `screen-${screen.id}`)),
      button('Delete', () => deleteScreen(screen), 'danger')),
    el('p', { className: 'note' }, 'Address: ', el('code', { textContent: `/screen/${screen.id}` })),
  );
}

function renderDetection() {
  const { setup } = state;
  const locked = Boolean(setup.detection_zone);
  $('#detection').replaceChildren(
    field('Camera', selectInput(deviceOptions(setup.detection_camera), setup.detection_camera ?? '', (value) => {
      setup.detection_camera = value;
    })),
    el('p', { id: 'detection-readout', className: 'readout' }),
    el('div', { className: 'button-row' },
      locked
        ? button('Unlock phone position', () => link.send({ type: 'unlock_zone' }), 'small')
        : button('Lock phone position', () => link.send({ type: 'lock_zone' }), 'small'),
      state.corners
        ? button(`Cancel (${state.corners.length}/4)`, stopCorners, 'small')
        : button('Click the phone\'s corners', startCorners, 'small'),
      Object.assign(button('', () => link.send({ type: 'record', on: !isRecording() }), 'small'),
        { id: 'record-footage', title: 'Saves the camera and the detection view to footage/live-tests (your own tests only)' })),
    el('p', {
      className: 'note',
      textContent: state.corners
        ? `Click the phone screen's ${CORNER_NAMES[state.corners.length]} corner on a Detection view, as the phone sees it (its top is where the reels scroll to).`
        : locked
          ? 'The phone screen\'s corners are fixed. Unlock to find the phone again.'
          : 'The phone is found by its lit screen on a dark background. Once it sits still, lock its position, or click its corners yourself on any background.',
    }),
    el('p', { className: 'note', textContent: 'Add a "Detection view" source to any screen to see what the detector sees. Recorded clips appear in the camera list too.' }),
  );
  updateDetectionStatus();
}

// Seconds recorded so far, which can be 0, or null when not recording.
const isRecording = () => state.detection?.recording != null;

function updateDetectionStatus() {
  const readout = $('#detection-readout');
  const detection = state.detection;
  if (!readout || !detection) return;
  const recordButton = $('#record-footage');
  recordButton.textContent = isRecording()
    ? `■ Stop recording ${Math.floor(detection.recording / 60)}:${String(detection.recording % 60).padStart(2, '0')}`
    : '● Record footage';
  recordButton.classList.toggle('recording', isRecording());
  const camera = state.cameras[detection.camera];
  const last = detection.last;
  readout.textContent = [
    !detection.camera ? 'no camera chosen'
      : camera?.status !== 'ok' ? `camera: ${describeCamera(camera)[0]}`
        : detection.present ? 'phone: IN' : detection.found ? 'phone: outline found, not lit' : 'phone: not found',
    `swipes seen: ${detection.swipes}`,
    last ? `last: ${last.direction}${last.dwell === null ? '' : ` after ${last.dwell.toFixed(1)} s`}, ${last.speed} screens/s` : '',
  ].filter(Boolean).join('\n');
}

// The face camera: at the platform, looking up at the participant's face. The reel face tracks it live.
function renderFaceCamera() {
  const { setup } = state;
  $('#face-camera').replaceChildren(
    field('Camera', selectInput(deviceOptions(setup.face_camera), setup.face_camera ?? '', (value) => { setup.face_camera = value; })),
    el('p', { className: 'note', textContent: setup.face_camera
      ? 'Put it at the platform, looking up: people look down at their phones. Its pictures only go to the screens, live.'
      : 'None chosen: a recorded test clip plays instead, labelled on screen as test tracking.' }),
  );
}

function renderCameras() {
  const { setup } = state;
  const realCamera = (name) => name && !name.startsWith('@');
  const inUse = [...new Set([...setup.screens.flatMap(camerasIn), setup.detection_camera, setup.face_camera].filter(realCamera))];
  const others = state.devices.filter((name) => !inUse.includes(name));
  // Its own scrolling box, so a long list of cameras and clips doesn't push the rest of the panel away.
  $('#cameras').replaceChildren(el('div', { className: 'camera-list' },
    ...inUse.map(cameraCard),
    others.length ? el('h3', { textContent: 'Not in use' }) : '',
    others.length ? el('ul', { className: 'device-list' }, ...others.map((name) => el('li', {},
      el('span', { className: 'name', textContent: name.replace(/^clip: /, ''), title: name }),
      el('span', { className: 'meta', textContent: name.startsWith('clip: ') ? 'clip' : 'camera' })))) : '',
    state.devices.length ? '' : el('p', { className: 'note', textContent: 'No cameras found. Is ffmpeg installed?' }),
  ));
  updateCameraStatus();
}

function cameraCard(name) {
  // The detection camera defaults to 60 fps, as in the eye (settings.py).
  const defaults = { ...MODE_DEFAULT, fps: name === state.setup.detection_camera ? 60 : MODE_DEFAULT.fps };
  const mode = { ...defaults, ...state.setup.cameras?.[name] };
  const setMode = (key) => (value) => {
    state.setup.cameras ??= {};
    state.setup.cameras[name] = { ...defaults, ...state.setup.cameras[name], [key]: Math.round(value) };
  };
  const status = el('span', { className: 'status' });
  status.dataset.camera = name;
  // Shorter exposures stop a bright phone screen washing out and blur swipes less (cameras.py).
  const exposures = [['', 'Auto'], ...[-4, -5, -6, -7, -8, -9].map((step) => [String(step), `1/${2 ** -step} s`])];
  const exposure = selectInput(exposures, mode.exposure ?? '', (value) => {
    state.setup.cameras ??= {};
    state.setup.cameras[name] = { ...defaults, ...state.setup.cameras[name], exposure: value === '' ? null : Number(value) };
  });
  // Capture settings apply when you leave the field: each change reopens the camera.
  return el('div', { className: 'camera-card' },
    el('div', { className: 'title' }, el('strong', { textContent: name }), status),
    el('div', { className: 'triple' },
      el('label', {}, 'Width', numberInput(mode.width, setMode('width'), { onCommit: true })),
      el('label', {}, 'Height', numberInput(mode.height, setMode('height'), { onCommit: true })),
      el('label', {}, 'FPS', numberInput(mode.fps, setMode('fps'), { onCommit: true }))),
    name.startsWith('clip: ') ? '' : el('label', { className: 'exposure' }, 'Exposure', exposure));
}

function updateCameraStatus() {
  for (const chip of document.querySelectorAll('.status[data-camera]')) {
    const camera = state.cameras[chip.dataset.camera];
    const [text, tone] = describeCamera(camera);
    chip.textContent = text;
    chip.className = `status ${tone}`;
  }
}

function describeCamera(camera) {
  if (!camera) return ['not open', 'warn'];
  switch (camera.status) {
    case 'ok': return [`● ${camera.fps} fps · ${camera.width}×${camera.height}`, 'ok'];
    case 'no_signal': return ['no signal', 'warn'];
    case 'starting': return ['starting…', 'warn'];
    case 'missing': return ['not connected', 'bad'];
    case 'busy': return ['busy: another app has it?', 'bad'];
    default: return [camera.status, 'bad'];
  }
}

function renderSources() {
  const screen = currentScreen();
  $('#add-source').replaceChildren(...(screen
    ? Object.entries(SOURCE_TYPES).map(([type, spec]) => button(`+ ${spec.label}`, () => addItem(type), 'small'))
    : []));
  // Front-most first, like OBS.
  $('#sources').replaceChildren(...(screen ? [...screen.items].reverse().map((item) => sourceRow(screen, item)) : []));
}

function sourceRow(screen, item) {
  const hidden = item.visible === false;
  const label = SOURCE_TYPES[item.type]?.label ?? item.type;
  const row = el('li', { className: `${item.id === state.itemId ? 'selected' : ''} ${hidden ? 'hidden-item' : ''}` },
    iconButton(hidden ? '○' : '●', hidden ? 'Show' : 'Hide', () => change(() => { item.visible = hidden; })),
    el('span', { className: 'name', textContent: item.name || label }),
    el('span', { className: 'meta', textContent: label }),
    iconButton('▲', 'Bring forward', () => moveItem(screen, item, 1)),
    iconButton('▼', 'Send backward', () => moveItem(screen, item, -1)),
    iconButton('✕', 'Remove', () => removeItem(screen, item)));
  row.onclick = () => {
    state.itemId = item.id;
    renderAll();
  };
  return row;
}

function renderItemProps() {
  const screen = currentScreen();
  const item = currentItem();
  const box = $('#item-props');
  if (!item) {
    box.replaceChildren(screen ? el('p', { className: 'note', textContent: 'Select a source to change it.' }) : '');
    return;
  }
  const spec = SOURCE_TYPES[item.type];
  box.replaceChildren(
    el('h2', { textContent: spec?.label ?? item.type }),
    field('Name', textInput(item.name, (value) => { item.name = value; })),
    field('Position', el('div', { className: 'pair' }, geometryInput(item, 'x'), geometryInput(item, 'y'))),
    field('Size', el('div', { className: 'pair' }, geometryInput(item, 'w'), geometryInput(item, 'h'))),
    el('div', { className: 'button-row' },
      button('Fill screen', () => change(() => Object.assign(item, { x: 0, y: 0, w: screen.width, h: screen.height })), 'small'),
      button('Centre', () => change(() => Object.assign(item, {
        x: Math.round((screen.width - item.w) / 2),
        y: Math.round((screen.height - item.h) / 2),
      })), 'small'),
      item.type === 'camera' ? button('Match camera shape', () => matchCameraShape(item), 'small') : ''),
    field('Show during', statesInput(item)),
    field('Opacity %', numberInput(item.opacity ?? 100, (value) => { item.opacity = Math.min(100, Math.max(0, value)); })),
    ...(spec?.fields ?? []).map((fieldSpec) => field(fieldSpec.label, fieldInput(item, fieldSpec))),
  );
}

// Which stages of the journey a source appears in, like OBS scenes. All ticked = always.
function statesInput(item) {
  const box = el('div', { className: 'states' });
  for (const stageName of STAGES) {
    const shown = !item.states || item.states.includes(stageName);
    const checkbox = checkboxInput(shown, (checked) => {
      const states = new Set(item.states ?? STAGES);
      if (checked) states.add(stageName);
      else states.delete(stageName);
      if (states.size === STAGES.length) delete item.states;
      else item.states = STAGES.filter((name) => states.has(name));
    });
    box.append(el('label', {}, checkbox, STAGE_LABELS[stageName]));
  }
  return box;
}

function geometryInput(item, key) {
  const input = numberInput(item[key], (value) => {
    item[key] = Math.round(key === 'w' || key === 'h' ? Math.max(MIN_SIZE, value) : value);
  });
  input.dataset.geometry = key;
  return input;
}

// Keep x, y, w, h showing the item's real values while it's dragged.
function syncGeometryFields() {
  const item = currentItem();
  if (!item) return;
  for (const input of document.querySelectorAll('input[data-geometry]')) {
    if (input !== document.activeElement) input.value = item[input.dataset.geometry];
  }
}

function fieldInput(item, spec) {
  const value = getPath(item, spec.key) ?? getPath(SOURCE_TYPES[item.type]?.defaults ?? {}, spec.key);
  const apply = (next) => setPath(item, spec.key, next);
  switch (spec.kind) {
    case 'camera': return selectInput(deviceOptions(value), value ?? '', apply);
    case 'item': return selectInput([['', '— none —'], ...currentScreen().items.filter((other) => other !== item)
      .map((other) => [other.id, other.name || other.id])], value ?? '', apply);
    case 'select': return selectInput(spec.options.map((option) => [option, option]), value, apply);
    case 'checkbox': return checkboxInput(value, apply);
    case 'number': return numberInput(value, (next) => apply(Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, next))));
    case 'color': return colorInput(value, apply);
    case 'textarea': return textInput(value, apply, true);
    default: return textInput(value, apply);
  }
}

function monitorOptions(current) {
  const options = [['', '— none —'], ...state.monitors.map((monitor) =>
    [monitor.id, `${monitor.label} · ${monitor.width}×${monitor.height}${monitor.primary ? ' · main' : ''}`])];
  if (current && !state.monitors.some((monitor) => monitor.id === current)) options.push([current, `${current} (not connected)`]);
  return options;
}

function monitorName(id) {
  if (!id) return 'no monitor';
  const monitor = state.monitors.find((candidate) => candidate.id === id);
  return monitor ? monitor.label.replace(/ \(.*\)$/, '') : 'not connected';
}

function deviceOptions(current) {
  const options = [['', '— none —'], ...state.devices.map((name) => [name, name])];
  if (current && !state.devices.includes(current)) options.push([current, `${current} (not connected)`]);
  return options;
}

// Clicking the phone's corners on a detection view

function startCorners() {
  if (!currentScreen()?.items.some((item) => item.type === 'detection' && stage.isShown(item))) {
    toast('Pick a screen with a Detection view first, like Operator.');
    return;
  }
  state.corners = [];
  renderDetection();
  drawOverlay();
}

function stopCorners() {
  state.corners = null;
  renderDetection();
  drawOverlay();
}

function clickCorner(point) {
  const item = [...currentScreen().items].reverse().find((candidate) => candidate.type === 'detection' && stage.isShown(candidate)
    && point.x >= candidate.x && point.x <= candidate.x + candidate.w && point.y >= candidate.y && point.y <= candidate.y + candidate.h);
  const picture = stage.feeds.get(DETECTION_VIEW);
  if (!item || !picture) {
    toast(item ? 'Waiting for the detection view\'s picture.' : 'Click on a Detection view.');
    return;
  }
  // The picture is drawn to fit inside the source, like "contain".
  const scale = Math.min(item.w / picture.width, item.h / picture.height);
  const left = item.x + (item.w - picture.width * scale) / 2;
  const top = item.y + (item.h - picture.height * scale) / 2;
  const fraction = [(point.x - left) / (picture.width * scale), (point.y - top) / (picture.height * scale)];
  if (fraction.some((value) => value < 0 || value > 1)) {
    toast('Click on the camera picture itself.');
    return;
  }
  state.corners.push({ point, fraction });
  if (state.corners.length === 4) {
    link.send({ type: 'set_zone', zone: state.corners.map((corner) => corner.fraction) });
    toast('Phone corners set. The detector now watches just that area.');
    state.corners = null;
  }
  renderDetection();
  drawOverlay();
}

// Dragging and resizing in the preview

overlay.addEventListener('pointerdown', (event) => {
  const screen = currentScreen();
  if (!screen || event.button !== 0) return;
  const point = toScreenPoint(event);
  if (state.corners) {
    clickCorner(point);
    return;
  }
  const handle = event.target.dataset.handle;
  const onSelected = handle || event.target.classList.contains('selected');
  const item = onSelected ? currentItem() : itemAt(screen, point);
  if (!item) {
    if (state.itemId) {
      state.itemId = null;
      renderAll();
    }
    return;
  }
  if (item.id !== state.itemId) {
    state.itemId = item.id;
    renderAll();
  }
  drag = { item, handle: handle ?? 'move', start: point, from: { x: item.x, y: item.y, w: item.w, h: item.h }, before: JSON.stringify(state.setup), moved: false };
  overlay.setPointerCapture(event.pointerId);
  event.preventDefault();
});

overlay.addEventListener('pointermove', (event) => {
  if (drag) dragTo(event);
});
overlay.addEventListener('pointerup', endDrag);
overlay.addEventListener('pointercancel', endDrag);

$('#preview').addEventListener('pointerdown', (event) => {
  if (event.target === $('#preview') && state.itemId) {
    state.itemId = null;
    renderAll();
  }
});

function dragTo(event) {
  const point = toScreenPoint(event);
  const dx = point.x - drag.start.x;
  const dy = point.y - drag.start.y;
  if (!drag.moved) {
    if (Math.hypot(dx, dy) * stage.scale < 3) return; // a click, not a drag
    remember(drag.before);
    drag.moved = true;
  }
  const screen = currentScreen();
  const keepShape = event.shiftKey && drag.handle.length === 2;
  const box = drag.handle === 'move'
    ? { ...drag.from, x: drag.from.x + dx, y: drag.from.y + dy }
    : resizedBox(drag.from, drag.handle, dx, dy, keepShape);
  const guides = [];
  if (!event.altKey && !keepShape) snapBox(box, drag.handle, screen, drag.item, guides);
  keepMinimumSize(box, drag.handle, drag.from);
  Object.assign(drag.item, { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.w), h: Math.round(box.h) });
  stage.show(screen);
  syncGeometryFields();
  drawOverlay(guides);
  sendSoon();
}

function endDrag() {
  if (!drag) return;
  const { moved } = drag;
  drag = null;
  drawOverlay();
  if (moved) renderSources();
}

function resizedBox(from, handle, dx, dy, keepShape) {
  let { x, y, w, h } = from;
  if (handle.includes('w')) { x = from.x + dx; w = from.w - dx; }
  if (handle.includes('e')) w = from.w + dx;
  if (handle.includes('n')) { y = from.y + dy; h = from.h - dy; }
  if (handle.includes('s')) h = from.h + dy;
  if (keepShape) {
    const ratio = from.w / from.h;
    if (w / h > ratio) w = h * ratio;
    else h = w / ratio;
    if (handle.includes('w')) x = from.x + from.w - w;
    if (handle.includes('n')) y = from.y + from.h - h;
  }
  return { x, y, w, h };
}

// Pull the moving edges onto the screen's edges and centre, and onto other sources' edges and centres.
function snapBox(box, handle, screen, dragged, guides) {
  const others = screen.items.filter((item) => item !== dragged && stage.isShown(item));
  const xs = [0, screen.width / 2, screen.width, ...others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w])];
  const ys = [0, screen.height / 2, screen.height, ...others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h])];
  const reach = SNAP_DISTANCE / stage.scale;
  const snap = (edges, targets, axis, apply) => {
    const best = nearest(edges, targets, reach);
    if (!best) return;
    apply(best.shift);
    guides.push({ axis, at: best.target });
  };
  if (handle === 'move') {
    snap([box.x, box.x + box.w / 2, box.x + box.w], xs, 'x', (shift) => { box.x += shift; });
    snap([box.y, box.y + box.h / 2, box.y + box.h], ys, 'y', (shift) => { box.y += shift; });
    return;
  }
  if (handle.includes('w')) snap([box.x], xs, 'x', (shift) => { box.x += shift; box.w -= shift; });
  if (handle.includes('e')) snap([box.x + box.w], xs, 'x', (shift) => { box.w += shift; });
  if (handle.includes('n')) snap([box.y], ys, 'y', (shift) => { box.y += shift; box.h -= shift; });
  if (handle.includes('s')) snap([box.y + box.h], ys, 'y', (shift) => { box.h += shift; });
}

function nearest(edges, targets, reach) {
  let best = null;
  for (const edge of edges) {
    for (const target of targets) {
      const shift = target - edge;
      if (Math.abs(shift) <= reach && (!best || Math.abs(shift) < Math.abs(best.shift))) best = { shift, target };
    }
  }
  return best;
}

function keepMinimumSize(box, handle, from) {
  if (box.w < MIN_SIZE) {
    box.w = MIN_SIZE;
    if (handle.includes('w')) box.x = from.x + from.w - MIN_SIZE;
  }
  if (box.h < MIN_SIZE) {
    box.h = MIN_SIZE;
    if (handle.includes('n')) box.y = from.y + from.h - MIN_SIZE;
  }
}

function itemAt(screen, point) {
  return [...screen.items].reverse().find((item) => stage.isShown(item)
    && point.x >= item.x && point.x <= item.x + item.w && point.y >= item.y && point.y <= item.y + item.h);
}

function toScreenPoint(event) {
  const bounds = stage.el.getBoundingClientRect();
  return { x: (event.clientX - bounds.left) / stage.scale, y: (event.clientY - bounds.top) / stage.scale };
}

function drawOverlay(guides = []) {
  const screen = currentScreen();
  overlay.style.setProperty('--unit', `${1 / stage.scale}px`);
  overlay.replaceChildren();
  if (!screen) return;
  for (const item of screen.items) {
    if (!stage.isShown(item)) continue;
    const selected = item.id === state.itemId;
    const box = el('div', { className: selected ? 'outline selected' : 'outline' });
    Object.assign(box.style, { left: `${item.x}px`, top: `${item.y}px`, width: `${item.w}px`, height: `${item.h}px` });
    if (selected) {
      for (const [name, [left, top]] of Object.entries(HANDLES)) {
        const handle = el('div', { className: 'handle' });
        handle.dataset.handle = name;
        Object.assign(handle.style, { left: `${left}%`, top: `${top}%`, cursor: `${name}-resize` });
        box.append(handle);
      }
    }
    overlay.append(box);
  }
  overlay.classList.toggle('picking', Boolean(state.corners));
  (state.corners ?? []).forEach(({ point }, index) => {
    const mark = el('div', { className: 'corner-mark', textContent: index + 1 });
    Object.assign(mark.style, { left: `${point.x}px`, top: `${point.y}px` });
    overlay.append(mark);
  });
  for (const guide of guides) {
    const line = el('div', { className: 'guide' });
    Object.assign(line.style, guide.axis === 'x'
      ? { left: `${guide.at}px`, top: '0', width: 'var(--unit)', height: '100%' }
      : { top: `${guide.at}px`, left: '0', height: 'var(--unit)', width: '100%' });
    overlay.append(line);
  }
}

addEventListener('keydown', (event) => {
  if (event.target.closest?.('input, select, textarea')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undo();
    return;
  }
  if (event.key === 'Escape' && state.corners) {
    stopCorners();
    return;
  }
  const screen = currentScreen();
  const item = currentItem();
  if (!item) return;
  const step = event.shiftKey ? 10 : 1;
  const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
  if (nudge) {
    event.preventDefault();
    change(() => {
      item.x += nudge[0];
      item.y += nudge[1];
    }, { redraw: renderLight });
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    removeItem(screen, item);
  } else if (event.key === 'Escape') {
    state.itemId = null;
    renderAll();
  }
});

// Small builders

function el(tag, props = {}, ...children) {
  const element = Object.assign(document.createElement(tag), props);
  element.append(...children);
  return element;
}

function field(label, input) {
  return el('div', { className: 'field' }, el('span', { textContent: label }), input);
}

function button(text, onClick, className = '') {
  return el('button', { type: 'button', textContent: text, className, onclick: onClick });
}

function iconButton(text, title, onClick) {
  return el('button', {
    type: 'button',
    className: 'icon',
    textContent: text,
    title,
    onclick: (event) => {
      event.stopPropagation();
      onClick();
    },
  });
}

// Typed fields change the setup on every keystroke so the screens follow
// along; undo goes back to how it was before you started typing.
function liveInput(input, read, apply) {
  let before = null;
  input.addEventListener('focus', () => { before = JSON.stringify(state.setup); });
  input.addEventListener('input', () => {
    const value = read();
    if (value === null) return;
    if (before) {
      remember(before);
      before = null;
    }
    change(() => apply(value), { undoable: false, redraw: renderLight });
  });
  return input;
}

function textInput(value, apply, multiline = false) {
  const input = el(multiline ? 'textarea' : 'input', { value: value ?? '' });
  return liveInput(input, () => input.value, apply);
}

function numberInput(value, apply, { onCommit = false } = {}) {
  const input = el('input', { type: 'number', value: value ?? 0 });
  const read = () => (input.value === '' || !Number.isFinite(Number(input.value)) ? null : Number(input.value));
  if (!onCommit) return liveInput(input, read, apply);
  input.addEventListener('change', () => {
    const next = read();
    if (next !== null) change(() => apply(next));
  });
  return input;
}

function colorInput(value, apply) {
  const input = el('input', { type: 'color', value: value || '#000000' });
  return liveInput(input, () => input.value, apply);
}

function checkboxInput(value, apply) {
  const input = el('input', { type: 'checkbox', checked: Boolean(value) });
  input.addEventListener('change', () => change(() => apply(input.checked)));
  return input;
}

function selectInput(options, value, apply) {
  const select = el('select', {}, ...options.map(([optionValue, label]) => el('option', { value: optionValue, textContent: label })));
  select.value = value ?? '';
  select.addEventListener('change', () => change(() => apply(select.value)));
  return select;
}

function getPath(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function setPath(object, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let target = object;
  for (const key of keys) target = target[key] ??= {};
  target[last] = value;
}

function showConnection(connected) {
  const pill = $('#connection');
  pill.textContent = connected ? 'Eye connected' : 'Eye offline, reconnecting…';
  pill.className = `pill ${connected ? 'ok' : 'bad'}`;
}

// This browser's own small choices (the open tab): never the setup, which lives in the eye.
function loadLocally(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveLocally(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // a private window: it just isn't remembered
  }
}

let toastTimer = null;
function toast(text) {
  const box = $('#toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 4000);
}
