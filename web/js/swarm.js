// The energy, as a swarm of torn shards in the same space as the head, and what
// the face is made of. Free, they drift in a cloud round whoever is there, some in
// front of the face and some behind it, pushed along by a flow and by each word
// the oracle says. When a fragment of the face is released it bends the cloud
// towards it, like a drain, and pulls the nearest shards out; they streak into it,
// taking on its reel's colours, and it grows as it absorbs them (reelface.js). The
// face sheds shards back the whole time, in the colours of its reels, so the two
// are always passing through each other. At the climax it bursts into all of them.

export const SWARM_COUNT = 2200;
export const SHARD_VALUES = 11; // for each shard drawn: x, y, size, light, angle, stretch, seed, red, green, blue, depth
export const SHARDS_DRAWN = SWARM_COUNT * 2; // with the streaks behind those flying in

const FREE = 0, PULLED = 1, SPENT = 2, FLYING = 3;
const REACH_DORMANT = 0.14;  // how far the cloud reaches, in face heights: asleep,
const REACH_AWAKE = 0.62;    // ...awake,
const REACH_NEAR = 0.2;      // ...and more when someone's close
const CLOUD_DEPTH = 0.55;    // how far it goes in front of and behind the middle of the head
const TALLNESS = 1.08, WIDENESS = 0.82; // the cloud's shape, roughly a head's
const SMALLEST = 0.012, BIGGEST = 0.06; // a shard's radius, in face heights
const EDGE_FADE = 0.14;      // shards fade out this far from the edge of the frame, so none are ever cut off
const DRAIN_REACH = 0.55;    // how far a forming fragment's pull bends the cloud
const STREAK_COPIES = 2;     // copies behind a shard flying in, fainter, as a streak

export class EnergySwarm {
  constructor() {
    const numbers = () => new Float32Array(SWARM_COUNT);
    this.x = numbers();
    this.y = numbers();
    this.z = numbers();
    this.xSpeed = numbers();
    this.ySpeed = numbers();
    this.age = numbers();       // how long it has been flying to a fragment, seconds
    this.flight = numbers();    // ...and how long that takes it
    this.seeds = new Float32Array(SWARM_COUNT * 4); // four random numbers, its own
    this.tint = new Float32Array(SWARM_COUNT * 3);
    this.goal = new Float32Array(SWARM_COUNT * 3);  // where it's flying to: see locate in update
    this.goalKind = new Uint8Array(SWARM_COUNT);
    this.mode = new Uint8Array(SWARM_COUNT);
    this.fragment = new Array(SWARM_COUNT).fill(null);
    this.shards = new Float32Array(SHARDS_DRAWN * SHARD_VALUES);
    this.count = 0;             // how many of those to draw
    this.free = 0;
    this.spent = [];            // those used up, to be shed by the face again
    this.drains = [];           // the fragments forming now, pulling at the cloud
    this.shedding = 0;          // shards owed by the face, as time passes
    this.spot = [0, 0, 0];
    for (let i = 0; i < this.seeds.length; i++) this.seeds[i] = Math.random();
    this.reset();
  }

  // A new visit: all of them back in the cloud, in its own colours.
  reset() {
    for (let i = 0; i < SWARM_COUNT; i++) {
      this.mode[i] = FREE;
      this.fragment[i] = null;
      this.x[i] = (this.seeds[i * 4] - 0.5) * REACH_DORMANT;
      this.y[i] = (this.seeds[i * 4 + 1] - 0.5) * REACH_DORMANT;
      this.z[i] = 0;
      this.xSpeed[i] = 0;
      this.ySpeed[i] = 0;
      for (let k = 0; k < 3; k++) this.tint[i * 3 + k] = 0.5 + 0.5 * Math.cos(6.2832 * (this.seeds[i * 4 + 2] + k * 0.33));
    }
    this.free = SWARM_COUNT;
    this.spent = [];
    this.drains = [];
    this.shedding = 0;
  }

