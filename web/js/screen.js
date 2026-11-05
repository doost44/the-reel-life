// One screen, at screen.html?id=<id> (or /screen/<id> from the Python eye):
// shows that screen's layout from the setup and the live journey, and follows
// every change made in the editor.
//
// Operator keys: D debug readout · P phone placed (or back to the tracker)
// · R reset (everything wiped, back to stage 0) · T a test reel · F fullscreen

import { connect } from './link.js';
import { Stage, STAGES, camerasIn } from './stage.js';

const asked = new URLSearchParams(location.search);
const screenId = asked.get('id') ?? decodeURIComponent(location.pathname.split('/').pop());
const stage = new Stage(document.getElementById('root'));

// A still of any stage, for documentation or tweaking the look: screen.html?id=reelface&stage=awake
if (STAGES.includes(asked.get('stage'))) stage.setPreviewStage(asked.get('stage'));
const debug = document.getElementById('debug');
const notice = document.getElementById('notice');

let screen = null;
let cameras = {};
let phoneOverride = null;
let framesThisSecond = {};
let framesPerSecond = {};

const link = connect({
  onMessage,
  onFrame(name, bitmap) {
    stage.frame(name, bitmap);
    framesThisSecond[name] = (framesThisSecond[name] ?? 0) + 1;
  },
  onConnection(connected) {
    showNotice(connected ? '' : 'EYE OFFLINE, RECONNECTING');
  },
});
stage.send = link.send;

function onMessage(message) {
  switch (message.type) {
    case 'hello':
      show(message.setup);
      applyStatus(message.status);
      stage.journey(message.journey);
      stage.reelFace(message.reel_face);
      stage.still(message.still);
      break;
    case 'setup':
      show(message.setup);
      break;
    case 'status':
      applyStatus(message);
      break;
    case 'journey':
      stage.journey(message);
      break;
    case 'oracle':
      stage.oracle(message);
      break;
    case 'reel_face':
      stage.reelFace(message);
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
    case 'scream':
      stage.scream(message);
      break;
  }
}

function applyStatus(status) {
  cameras = status.cameras;
  phoneOverride = status.phone_override;
  stage.setStatus(cameras);
}

function show(setup) {
  screen = setup.screens.find((candidate) => candidate.id === screenId) ?? null;
  showNotice(screen ? '' : `NO SCREEN "${screenId}" IN THE SETUP`);
  stage.look = setup.look;
  stage.show(screen);
  stage.speechAllowed = Boolean(screen?.sound); // the oracle (and later the face) only speak on a screen with sound on
  link.watch(camerasIn(screen));
  document.title = screen ? `${screen.name} · The Reel Life` : 'The Reel Life';
}

function showNotice(text) {
  notice.textContent = text;
  notice.hidden = !text;
}

// A window the editor opened on a monitor goes fullscreen with a click (no
// page can make another fullscreen); the click also lets it speak.
addEventListener('pointerdown', () => {
  if (link.local && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
});

addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (key === 'd') debug.hidden = !debug.hidden;
  else if (key === 'p') link.send({ type: 'place_phone', present: phoneOverride === null });
  else if (key === 'r') link.send({ type: 'reset' });
  else if (key === 't') link.send({ type: 'reelface_test_reels', count: 1 });
  else if (key === 'f') document.documentElement.requestFullscreen?.().catch(() => {});
  else return;
  event.preventDefault();
});

setInterval(() => {
  framesPerSecond = framesThisSecond;
  framesThisSecond = {};
}, 1000);
setInterval(() => {
  if (!debug.hidden && screen) showDebug();
}, 250);

function showDebug() {
  const journey = stage.journeySnapshot ?? {};
  const face = stage.reelFaceInfo ?? {};
  const lines = [
    `${screen.name} (${screenId}) ${screen.width}×${screen.height}, window ${innerWidth}×${innerHeight}`,
    `stage: ${journey.stage}, face ${journey.face ? 'seen' : 'none'}, phone ${journey.phone ? 'placed' : 'not placed'}${phoneOverride === null ? '' : ' (by hand)'}`,
    `reels: ${face.reels ?? 0} (${face.waiting_reels ?? 0} waiting), tiles ${face.fragments ?? 0}, progress ${Math.round(100 * (face.progress ?? 0))}%, desire ${Math.round(100 * (face.desire ?? 0))}%`,
    'keys: P phone placed · R reset · T test reel · F fullscreen · D hide',
  ];
  for (const view of stage.views.values()) {
    if (view.type !== 'reelface') continue;
    const said = view.voice.shown(performance.now());
    lines.push(`face: tracking ${view.tracker.ready ? 'on' : 'starting'}, lost for ${Math.round(view.tracker.lostFor(performance.now()))} ms, `
      + `mouth ${(view.mouthOpen ?? 0).toFixed(2)}, desire ${view.desire.toFixed(2)}, word ${said ? `"${said.text}"` : '-'}`);
    lines.push(`hair: ${view.segmenter.worker ? (view.segmenter.ready ? `found ${view.segmenter.found} shapes, last took ${Math.round(view.segmenter.ms)} ms` : 'starting') : 'not started'}`);
  }
  for (const name of new Set(camerasIn(screen).filter(Boolean))) {
    const camera = cameras[name] ?? {};
    lines.push(`${name}: ${camera.status ?? '-'}, capture ${camera.fps ?? 0} fps, here ${framesPerSecond[name] ?? 0} fps`);
  }
  debug.textContent = lines.join('\n');
}
