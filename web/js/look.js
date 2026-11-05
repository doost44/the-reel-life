// The look editor, at /look: the reel face, live and big, with every setting
// of its look (look.py) on glass around it.
//
// The face is the control surface. Drag across it (or the Formation chart
// below it) to move through its formation, from the first reels to the full
// face; scroll to nudge; double-click to go back to the visit's own progress.
// Every screen follows. Each setting is a ramp from its first-reels value
// (left dot) to its full-face value (right dot): drag a dot up or down. Hold a
// setting's name to see that effect alone (this page only). Changes save to
// setup.json and reach every screen at once; Looks keeps them by name.
//
// The preview is a screen like any other: it tracks the face camera and tells
// the eye when it sees someone, so the journey runs with no other screen open.
// The face only appears once the phone is placed, so the Visit card also shows
// the face camera's picture, live, and lights the next button to press.

import { connect } from './link.js';
import { Stage, camerasIn } from './stage.js';
import { FACE_VIEW } from './reelface.js';
import { startBackdrop } from './backdrop.js';

const $ = (selector) => document.querySelector(selector);
const SAVE_AFTER = 200;    // ms after the last change
const KEEP_EDITS = 1000;   // ms after a change here, a setup from elsewhere doesn't undo it
const SEND_EVERY = 40;     // ms between messages while scrubbing
const HOLD_FOR_SOLO = 220; // ms holding a setting's name before it's shown alone
const CAMERA_EVERY = 100;  // ms between redraws of the face camera's small picture
const GAP = 12;            // px between the face and the cards
const STAGE_LABELS = { empty: 'Nobody there', awake: 'Awake', asking: 'Asking for reels', forming: 'Forming', climax: 'Climax', dark: 'Dark', still: 'Their still', ended: 'Ended' };
const NARROW = matchMedia('(max-width: 900px)');

const stage = new Stage($('#preview'));
stage.tool = true;
startBackdrop(stage, FACE_VIEW);

let setup = null;
let screen = null;
let described = [];          // the settings, group by group, from the eye
let group = remembered('look-group') ?? 'Energy';
let lastEdit = -Infinity;
let saveTimer = 0;
let toastTimer = 0;
let phoneOverride = null;
let devices = [];            // the cameras and clips the eye can see
let cameras = {};            // how each open camera is doing, from the eye
let hovered = null;          // the setting under the pointer
let selected = null;         // the setting clicked: its dots are on the chart too
let soloed = null;           // the setting shown alone, while its name is held
let scrub = null;            // while dragging the face or the chart: { value, ... }
let lastSent = 0;
let saidTimer = 0;

const link = connect({
  onMessage,
  onFrame: (name, bitmap) => stage.frame(name, bitmap),
  onConnection(connected) {
    $('#connection').textContent = `${link.local ? 'Eye (in Chrome)' : 'Eye'} ${connected ? 'connected' : 'offline'}`;
    $('#connection').className = `pill ${connected ? 'ok' : 'bad'}`;
  },
});
stage.send = link.send;

// Messages from the eye

function onMessage(message) {
  switch (message.type) {
    case 'hello':
      described = message.look_settings ?? [];
      phoneOverride = message.status?.phone_override ?? null;
      cameras = message.status?.cameras ?? {};
      devices = message.devices ?? [];
      receiveSetup(message.setup);
      buildTabs();
      buildSettings();
      stage.journey(message.journey);
      showVisit();
      showReelFace(message.reel_face);
      stage.still(message.still);
      break;
    case 'setup':
      if (performance.now() - lastEdit > KEEP_EDITS) receiveSetup(message.setup);
      break;
    case 'status':
      phoneOverride = message.phone_override ?? null;
      cameras = message.cameras ?? {};
      showVisit();
      showCamera();
      break;
    case 'devices':
      devices = message.devices ?? [];
      showCamera();
      break;
    case 'journey':
      stage.journey(message);
      showVisit();
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
      showWord(message.text);
      break;
    case 'still':
      stage.still(message);
      break;
    case 'notice':
      toast(message.text);
      break;
  }
}