  // Bursting to life: every free shard flung outwards.
  kick(strength) {
    for (let i = 0; i < SWARM_COUNT; i++) {
      if (this.mode[i] !== FREE) continue;
      const turn = this.seeds[i * 4] * 6.2832;
      this.xSpeed[i] += Math.cos(turn) * strength * (0.4 + this.seeds[i * 4 + 1]);
      this.ySpeed[i] += Math.sin(turn) * strength * (0.4 + this.seeds[i * 4 + 1]);
    }
  }

  // How many a fragment of this size pulls: a share of what's in the cloud.
  shareFor(size, pull) {
    return this.free ? Math.max(1, Math.min(16, Math.ceil(this.free * 0.005 * (size / 0.2) * pull))) : 0;
  }

  // The nearest free shards fly to these places, one each. (x, y): where the fragment is now.
  // goals: [kind, a, b, c] for locate. palette: its reel's colours. Returns how many it pulled.
  pull(fragment, x, y, goals, palette) {
    const nearest = [];
    for (let i = 0; i < SWARM_COUNT; i++) {
      if (this.mode[i] === FREE) nearest.push([(this.x[i] - x) ** 2 + (this.y[i] - y) ** 2, i]);
    }
    nearest.sort((a, b) => a[0] - b[0]);
    const count = Math.min(goals.length, nearest.length);
    for (let n = 0; n < count; n++) {
      const i = nearest[n][1];
      this.mode[i] = PULLED;
      this.fragment[i] = fragment;
      this.age[i] = 0;
      this.flight[i] = 0.55 + 0.55 * Math.random();
      [this.goalKind[i], this.goal[i * 3], this.goal[i * 3 + 1], this.goal[i * 3 + 2]] = goals[n];
      this.tint.set(palette[Math.floor(Math.random() * palette.length)], i * 3);
    }
    this.free -= count;
    if (count) this.drains.push({ goal: goals[0], age: 0, x, y, strength: 0 });
    return count;
  }

  // Used up, with no flight to see: a screen opened part-way through a visit.
  spend(count) {
    let left = count;
    for (let i = 0; i < SWARM_COUNT && left > 0; i++) {
      if (this.mode[i] === FREE) {
        this.mode[i] = SPENT;
        this.spent.push(i);
        this.free -= 1;
        left -= 1;
      }
    }
  }

  // The face breaks up into them: every shard, from somewhere on it, flying out.
  explode(place, palette) {
    for (let i = 0; i < SWARM_COUNT; i++) {
      this.mode[i] = FLYING;
      this.fragment[i] = null;
      const [x, y, z] = place();
      const length = Math.hypot(x, y) || 1;
      const speed = 0.5 + 2.6 * this.seeds[i * 4 + 2] * this.seeds[i * 4 + 3];
      const turn = (this.seeds[i * 4] - 0.5) * 1.2;
      const xWay = x / length, yWay = y / length;
      this.x[i] = x;
      this.y[i] = y;
      this.z[i] = z;
      this.xSpeed[i] = (xWay * Math.cos(turn) - yWay * Math.sin(turn)) * speed;
      this.ySpeed[i] = (xWay * Math.sin(turn) + yWay * Math.cos(turn)) * speed;
      if (palette.length) this.tint.set(palette[Math.floor(Math.random() * palette.length)], i * 3);
    }
    this.free = 0;
    this.spent = [];
    this.drains = [];
  }

  // The face sheds a used shard back into the cloud, from somewhere on it, in its reels' colours.
  shed(place, palette) {
    const i = this.spent.pop();
    const [x, y, z] = place();
    const turn = Math.random() * 6.2832;
    this.mode[i] = FREE;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.xSpeed[i] = Math.cos(turn) * 0.5;
    this.ySpeed[i] = Math.sin(turn) * 0.5;
    if (palette.length) this.tint.set(palette[Math.floor(Math.random() * palette.length)], i * 3);
    this.free += 1;
  }

