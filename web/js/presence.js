// Whether anyone's there, and where, from nothing more than movement on the
// face camera's picture, so the energy can wake before any face is found. A tiny
// grey copy of each picture is compared with the last; nothing is kept but that.

const EVERY = 80;             // ms at least between looks
const WIDE = 64, TALL = 48;   // the size of the copy
const PIXEL_MOVED = 18;       // how much a pixel must change to count as movement (0-255)
const SHARE_MOVED = 0.012;    // how many of them must, so a noisy camera isn't somebody
const LOOKS_IN_A_ROW = 3;     // ...and for how many looks in a row

export class MotionSensor {
  constructor() {
    this.ctx = Object.assign(document.createElement('canvas'), { width: WIDE, height: TALL })
      .getContext('2d', { willReadFrequently: true });
    this.previous = null;
    this.lastPicture = null;
    this.lastLook = -Infinity;
    this.inARow = 0;
    this.moving = false;    // someone is moving, now
    this.amount = 0;        // how much of the picture is moving, smoothed (0-1)
    this.place = [0, 0];    // where, mirrored like the face: -1 to 1 across and up
  }

  look(picture, now) {
    if (!picture || picture === this.lastPicture || now - this.lastLook < EVERY) return;
    this.lastPicture = picture;
    this.lastLook = now;
    try {
      this.ctx.drawImage(picture, 0, 0, WIDE, TALL);
    } catch {
      return; // a picture closed as it arrived: the next one will do
    }
    const pixels = this.ctx.getImageData(0, 0, WIDE, TALL).data;
    const grey = new Uint8Array(WIDE * TALL);
    let moved = 0, across = 0, up = 0;
    for (let i = 0; i < grey.length; i++) {
      grey[i] = (pixels[i * 4] + pixels[i * 4 + 1] * 2 + pixels[i * 4 + 2]) >> 2;
      if (this.previous && Math.abs(grey[i] - this.previous[i]) > PIXEL_MOVED) {
        moved += 1;
        across += i % WIDE;
        up += Math.floor(i / WIDE);
      }
    }
    this.previous = grey;
    const share = moved / grey.length;
    this.amount += (share - this.amount) * 0.3;
    this.inARow = share >= SHARE_MOVED ? this.inARow + 1 : 0;
    this.moving = this.inARow >= LOOKS_IN_A_ROW;
    if (moved) {
      const x = 1 - (across / moved / WIDE) * 2, y = 1 - (up / moved / TALL) * 2;
      this.place = [this.place[0] + (x - this.place[0]) * 0.2, this.place[1] + (y - this.place[1]) * 0.2];
    }
  }
}