// The reel face screen from the setup: the face as the participant sees it.
function receiveSetup(next) {
  setup = next;
  setup.look.presets ??= {};
  stage.look = soloed ? soloLook(soloed) : setup.look;
  screen = setup.screens.find((candidate) => candidate.items.some((item) => item.type === 'reelface')) ?? null;
  stage.show(screen);
  placeStage();
  link.watch(camerasIn(screen));
  if (!screen) toast('No screen in the setup has a Reel face source: add one in Setup.');
  renderLooks();
  drawRamps();
  showCamera();
}

// The face, fitted into the space the cards leave.
function placeStage() {
  if (NARROW.matches) {
    stage.inset = null;
  } else {
    const box = (selector) => $(selector).getBoundingClientRect();
    stage.inset = {
      top: box('.topbar').bottom + GAP,
      left: box('#left').right + GAP,
      right: innerWidth - box('#right').left + GAP,
      bottom: innerHeight - box('#timeline').top + GAP,
    };
  }
  stage.fit();
}
addEventListener('resize', placeStage);
NARROW.addEventListener('change', placeStage);

// The visit

$('#place-phone').onclick = () => link.send({ type: 'place_phone', present: phoneOverride === null });
$('#test-reels').onclick = () => link.send({ type: 'reelface_test_reels', count: 5 });
$('#clear-face').onclick = () => link.send({ type: 'reelface_reset' });
$('#climax-now').onclick = () => link.send({ type: 'climax_now' });
$('#reset').onclick = () => link.send({ type: 'reset' });

function showVisit() {
  const journey = stage.journeySnapshot ?? {};
  const where = journey.stage ?? 'empty';
  $('#stage-pill').replaceChildren(
    el('span', { className: `dot ${where === 'forming' ? 'hot' : where === 'empty' ? '' : 'ok'}` }),
    el('span', { textContent: STAGE_LABELS[where] ?? where }));
  $('#face-dot').className = `dot ${journey.face ? 'ok' : ''}`;
  $('#face-state').textContent = journey.face ? 'seen' : journey.present ? 'movement' : 'none';
  $('#phone-dot').className = `dot ${journey.phone ? 'ok' : ''}`;
  $('#phone-state').textContent = journey.phone ? (phoneOverride === null ? 'placed' : 'placed by hand') : 'not placed';
  $('#place-phone').textContent = phoneOverride === null ? 'Phone placed' : 'Back to tracker';
  $('#place-phone').classList.toggle('on', phoneOverride !== null);
  showNextStep();
}

// Lights the button that moves the visit on: the face only appears once the phone is placed and reels arrive.
function showNextStep() {
  const journey = stage.journeySnapshot ?? {};
  $('#place-phone').classList.toggle('primary', journey.stage === 'awake' && !journey.phone);
  $('#test-reels').classList.toggle('primary', journey.stage === 'asking' || (journey.stage === 'forming' && !info().reels));
}

// The face camera: which it is, how it's doing, and its picture, live.
$('#face-camera').onchange = (event) => {
  setup.face_camera = event.target.value;
  edited({ redraw: false });
  showCamera();
};

function showCamera() {
  if (!setup) return;
  const chosen = setup.face_camera ?? '';
  const select = $('#face-camera');
  const names = [...new Set([...devices, ...(chosen ? [chosen] : [])])];
  const wanted = JSON.stringify(names);
  if (select.dataset.names !== wanted) {
    select.replaceChildren(new Option('None: test clip', ''), ...names.map((name) => new Option(name.replace(/^clip: /, 'Clip: '), name)));
    select.dataset.names = wanted;
  }
  select.value = chosen;
  const [text, tone] = cameraState(chosen);
  $('#camera-status').textContent = text;
  $('#camera-status').className = `camera-status ${tone}`;
}

