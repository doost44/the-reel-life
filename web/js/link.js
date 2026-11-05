// One WebSocket to the eye. JSON messages go to onMessage; camera frames
// arrive as binary (the camera name's length, the name, then a JPEG) and go
// to onFrame as ImageBitmaps. Reconnects by itself.

export function connect({ onMessage, onFrame, onConnection = () => {} }) {
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
