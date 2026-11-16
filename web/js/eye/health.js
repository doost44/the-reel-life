// The health of every part of the exhibit, for the operator panel (the
// editor's Visit tab). The Chrome version's copy of eye/health.py (where it's
// described): change both together.

const CAMERA_STATES = { ok: 'ok', starting: 'warn', no_signal: 'warn' }; // anything else is bad
const CAMERA_WORDS = {
  ok: 'live', starting: 'starting', no_signal: 'no signal', missing: 'not connected',
  busy: 'busy: another app has it?', lost: 'lost: reconnecting', stopped: 'stopped',
};

const part = (id, name, state, detail) => ({ id, name, state, detail });

function camera(info) {
  if (!info) return ['warn', 'starting'];
  const status = info.status ?? '';
  const detail = status === 'ok' ? `live, ${info.fps ?? 0} fps` : CAMERA_WORDS[status] ?? status;
  return [CAMERA_STATES[status] ?? 'bad', detail];
}

export function healthParts({
  eye, detectionCamera, camera: cameraInfo, detection, faceFeed, faceCamera = null, faceReports, likeSources, clips, clipsWanted,
}) {
  const result = [part('eye', 'Eye', 'ok', eye === 'python' ? 'Python eye' : 'in Chrome, hosted by one open page')];

  // The phone camera and the swipe detector on it.
  if (!detectionCamera) {
    result.push(part('phone_camera', 'Phone camera', 'bad', 'none chosen (Cameras tab)'));
    result.push(part('detector', 'Swipe detector', 'off', 'no phone camera'));
  } else {
    const [state, detail] = camera(cameraInfo);
    result.push(part('phone_camera', 'Phone camera', state, detail));
    if (state !== 'ok') {
      result.push(part('detector', 'Swipe detector', 'warn', 'waiting for the phone camera'));
    } else if (detection?.present) {
      result.push(part('detector', 'Swipe detector', 'ok', `phone found (${detection.zone ?? 'auto'}), ${detection.swipes ?? 0} swipes`));
    } else {
      result.push(part('detector', 'Swipe detector', 'warn', `no phone in view (${detection?.zone ?? 'auto'})`));
    }
  }

  // The face camera, and MediaPipe tracking it, as the reel face screens see them.
  if (faceFeed === 'none') {
    result.push(part('face_camera', 'Face camera', 'bad', 'none chosen, and no test clip'));
  } else if (faceFeed === 'test') {
    result.push(part('face_camera', 'Face camera', 'warn', 'test clip, not a live camera'));
  } else if (faceCamera && CAMERA_STATES[faceCamera.status ?? ''] !== 'ok') {
    const [state, detail] = camera(faceCamera);
    result.push(part('face_camera', 'Face camera', state, detail));
  } else if (faceReports.length) {
    const pictures = faceReports.some((report) => report.picture);
    result.push(part('face_camera', 'Face camera', pictures ? 'ok' : 'bad', pictures ? 'live' : 'no pictures reaching the screen'));
  } else {
    result.push(part('face_camera', 'Face camera', 'warn', 'chosen; no Reel face screen open to check it'));
  }
  if (!faceReports.length) {
    result.push(part('tracking', 'Face tracking', 'warn', 'no Reel face screen open'));
  } else {
    const tracking = new Set(faceReports.map((report) => report.tracking));
    if (tracking.has('failed')) result.push(part('tracking', 'Face tracking', 'bad', 'MediaPipe failed to start on a screen'));
    else if (tracking.has('starting')) result.push(part('tracking', 'Face tracking', 'warn', 'MediaPipe starting'));
    else {
      const seen = faceReports.some((report) => report.face);
      result.push(part('tracking', 'Face tracking', 'ok', seen ? 'a face in view' : 'running, no face in view'));
    }
  }

  // Likes: the operator's test likes always work; the others as config.yaml switches them.
  const sources = ['test', ...Object.entries(likeSources).filter(([, on]) => on).map(([name]) => name + (name === 'key' ? ' (L)' : ''))];
  result.push(part('likes', 'Like sources', sources.length > 1 ? 'ok' : 'warn',
    sources.join(', ') + (likeSources.heart ? '' : '; heart on screen: not built yet')));

  result.push(part('classifier', 'Classifier', 'off', 'not built yet: every reel is Unclassified'));
  if (clips >= clipsWanted) result.push(part('voice', 'Voice', 'ok', `all ${clipsWanted} recorded clips`));
  else result.push(part('voice', 'Voice', 'warn', `${clips} of ${clipsWanted} recorded clips; the rest use the browser's voice`));
  result.push(part('recogniser', 'Listening', 'off', "not built yet: it can't hear anyone"));
  return result;
}