function cameraState(name) {
  if (!name) return ['Recorded test clip, not a live camera', 'warn'];
  if (name === setup.detection_camera) return ['Also the phone tracker: they need separate cameras', 'warn'];
  const camera = cameras[name];
  switch (camera?.status) {
    case 'ok': return [`Live, ${Math.round(camera.fps)} fps`, 'ok'];
    case 'starting': case undefined: return ['Starting…', 'warn'];
    case 'no_signal': return ['No signal', 'warn'];
    case 'missing': return ['Not connected', 'bad'];
    case 'busy': return ['Busy: another app may have it', 'bad'];
    default: return [camera.status, 'bad'];
  }
}

setInterval(() => {
  const picture = stage.feeds.get(FACE_VIEW);
  const canvas = $('#camera-view');
  const ctx = canvas.getContext('2d');
  if (!picture) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  // Filling the frame, mirrored like the face.
  const scale = Math.max(canvas.width / picture.width, canvas.height / picture.height);
  const width = picture.width * scale, height = picture.height * scale;
  ctx.setTransform(-1, 0, 0, 1, canvas.width, 0);
  try {
    ctx.drawImage(picture, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  } catch {
    // a picture closed as it arrived: the next one will do
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}, CAMERA_EVERY);

function showReelFace(info) {
  if (!info) return;
  stage.reelFace(info);
  $('#desire').replaceChildren(...bigNumber(100 * info.desire, 1));
  const waiting = info.waiting_reels ?? 0;
  $('#reels').replaceChildren(String(info.formed_reels ?? 0), ...(waiting ? [el('small', { textContent: ` +${waiting}` })] : []));
  $('#fragments').textContent = String(info.fragments ?? 0);
  $('#covered').textContent = `${Math.round(100 * (info.covered ?? 0))}%`;
  const formed = Math.min(info.formed_reels ?? 0, 60);
  const queued = Math.min(waiting, 60 - formed);
  $('#punchcard').replaceChildren(
    ...Array.from({ length: formed }, () => el('i')),
    ...Array.from({ length: queued }, () => el('i', { className: 'waiting' })));
  const held = info.override !== null && info.override !== undefined;
  $('#held').hidden = !held;
  $('#held').textContent = held ? `Held at ${Math.round(100 * info.override)}% · back to auto` : '';
  $('#auto').hidden = !held;
  $('#formed-mode').textContent = held ? 'held by hand' : 'following the visit';
  showNextStep();
}

// What the face just said, for a moment.
function showWord(text) {
  $('#said').textContent = `“${text}”`;
  $('#said').classList.remove('gone');
  clearTimeout(saidTimer);
  saidTimer = setTimeout(() => $('#said').classList.add('gone'), 3500);
}

// Moving through the formation: drag across the face or the chart

const info = () => stage.reelFaceInfo ?? {};
const faceView = () => [...stage.views.values()].find((view) => view.type === 'reelface');
// How far formed the face looks now (it eases towards the eye's value).
const shown = () => scrub?.value ?? faceView()?.formation ?? info().progress ?? 0;

function moveTo(value, event) {
  const at = Math.min(1, Math.max(0, value));
  if (scrub) Object.assign(scrub, { value: at, moved: true });
  const now = performance.now();
  if (now - lastSent > SEND_EVERY || !scrub) {
    link.send({ type: 'reelface_intensity', value: at });
    lastSent = now;
  }
  if (event) {
    const hint = $('#scrub-hint');
    hint.hidden = false;
    hint.textContent = `${Math.round(100 * at)}% formed`;
    Object.assign(hint.style, { left: `${event.clientX}px`, top: `${event.clientY}px` });
  }
}

function toAuto() {
  link.send({ type: 'reelface_intensity', value: null });
  toast('Back to the visit\'s own progress.');
}

function endScrub() {
  if (!scrub) return;
  if (scrub.moved) link.send({ type: 'reelface_intensity', value: scrub.value }); // a plain click holds nothing
  scrub = null;
  $('#preview').classList.remove('scrubbing');
  setTimeout(() => { if (!scrub) $('#scrub-hint').hidden = true; }, 500);
}

const preview = $('#preview');
preview.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !stage.screen) return;
  preview.setPointerCapture(event.pointerId);
  preview.classList.add('scrubbing');
  // Across the whole face's frame (less a margin) is the whole formation.
  scrub = { from: event.clientX, start: shown(), value: shown(), across: stage.screen.width * stage.scale * 0.8 };
});
preview.addEventListener('pointermove', (event) => {
  if (!scrub?.across) return;
  const moved = event.clientX - scrub.from;
  if (scrub.moved || Math.abs(moved) > 6) moveTo(scrub.start + moved / scrub.across, event); // a click's jitter isn't a drag
});
preview.addEventListener('pointerup', endScrub);
preview.addEventListener('pointercancel', endScrub);
preview.addEventListener('dblclick', toAuto);
preview.addEventListener('wheel', (event) => {
  event.preventDefault();
  moveTo(shown() - Math.sign(event.deltaY) * 0.03, event);
  setTimeout(() => { if (!scrub) $('#scrub-hint').hidden = true; }, 700);
}, { passive: false });