  // One step of time. feel: seconds, clock (the flow's own time), alive, burst, near, voice, offset, spread, glow,
  // size, fade (of the free ones), clear, breaking, frame { wide, tall, middle }, shedRate, place, palette.
  // locate(kind, a, b, c, out): where a goal is now, on the frame and in depth.
  update(feel, locate) {
    const { seconds, clock, alive, burst, near, voice, offset, spread, glow, size, fade, clear, breaking, frame } = feel;
    const { spot } = this;

    this.shedding += feel.shedRate * seconds;
    while (this.shedding >= 1) {
      this.shedding -= 1;
      if (this.spent.length) this.shed(feel.place, feel.palette);
    }

    // The fragments forming now: each a drain in the cloud, until it's fed.
    this.drains = this.drains.filter((drain) => {
      drain.age += seconds;
      locate(drain.goal[0], drain.goal[1], drain.goal[2], drain.goal[3], spot);
      drain.x = spot[0];
      drain.y = spot[1];
      drain.strength = Math.min(1, drain.age * 5) * Math.max(0, 1 - drain.age / 1.6);
      return drain.age < 1.6;
    });

    const damping = Math.exp(-3 * seconds);
    // The cloud, as big as it should be, as long as that fits the frame wherever the person is.
    const wanted = (REACH_DORMANT + (REACH_AWAKE + REACH_NEAR * near - REACH_DORMANT) * alive) * spread;
    const reaches = Math.min(wanted, (frame.tall * 0.86 - Math.abs(offset[1])) / TALLNESS, (frame.wide * 0.86 - Math.abs(offset[0])) / WIDENESS);
    const light = Math.min(1, (0.1 + alive * (0.3 + 0.6 * near) + voice * 0.35 + burst * 0.7) * glow);
    this.count = 0;
    for (let i = 0; i < SWARM_COUNT; i++) {
      const mode = this.mode[i];
      if (mode === SPENT) continue;
      const s0 = this.seeds[i * 4], s1 = this.seeds[i * 4 + 1], s2 = this.seeds[i * 4 + 2], s3 = this.seeds[i * 4 + 3];
      let x = this.x[i], y = this.y[i], z = this.z[i], xSpeed = this.xSpeed[i], ySpeed = this.ySpeed[i];
      let shardLight = light, shardSize = size * (SMALLEST + (BIGGEST - SMALLEST) * s3 * s3) * (1 + 0.8 * voice + 0.5 * burst);

      if (mode === FREE) {
        // Its place in the cloud, turning slowly, and the flow over that.
        const turn = s0 * 6.2832 + clock * (0.08 + 0.3 * s2) * (s3 > 0.5 ? 1 : -1);
        const reach = Math.pow(s1, 0.7) * reaches;
        const middleX = offset[0], middleY = frame.middle + offset[1];
        const homeX = Math.cos(turn) * WIDENESS * reach + middleX + (0.04 + 0.1 * alive) * Math.sin(clock * 0.9 + y * 6 + s2 * 9);
        const homeY = Math.sin(turn) * TALLNESS * reach + middleY + (0.04 + 0.1 * alive) * Math.cos(clock * 0.7 + x * 6 + s3 * 9);
        xSpeed += (homeX - x) * 7 * seconds;
        ySpeed += (homeY - y) * 7 * seconds;
        // It weaves through the head: some in front of the face, some behind, changing as it goes.
        const homeZ = -0.2 + CLOUD_DEPTH * Math.sin(s2 * 6.2832 + clock * (0.2 + 0.5 * s0));
        z += (homeZ - z) * Math.min(1, 2 * seconds);
        // Each word runs through it, outwards.
        if (voice > 0.01) {
          const dx = x - middleX, dy = y - middleY;
          const away = Math.hypot(dx, dy) || 1;
          const wave = 1.1 + 0.9 * Math.sin(away * 10 - clock * 7 + s0 * 2);
          xSpeed += (dx / away) * voice * wave * 7 * seconds;
          ySpeed += (dy / away) * voice * wave * 7 * seconds;
        }
        // Each forming fragment bends the cloud towards it, swirling in.
        for (const drain of this.drains) {
          const dx = drain.x - x, dy = drain.y - y;
          const away = Math.hypot(dx, dy) || 0.001;
          if (away > DRAIN_REACH) continue;
          const pull = drain.strength * (1 - away / DRAIN_REACH) * 22 * seconds;
          xSpeed += ((dx - dy * 0.7) / away) * pull;
          ySpeed += ((dy + dx * 0.7) / away) * pull;
          shardLight = Math.min(1, shardLight + drain.strength * (1 - away / DRAIN_REACH) * 0.5);
        }
        xSpeed *= damping;
        ySpeed *= damping;
        shardLight *= fade * (1 - clear);
      } else if (mode === PULLED) {
        this.age[i] += seconds;
        const through = Math.min(1, this.age[i] / this.flight[i]);
        locate(this.goalKind[i], this.goal[i * 3], this.goal[i * 3 + 1], this.goal[i * 3 + 2], spot);
        const pull = 3 + 34 * through * through;
        const wantX = (spot[0] - x) * pull * 0.5, wantY = (spot[1] - y) * pull * 0.5;
        const follow = 1 - Math.exp(-seconds * (2 + 16 * through));
        xSpeed += (wantX - xSpeed) * follow;
        ySpeed += (wantY - ySpeed) * follow;
        z += (spot[2] + 0.04 - z) * Math.min(1, seconds * (2 + 12 * through));
        shardLight = Math.max(light, 0.9) * (1 - clear);
        shardSize *= 1.5 - 0.9 * through;
        if (through >= 1 || (spot[0] - x) ** 2 + (spot[1] - y) ** 2 < 0.0004) {
          this.mode[i] = SPENT;
          this.spent.push(i);
          const fragment = this.fragment[i];
          this.fragment[i] = null;
          if (fragment) fragment.absorbed += 1;
          continue;
        }
      } else {
        // Flying out of the broken face.
        shardLight = (1 - breaking) ** 0.5;
        xSpeed *= Math.exp(-1.2 * seconds);
        ySpeed *= Math.exp(-1.2 * seconds);
        shardSize *= 1.6;
      }

      x += xSpeed * seconds;
      y += ySpeed * seconds;

      // The edge of the frame: the free ones turn back; anything near it fades, so nothing is ever cut off.
      const fromSide = frame.wide - Math.abs(x), fromEnd = frame.tall - Math.abs(y - frame.middle);
      if (mode === FREE) {
        if (fromSide < EDGE_FADE) xSpeed -= Math.sign(x) * (EDGE_FADE - fromSide) * 40 * seconds;
        if (fromEnd < EDGE_FADE) ySpeed -= Math.sign(y - frame.middle) * (EDGE_FADE - fromEnd) * 40 * seconds;
      }
      shardLight *= Math.min(1, Math.max(0, Math.min(fromSide, fromEnd) / EDGE_FADE));

      this.x[i] = x;
      this.y[i] = y;
      this.z[i] = z;
      this.xSpeed[i] = xSpeed;
      this.ySpeed[i] = ySpeed;

      // Torn out along the way it's going: the faster, the longer.
      const speed = Math.hypot(xSpeed, ySpeed);
      const moving = Math.min(1, speed * 0.9);
      const spin = s0 * 6.2832 + clock * (s1 - 0.5) * 2;
      const angle = moving > 0.15 ? Math.atan2(ySpeed, xSpeed) : spin;
      const stretch = (0.55 + 0.9 * s2) * (1 + (mode === PULLED ? 1.8 : 0.8) * moving);

      this.write(x, y, z, shardSize, shardLight, angle, stretch, s1, i);
      // Those flying in leave a streak, so you can see where they've come from.
      if (mode === PULLED && this.count < SHARDS_DRAWN - STREAK_COPIES) {
        for (let copy = 1; copy <= STREAK_COPIES; copy++) {
          const back = copy * 0.045;
          this.write(x - xSpeed * back, y - ySpeed * back, z, shardSize * (1 - copy * 0.2), shardLight * (1 - copy * 0.33), angle, stretch, s1, i);
        }
      }
    }
  }

  write(x, y, z, size, light, angle, stretch, seed, i) {
    const out = this.shards;
    const at = this.count++ * SHARD_VALUES;
    out[at] = x;
    out[at + 1] = y;
    out[at + 2] = size;
    out[at + 3] = light;
    out[at + 4] = angle;
    out[at + 5] = stretch;
    out[at + 6] = seed;
    out[at + 7] = this.tint[i * 3];
    out[at + 8] = this.tint[i * 3 + 1];
    out[at + 9] = this.tint[i * 3 + 2];
    out[at + 10] = z;
  }
}
