// A page's link to the eye. JSON messages go to onMessage; camera frames go
// to onFrame as ImageBitmaps.
//
// Served by the Python eye (run.ps1, run.sh), it's one WebSocket to it: frames
// arrive as binary (the camera name's length, the name, then a JPEG).
// Reconnects by itself. Served by anything else (GitHub Pages, any plain web
// server), there's no Python eye, so the eye runs in Chrome instead
// (eye/local-link.js), with the same messages. Add ?local to an address to
// use the Chrome version even where the Python eye is running.

export function connect(callbacks) {
  let link = null;
  const queued = [];
  const proxy = {
    local: false,
    send: (message) => (link ? link.send(message) : queued.push(['send', message])),
    watch: (names) => (link ? link.watch(names) : queued.push(['watch', names])),
  };
  servedByEye().then(async (python) => {
    link = python ? connectSocket(callbacks) : (await import('./eye/local-link.js')).connectLocal(callbacks);
    proxy.local = !python;
    for (const [kind, value] of queued.splice(0)) link[kind](value);
  });
  return proxy;
}

// The Python eye answers /eye; nothing else does.
async function servedByEye() {
  if (new URLSearchParams(location.search).has('local')) return false;
  try {
    const response = await fetch('/eye', { cache: 'no-store' });
    return response.ok && response.headers.get('X-Reel-Life-Eye') === 'python';
  } catch {
    return false;
  }
}

function connectSocket({ onMessage, onFrame, onConnection = () => {} }) {
  const decoder = new TextDecoder();
  let socket = null;
  let watching = [];

  function open() {
    socket = new WebSocket(`ws://${location.host}/ws`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      onConnection(true);
      send({ type: 'watch', cameras: watching });
    };
    socket.onclose = () => {
      onConnection(false);
      setTimeout(open, 1000);
    };
    socket.onmessage = ({ data }) => {
      if (typeof data === 'string') {
        onMessage(JSON.parse(data));
        return;
      }
      const bytes = new Uint8Array(data);
      const nameEnd = 1 + bytes[0];
      const name = decoder.decode(bytes.subarray(1, nameEnd));
      createImageBitmap(new Blob([bytes.subarray(nameEnd)], { type: 'image/jpeg' }))
        .then((bitmap) => onFrame(name, bitmap))
        .catch(() => {});
    };
  }

  function send(message) {
    if (message.type === 'still_picture') {
      // The visitor's still goes by itself, not over the socket.
      fetch('/still', { method: 'POST', body: message.jpeg }).catch(() => {});
      return;
    }
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  // Ask for frames from these cameras only.
  function watch(names) {
    const next = [...new Set(names.filter(Boolean))].sort();
    if (next.join('\n') === watching.join('\n')) return;
    watching = next;
    send({ type: 'watch', cameras: watching });
  }

  open();
  return { send, watch };
}