$('#held').onclick = toAuto;
$('#auto').onclick = toAuto;

// The chart: the open group's settings across the formation, where each reel
// took the face, and where it is now. Drag it to move through the formation;
// drag the selected setting's dots to change it.

const chart = $('#chart');
const plot = () => {
  const { width, height } = chart.getBoundingClientRect();
  return { width, height, left: 8, right: width - 42, top: 10, bottom: height - 24 };
};
const chartX = (box, at) => box.left + at * (box.right - box.left);
const chartY = (box, share) => box.bottom - share * (box.bottom - box.top);

chart.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  chart.setPointerCapture(event.pointerId);
  const box = plot();
  const rect = chart.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const setting = settingNamed(selected);
  if (setting && groupOf(setting) === group) {
    const pair = setup.look.values[setting.name];
    for (const end of [0, 1]) {
      if (Math.hypot(x - chartX(box, end), y - chartY(box, share(setting, pair[end]))) < 14) {
        scrub = null;
        chart.dragging = { setting, end, box };
        return;
      }
    }
  }
  scrub = { chart: true, value: shown() };
  moveTo((x - box.left) / (box.right - box.left), event);
});
chart.addEventListener('pointermove', (event) => {
  const rect = chart.getBoundingClientRect();
  if (chart.dragging) {
    const { setting, end, box } = chart.dragging;
    setValue(setting, end, fromShare(setting, (box.bottom - (event.clientY - rect.top)) / (box.bottom - box.top)));
  } else if (scrub?.chart) {
    const box = plot();
    moveTo((event.clientX - rect.left - box.left) / (box.right - box.left), event);
  }
});
for (const type of ['pointerup', 'pointercancel']) {
  chart.addEventListener(type, () => {
    chart.dragging = null;
    endScrub();
  });
}
chart.addEventListener('dblclick', toAuto);

