// The cameras Chrome can see, by name. Chrome adds the USB ids to a camera's
// name ("Logi C270 HD WebCam (046d:0825)"); without them the names are the
// ones the Python eye uses, so a setup saved by either works in the other.
// Names only show once the page may use cameras.

const USB_IDS = / \([0-9a-f]{4}:[0-9a-f]{4}\)$/i;

// [{ name, deviceId }] for every camera, in Chrome's order; two the same get (2), (3)...
export async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput' && device.label);
  const seen = new Map();
  return devices.map((device) => {
    const base = device.label.replace(USB_IDS, '');
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { name: count > 1 ? `${base} (${count})` : base, deviceId: device.deviceId };
  });
}

// Whether the page may use cameras yet (names are hidden until it may).
export async function camerasAllowed() {
  try {
    const status = await navigator.permissions.query({ name: 'camera' });
    return status.state === 'granted';
  } catch {
    return false;
  }
}

// Asks for the cameras once, so their names show. Returns whether it may use them.
export async function askForCameras() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    for (const track of stream.getTracks()) track.stop();
    return true;
  } catch {
    return false;
  }
}

// getUserMedia constraints for a camera at a mode ({ width, height, fps, exposure }).
export function constraintsFor(deviceId, mode) {
  return {
    audio: false,
    video: {
      deviceId: { exact: deviceId },
      width: { ideal: mode.width },
      height: { ideal: mode.height },
      frameRate: { ideal: mode.fps },
    },
  };
}

// Exposure, in the Python eye's DirectShow steps (-5 is 1/32 s), where the camera lets Chrome set it.
export async function applyExposure(track, exposure) {
  const capabilities = track.getCapabilities?.() ?? {};
  if (!capabilities.exposureMode) return;
  try {
    if (exposure === null || exposure === undefined) {
      if (capabilities.exposureMode.includes('continuous')) await track.applyConstraints({ advanced: [{ exposureMode: 'continuous' }] });
    } else if (capabilities.exposureMode.includes('manual') && capabilities.exposureTime) {
      const time = Math.min(capabilities.exposureTime.max, Math.max(capabilities.exposureTime.min, 10000 / 2 ** -exposure)); // in 100 µs
      await track.applyConstraints({ advanced: [{ exposureMode: 'manual', exposureTime: time }] });
    }
  } catch {
    // Not every camera honours it.
  }
}

// What went wrong opening a camera, as a camera status.
export function statusForError(error) {
  switch (error?.name) {
    case 'NotFoundError': case 'OverconstrainedError': return 'missing';
    case 'NotAllowedError': case 'SecurityError': return 'not allowed';
    case 'NotReadableError': case 'AbortError': return 'busy';
    default: return 'lost';
  }
}
