// A seeded random generator with the few numpy calls the eye makes
// (numpy.random.default_rng): uniform, integers, normal, choice, shuffle.
// Not the same numbers as numpy, only the same kinds.

export class Random {
  constructor(seed = Math.floor(Math.random() * 2 ** 32)) {
    this.state = seed >>> 0;
    this.spare = null; // normal() makes them in pairs
  }

  // mulberry32: 0 <= x < 1
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  uniform(low = 0, high = 1) {
    return low + (high - low) * this.next();
  }

  // integers(high) is 0 to high - 1, integers(low, high) low to high - 1, as numpy.
  integers(low, high) {
    if (high === undefined) [low, high] = [0, low];
    return low + Math.floor(this.next() * (high - low));
  }

  normal(mean = 0, deviation = 1) {
    if (this.spare !== null) {
      const value = this.spare;
      this.spare = null;
      return mean + deviation * value;
    }
    let u = 0;
    while (u === 0) u = this.next();
    const radius = Math.sqrt(-2 * Math.log(u));
    const angle = 2 * Math.PI * this.next();
    this.spare = radius * Math.sin(angle);
    return mean + deviation * radius * Math.cos(angle);
  }

  // An index into weights, chosen in proportion to them (they needn't add up to 1).
  choice(weights) {
    let total = 0;
    for (const weight of weights) total += weight;
    let at = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      at -= weights[i];
      if (at < 0) return i;
    }
    for (let i = weights.length - 1; i >= 0; i--) if (weights[i] > 0) return i;
    return weights.length - 1;
  }

  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = this.integers(i + 1);
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }
}