function drawChart() {
  const box = plot();
  const ctx = sized(chart, box.width, box.height);
  ctx.font = '11px "Segoe UI", sans-serif';
  // The grid: a quarter of each setting's range at a time.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.fillStyle = 'rgba(238, 240, 243, 0.4)';
  ctx.setLineDash([3, 4]);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (const level of [0.25, 0.5, 0.75, 1]) {
    line(ctx, box.left, chartY(box, level), box.right, chartY(box, level));
    ctx.fillText(`${level * 100}%`, box.right + 8, chartY(box, level));
  }
  ctx.setLineDash([]);
  ctx.textBaseline = 'alphabetic';
  const labels = [['first reel', 0, 'left'], ['50%', 0.5, 'center'], ['full face', 1, 'right']];
  if (box.right - box.left > 420) labels.push(['25%', 0.25, 'center'], ['75%', 0.75, 'center']);
  for (const [label, at, align] of labels) {
    ctx.textAlign = align;
    ctx.fillText(label, chartX(box, at), box.height - 4);
  }
  // Where each reel took the face: a tick each, like a punchcard.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  for (const mark of info().reel_marks ?? []) ctx.fillRect(chartX(box, Math.min(1, mark)) - 1, box.bottom - 6, 2, 6);
  // Where the face is now: a lit band.
  const at = shown();
  const x = chartX(box, at);
  const band = ctx.createLinearGradient(0, box.top, 0, box.bottom);
  band.addColorStop(0, 'rgba(255, 255, 255, 0.08)');
  band.addColorStop(1, 'rgba(255, 255, 255, 0.02)');
  ctx.fillStyle = band;
  ctx.fillRect(x - 14, box.top, 28, box.bottom - box.top);
  if (!setup) return;
  // The open group's settings: faint, the hovered or selected one bright.
  const settings = groupSettings();
  const focus = settings.find((setting) => setting.name === (hovered ?? selected));
  for (const setting of settings) {
    if (setting === focus) continue;
    const [first, full] = setup.look.values[setting.name];
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
    ctx.lineWidth = 1.25;
    line(ctx, chartX(box, 0), chartY(box, share(setting, first)), chartX(box, 1), chartY(box, share(setting, full)));
  }
  if (focus) {
    const [first, full] = setup.look.values[focus.name];
    const y0 = chartY(box, share(focus, first));
    const y1 = chartY(box, share(focus, full));
    const area = ctx.createLinearGradient(0, box.top, 0, box.bottom);
    area.addColorStop(0, 'rgba(255, 255, 255, 0.16)');
    area.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = area;
    ctx.beginPath();
    ctx.moveTo(chartX(box, 0), y0);
    ctx.lineTo(chartX(box, 1), y1);
    ctx.lineTo(chartX(box, 1), box.bottom);
    ctx.lineTo(chartX(box, 0), box.bottom);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    line(ctx, chartX(box, 0), y0, chartX(box, 1), y1);
    if (focus.name === selected) {
      dotAt(ctx, chartX(box, 0), y0, 5, '#ffffff');
      dotAt(ctx, chartX(box, 1), y1, 5, '#ffffff');
    }
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = x > box.right - 120 ? 'right' : 'left';
    ctx.fillText(focus.label, x + (ctx.textAlign === 'left' ? 18 : -18), box.top + 10);
  }
  // Now: a line down the band, and a dot where it meets each setting.
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  line(ctx, x, box.top, x, box.bottom);
  ctx.setLineDash([]);
  for (const setting of settings) {
    const [first, full] = setup.look.values[setting.name];
    const y = chartY(box, share(setting, first + (full - first) * at));
    dotAt(ctx, x, y, setting === focus ? 4.5 : 3, setting === focus ? '#ff9f43' : '#ffffff');
  }
}

// The settings

function buildTabs() {
  $('#group-tabs').replaceChildren(...described.map(({ group: name }) => el('button', {
    className: name === group ? 'active' : '',
    textContent: name.split(' ')[0],
    title: name,
    onclick: () => {
      group = name;
      remember('look-group', name);
      buildTabs();
      buildSettings();
    },
  })));
}

function buildSettings() {
  const open = described.find((candidate) => candidate.group === group) ?? described[0];
  if (!open) return;
  group = open.group;
  $('#group-note').textContent = group === 'Formation' || group === 'Hair and ears'
    ? 'Pieces are cut as each reel arrives: Clear face, then add reels, to see a change in them.' : '';
  $('#settings').replaceChildren(...open.settings.map(settingRow));
  showHelp();
  drawRamps();
}

