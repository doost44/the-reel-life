// A page's link to the Chrome version of the eye: the same connect() as
// link.js gives for the Python eye's WebSocket, the same messages both ways.
// The eye runs in whichever page got there first (host.js); this page asks it
// to join, shows its own cameras (cameras.js), and opens screens on monitors
// itself (screens.js), so those parts of the eye's messages are filled in here.

import { askForCameras } from './devices.js';
import { LocalCameras } from './cameras.js';
import { CHANNEL, hostWhenFree } from './host.js';
import { LocalScreens } from './screens.js';

const HELLO_WAIT = 4000; // ms without the eye's hello before saying it's offline

export function connectLocal({ onMessage, onFrame, onConnection = () => {} }) {
  const client = crypto.randomUUID();
  const bus = new BroadcastChannel(CHANNEL);
  const cameras = new LocalCameras(onFrame);
  const screens = new LocalScreens();
  let watching = [];
  let setup = null;
  let connected = false;
  let helloTimer = null;

  const post = (data) => bus.postMessage({ ...data, client });
  const forward = (message) => post({ kind: 'message', message });

  function join() {
    post({ kind: 'join' });
    post({ kind: 'message', message: { type: 'watch', cameras: watching } });
    clearTimeout(helloTimer);
    helloTimer = setTimeout(() => {
      if (connected) return;
      onConnection(false);
      join();
    }, HELLO_WAIT);
  }

  // The eye's messages, with what this page knows filled in.
  function withLocal(message) {
    if (message.type === 'hello') {
      setup = message.setup;
      cameras.configure(message.local);
      cameras.useSetup(setup);
      message.monitors = screens.monitors;
      withStatus(message.status);
    } else if (message.type === 'setup') {
      setup = message.setup;
      cameras.useSetup(setup);
    } else if (message.type === 'status') {
      withStatus(message);
    } else if (message.type === 'devices') {
      message.monitors = screens.monitors;
    }
    return message;
  }

  function withStatus(status) {
    status.cameras = { ...status.cameras, ...cameras.info() };
    status.open_screens = screens.openScreens();
    return status;
  }

  bus.onmessage = ({ data }) => {
    if (data.kind === 'host') {
      connected = false;
      join();
    } else if (data.kind === 'message') {
      if ((data.to && data.to !== client) || (data.skip && data.skip === client)) return;
      if (data.message.type === 'hello') {
        connected = true;
        clearTimeout(helloTimer);
        onConnection(true);
      }
      onMessage(withLocal(data.message));
    } else if (data.kind === 'frame') {
      if (watching.includes(data.name)) createImageBitmap(data.blob).then((bitmap) => onFrame(data.name, bitmap), () => {});
    } else if (data.kind === 'failed') {
      onMessage({ type: 'notice', text: `The eye couldn't start: ${data.error.split('\n')[0]}` });
    }
  };

  const notice = (text) => onMessage({ type: 'notice', text });

  function send(message) {
    switch (message.type) {
      case 'watch':
        watching = [...new Set((message.cameras ?? []).filter(Boolean))].sort();
        cameras.watch(watching);
        forward({ type: 'watch', cameras: watching });
        break;
      case 'setup':
        setup = message.setup;
        cameras.useSetup(setup);
        forward(message);
        break;
      case 'open_screen': {
        const problem = screens.open(setup?.screens.find((screen) => screen.id === message.id));
        if (problem) notice(problem);
        break;
      }
      case 'close_screen':
        screens.close(message.id);
        break;
      case 'refresh_devices':
        // A click: Chrome may ask for the cameras and the monitors now.
        Promise.all([askForCameras(), screens.refresh(true)]).then(() => forward(message));
        break;
      default:
        forward(message);
    }
  }

  function watch(names) {
    send({ type: 'watch', cameras: names });
  }

  addEventListener('pagehide', () => post({ kind: 'leave' }));
  hostWhenFree();
  screens.refresh().finally(join); // the monitors first, so the hello has them
  return { send, watch, local: true };
}
