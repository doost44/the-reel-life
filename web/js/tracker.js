// Tracks the participant's face live, with MediaPipe's Face Landmarker (saved
// in web/vendor, so it works offline), on a thread of its own
// (tracker-worker.js). Every new picture from the face camera gives 478
// points on the face and how open the eyes and mouth are, so the reel face
// moves as they do: turns, tilts, blinks, where they look. While one picture
// is being looked at, newer ones are skipped, so it never falls behind.
// Nothing is kept; each picture is looked at and dropped.

export class FaceTracker {
  constructor() {
    this.ready = false;
    this.face = null;          // the last face found: points (x, y 0-1 across the picture, z; three numbers each), shapes, picture size
    this.picture = null;       // ...and the picture it was found in, so the skin always matches the shape
    this.found = 0;            // counts faces found, so a view knows when there's a new one
    this.seenAt = -Infinity;   // when it was found
    this.waiting = null;       // the picture being looked at now
    this.busy = false;
    this.lastPicture = null;
    this.lastTime = 0;
    // A classic worker, not a module one: MediaPipe loads its runtime with importScripts, which modules can't use.
    this.worker = new Worker(new URL('./tracker-worker.js', import.meta.url));
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'ready') this.ready = true;
      else if (data.type === 'failed') console.error('MediaPipe could not start:', data.error);
      else {
        this.busy = false;
        if (data.face) {
          this.picture?.close();
          this.picture = this.waiting;
          this.face = data.face;
          this.found += 1;
          this.seenAt = performance.now();
        } else {
          this.waiting?.close(); // no face in it: never shown
        }
        this.waiting = null;
      }
    };
  }

  // Hands the newest picture from the face camera to the tracking thread, if it's free and the picture is new.
  track(picture, now) {
    if (!this.ready || this.busy || !picture || picture === this.lastPicture) return;
    this.lastPicture = picture;
    this.busy = true;
    this.lastTime = Math.max(now, this.lastTime + 1); // MediaPipe wants its clock to keep moving forward
    const time = this.lastTime;
    // One copy goes to the thread; another waits here, to become the skin if a face is found in it.
    Promise.all([createImageBitmap(picture), createImageBitmap(picture)])
      .then(([copy, kept]) => {
        this.waiting = kept;
        this.worker.postMessage({ picture: copy, time }, [copy]);
      })
      .catch(() => { this.busy = false; });
  }

  // How long since a face was last found, in milliseconds.
  lostFor(now) {
    return now - this.seenAt;
  }
}