function settingRow(setting) {
  const name = el('span', { className: 'setting-name', textContent: setting.label, title: 'Click to put its dots on the chart · hold to see it alone' });
  const ramp = el('canvas', { className: 'ramp', title: 'Drag the left dot (first reels) or the right dot (full face) up or down' });
  const ends = [0, 1].map((end) => el('b', { title: 'Double-click to type', dataset: { end } }));
  const row = el('div', { className: 'setting', dataset: { name: setting.name } }, [
    el('div', { className: 'setting-head' }, [name, el('span', { className: 'setting-now' })]),
    ramp,
    el('div', { className: 'setting-ends' }, [
      el('span', {}, [ends[0], ' first reels']),
      el('span', {}, ['full face ', ends[1]]),
    ]),
  ]);
  row.addEventListener('pointerenter', () => { hovered = setting.name; showHelp(setting); });
  row.addEventListener('pointerleave', () => { hovered = null; showHelp(); });

  // The name: click to select, hold to see this effect alone.
  let holding = 0;
  name.addEventListener('pointerdown', () => {
    holding = setTimeout(() => { holding = 0; solo(setting); }, HOLD_FOR_SOLO);
  });
  const release = () => {
    if (holding) {
      clearTimeout(holding);
      holding = 0;
      selected = selected === setting.name ? null : setting.name;
      for (const other of document.querySelectorAll('.setting')) other.classList.toggle('selected', other.dataset.name === selected);
    } else if (soloed) {
      solo(null);
    }
  };
  name.addEventListener('pointerup', release);
  name.addEventListener('pointerleave', () => {
    if (holding) clearTimeout(holding);
    holding = 0;
    if (soloed) solo(null);
  });

  // The ramp: drag either end.
  let end = null;
  const valueAt = (event) => {
    const rect = ramp.getBoundingClientRect();
    return fromShare(setting, 1 - (event.clientY - rect.top - RAMP.top) / (rect.height - RAMP.top - RAMP.bottom));
  };
  ramp.addEventListener('pointerdown', (event) => {
    const rect = ramp.getBoundingClientRect();
    end = event.clientX - rect.left < rect.width / 2 ? 0 : 1;
    ramp.setPointerCapture(event.pointerId);
    setValue(setting, end, valueAt(event));
  });
  ramp.addEventListener('pointermove', (event) => {
    if (end !== null) setValue(setting, end, valueAt(event));
  });
  for (const type of ['pointerup', 'pointercancel']) ramp.addEventListener(type, () => { end = null; });

  // The numbers: double-click to type one.
  for (const label of ends) {
    label.addEventListener('dblclick', () => {
      const which = Number(label.dataset.end);
      const input = el('input', { type: 'number', min: setting.min, max: setting.max, step: setting.step, value: setup.look.values[setting.name][which] });
      const done = (keep) => {
        if (keep && input.value !== '') setValue(setting, which, Number(input.value));
        input.replaceWith(label);
        drawRamps();
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') done(true);
        else if (event.key === 'Escape') done(false);
      });
      input.addEventListener('blur', () => done(true));
      label.replaceWith(input);
      input.focus();
      input.select();
    });
  }
  return row;
}

const RAMP = { left: 7, right: 7, top: 6, bottom: 6 };

// Every open setting's ramp, its numbers, and its value now.
function drawRamps() {
  if (!setup) return;
  const at = shown();
  for (const row of document.querySelectorAll('.setting')) {
    const setting = settingNamed(row.dataset.name);
    const [first, full] = setup.look.values[setting.name];
    row.querySelector('.setting-now').textContent = format(first + (full - first) * at, setting);
    for (const label of row.querySelectorAll('b[data-end]')) label.textContent = format(setup.look.values[setting.name][label.dataset.end], setting);
    row.classList.toggle('solo', soloed === setting.name);
    const canvas = row.querySelector('.ramp');
    const { width, height } = canvas.getBoundingClientRect();
    if (!width) continue;
    const ctx = sized(canvas, width, height);
    const x = (share) => RAMP.left + share * (width - RAMP.left - RAMP.right);
    const y = (value) => height - RAMP.bottom - share(setting, value) * (height - RAMP.top - RAMP.bottom);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.setLineDash([2, 3]);
    line(ctx, x(0), RAMP.top, x(1), RAMP.top);
    ctx.setLineDash([]);
    line(ctx, x(0), height - RAMP.bottom, x(1), height - RAMP.bottom);
    const area = ctx.createLinearGradient(0, RAMP.top, 0, height);
    area.addColorStop(0, 'rgba(255, 255, 255, 0.18)');
    area.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = area;
    ctx.beginPath();
    ctx.moveTo(x(0), y(first));
    ctx.lineTo(x(1), y(full));
    ctx.lineTo(x(1), height - RAMP.bottom);
    ctx.lineTo(x(0), height - RAMP.bottom);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 1.5;
    line(ctx, x(0), y(first), x(1), y(full));
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 1;
    line(ctx, x(at), RAMP.top, x(at), height - RAMP.bottom);
    dotAt(ctx, x(0), y(first), 5, '#ffffff');
    dotAt(ctx, x(1), y(full), 5, '#ffffff');
    dotAt(ctx, x(at), y(first + (full - first) * at), 3.5, '#ff9f43');
  }
}

