// Finds the participant's hair and ears, which the face tracker's points don't
// reach, with MediaPipe's multi-class selfie model (saved in web/vendor) on a
// thread of its own (segmenter-worker.js). It looks at a small copy of the very
// picture the face was found in, a few times a second, since hair moves slowly,
// and keeps where the head was in that picture, so the shape can follow the
// head between looks. It only starts once it's first needed. Nothing is kept:
// each picture is looked at and dropped, and only the newest shape is held.

const EVERY = 100; // ms at least between looks
const WIDTH = 256; // the model looks at 256×256; a bigger picture would only be shrunk

export class HeadSegmenter {
  constructor() {
    this.worker = null;
    this.ready = false;
    this.busy = false;
    this.mask = null;       // the newest shape: data (hair, skin: two bytes a pixel), width, height, head
    this.found = 0;         // counts shapes found, so a view knows when there's a new one
    this.hairLight = null;  // how bright the hair is on average (0-1), so dark hair still shows its light and dark
    this.ms = 0;            // how long the last look took, for the debug readout
    this.lastLook = -Infinity;
    this.head = null;       // where the head is in the picture being looked at
    this.dropNext = false;  // the look under way is from a visit that's over
  }

  start() {
    // A classic worker, as in tracker.js.
    this.worker = new Worker('/js/segmenter-worker.js');
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'ready') {
        this.ready = true;
      } else if (data.type === 'failed') {
        console.error('The hair model could not start:', data.error);
      } else {
        this.busy = false;
        this.ms = data.ms;
        if (this.dropNext) {
          this.dropNext = false; // looked at before the visit ended
          return;
        }
        this.mask = { data: data.mask, width: data.width, height: data.height, head: this.head };
        if (data.hairLight !== null) this.hairLight = (this.hairLight ?? data.hairLight) * 0.6 + data.hairLight * 0.4; // eased, so it doesn't flicker
        this.found += 1;
      }
    };
  }

  // The visit is over: nothing of this person's shape carries over to the next.
  forget() {
    this.mask = null;
    this.hairLight = null;
    this.dropNext = this.busy;
  }

  // Hands a small copy of this picture to the thread, if it's free and it's been long enough.
  look(picture, head, now) {
    if (!this.worker) this.start();
    if (!this.ready || this.busy || now - this.lastLook < EVERY) return;
    this.busy = true;
    this.lastLook = now;
    this.head = head;
    const resizeHeight = Math.max(2, Math.round((WIDTH * picture.height) / picture.width));
    createImageBitmap(picture, { resizeWidth: WIDTH, resizeHeight, resizeQuality: 'medium' })
      .then((copy) => this.worker.postMessage({ picture: copy }, [copy]))
      .catch(() => { this.busy = false; });
  }
}