function setValue(setting, end, value) {
  const steps = Math.round((Math.min(setting.max, Math.max(setting.min, value)) - setting.min) / setting.step);
  const decimals = String(setting.step).split('.')[1]?.length ?? 0;
  const snapped = Number((setting.min + steps * setting.step).toFixed(decimals));
  const pair = setup.look.values[setting.name];
  if (pair[end] === snapped) return;
  pair[end] = snapped;
  if (soloed) stage.look = soloLook(soloed);
  edited();
  drawRamps();
}

function showHelp(setting = null) {
  $('#help').textContent = setting?.help
    ?? 'Each setting runs from the first reels (left dot) to the full face (right dot): drag the dots. Hold a name to see that effect alone.';
}

// One effect alone: every other effect switched off on this page's preview
// (nothing is saved). A setting that isn't an effect itself (block size,
// fragments) keeps its own group's effects on, so there's something to see.
function solo(setting) {
  soloed = setting?.name ?? null;
  stage.look = soloed ? soloLook(soloed) : setup.look;
  $('#solo-tag').hidden = !soloed;
  $('#solo-tag').textContent = soloed ? `${setting.label} alone` : '';
  drawRamps();
}

function soloLook(name) {
  const target = settingNamed(name);
  const values = structuredClone(setup.look.values);
  for (const { group: other, settings } of described) {
    for (const setting of settings) {
      const keep = setting === target || (target.off === null && other === groupOf(target));
      if (setting.off !== null && !keep) values[setting.name] = [setting.off, setting.off];
    }
  }
  return { ...setup.look, values };
}

// Looks: saved by name

$('#preset-save').onclick = () => {
  const name = prompt('Save this look as:', 'My look')?.trim();
  if (!name) return;
  setup.look.presets[name] = { values: structuredClone(setup.look.values), background: setup.look.background };
  edited();
  toast(`Saved "${name}".`);
};
$('#defaults').onclick = () => {
  if (!confirm('Every setting back to how it started? (Saved looks are kept.)')) return;
  for (const { settings } of described) for (const setting of settings) setup.look.values[setting.name] = [...setting.default];
  setBackground('');
};

function renderLooks() {
  if (!setup) return;
  const names = Object.keys(setup.look.presets).sort();
  $('#presets').replaceChildren(...(names.length ? names.map((name) => {
    const preset = setup.look.presets[name];
    const active = sameValues(preset.values, setup.look.values) && (preset.background ?? '') === (setup.look.background ?? '');
    return el('span', { className: `chip${active ? ' active' : ''}` }, [
      el('button', { textContent: name, title: 'Load this look', onclick: () => loadPreset(name) }),
      el('button', { className: 'chip-x', textContent: '×', title: `Delete "${name}"`, onclick: () => deletePreset(name) }),
    ]);
  }) : [el('span', { className: 'note', textContent: 'No saved looks yet.' })]));
  renderSwatches();
}

function loadPreset(name) {
  const preset = setup.look.presets[name];
  Object.assign(setup.look.values, structuredClone(preset.values));
  setBackground(preset.background ?? '');
  toast(`Loaded "${name}".`);
}

function deletePreset(name) {
  if (!confirm(`Delete the look "${name}"?`)) return;
  delete setup.look.presets[name];
  edited();
}

function renderSwatches() {
  const background = setup.look.background ?? '';
  const layout = screen?.items.find((item) => item.type === 'reelface')?.background || '#000000';
  const options = [['', layout, "Layout's"], ['#000000', '#000000', 'Black'], ['#ffffff', '#ffffff', 'White']];
  const custom = !options.some(([value]) => value === background);
  const picker = el('input', { type: 'color', value: background || layout, title: 'Any colour' });
  picker.addEventListener('input', () => setBackground(picker.value, false));
  $('#swatches').replaceChildren(
    ...options.map(([value, colour, label]) => el('button', {
      className: `swatch${background === value ? ' active' : ''}`,
      title: value ? label : 'The reel face source\'s own background, set in Setup',
      onclick: () => setBackground(value),
    }, [el('i', { style: `background: ${colour}` }), label])),
    el('label', { className: `swatch${custom ? ' active' : ''}` }, [picker, 'Custom']));
}

function setBackground(value, redraw = true) {
  setup.look.background = value;
  edited({ redraw });
  stage.show(screen); // the words switch colour if the background would swallow them
}

// Saving

// A change here: the preview has it at once (it shares the look); the eye a moment later.
function edited({ redraw = true } = {}) {
  lastEdit = performance.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => link.send({ type: 'setup', setup }), SAVE_AFTER);
  if (redraw) renderLooks();
  drawRamps();
}

// Drawing, about 20 times a second: the chart and ramps follow the face.

let lastDrawn = -1;
setInterval(() => {
  drawChart();
  const at = shown();
  if (Math.abs(at - lastDrawn) > 0.001) {
    lastDrawn = at;
    drawRamps();
  }
  $('#formed').replaceChildren(...bigNumber(100 * at, 0));
}, 50);

// Small helpers

const settingNamed = (name) => described.flatMap((candidate) => candidate.settings).find((setting) => setting.name === name);
const groupOf = (setting) => described.find((candidate) => candidate.settings.includes(setting))?.group;
const groupSettings = () => described.find((candidate) => candidate.group === group)?.settings ?? [];
const share = (setting, value) => (value - setting.min) / (setting.max - setting.min);
const fromShare = (setting, at) => setting.min + Math.min(1, Math.max(0, at)) * (setting.max - setting.min);

function sameValues(a, b) {
  return Object.keys(b).every((name) => a?.[name]?.[0] === b[name][0] && a?.[name]?.[1] === b[name][1]);
}

function format(value, setting) {
  return setting.step >= 1 ? String(Math.round(value)) : value.toFixed(2);
}

// A dashboard number: big, its decimal faint, its unit small.
function bigNumber(value, decimals) {
  const [whole, fraction] = value.toFixed(decimals).split('.');
  return [whole, ...(fraction ? [el('span', { className: 'dim', textContent: `.${fraction}` })] : []), el('small', { textContent: '%' })];
}

// A canvas's 2D context, sized for this screen's pixels, cleared.
function sized(canvas, width, height) {
  const ratio = devicePixelRatio || 1;
  const w = Math.round(width * ratio);
  const h = Math.round(height * ratio);
  if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

function line(ctx, x0, y0, x1, y1) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function dotAt(ctx, x, y, radius, colour) {
  ctx.beginPath();
  ctx.arc(x, y, radius + 2, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(10, 11, 13, 0.85)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = colour;
  ctx.fill();
}

function toast(text) {
  const box = $('#toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 3500);
}

function remembered(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private window: the tab just isn't remembered
  }
}

function el(tag, props = {}, children = []) {
  const { dataset, style, ...rest } = props;
  const made = Object.assign(document.createElement(tag), rest);
  Object.assign(made.dataset, dataset ?? {});
  if (style) made.style.cssText = style;
  made.append(...children);
  return made;
}
