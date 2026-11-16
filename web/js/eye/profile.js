// The visit profile: what the system learns about a visitor, in memory, for
// one visit. The Chrome version's copy of eye/profile.py (where it's
// described): change both together.

const LIKE_WINDOW_BEFORE = 0.3; // a like this soon before a reel's start still belongs to it (it was landing)
const LIKE_WINDOW_AFTER = 0.5;  // ...and this soon after its end (the swipe away was starting)
const SWIPES_KEPT = 64;

const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;

export class Profile {
  constructor(settings) {
    this.settings = settings;
    this.visit = 0;
    this.wipe();
  }

  wipe() {
    this.on = false;
    // { number, source, started, watched, stills, likes, revisited, category, confidence, runnerUp,
    //   runnerUpConfidence, guess, categoryFrom, captures }
    this.entries = [];
    // { number, t, source, reel (null while it's the one on screen, not yet recorded), captured, verdict, thumb }
    this.likes = [];
    this.likesMade = 0;
    this.swipes = 0;
    this.back = 0;
    this.unlikes = 0;
    this.swipeLog = []; // [t, direction]
  }

  // A visit

  begin() {
    this.visit += 1;
    this.wipe();
    this.on = true;
  }

  end() {
    this.visit += 1;
    this.wipe();
  }

  // The operator's Clear face: the reels go, and their likes with them (the visit goes on).
  clearReels() {
    if (this.on) {
      this.wipe();
      this.on = true;
    }
  }

  // What happens

  onSwipe(swipe) {
    if (!this.on) return;
    this.swipes += 1;
    if (swipe.direction === 'back') this.back += 1;
    this.swipeLog.push([Number(swipe.t), swipe.direction ?? 'next']);
    this.swipeLog.splice(0, Math.max(0, this.swipeLog.length - SWIPES_KEPT));
  }

  // A reel counted (the reel face's number for it). Likes that waited for it join it.
  addReel(number, source, started, watched, stills) {
    if (!this.on) return null;
    const entry = {
      number, source, started, watched, stills, likes: 0, revisited: false,
      category: null, confidence: null, runnerUp: null, runnerUpConfidence: null, guess: null, categoryFrom: null, captures: 0,
    };
    // It came back to this reel if the swipe that brought it on screen was a swipe back.
    const arrived = this.swipeLog.filter(([t]) => t < started);
    entry.revisited = source === 'phone' && arrived.length > 0 && arrived[arrived.length - 1][1] === 'back';
    const ended = started + watched;
    for (const like of this.likes) {
      if (like.reel === null && like.t >= started - LIKE_WINDOW_BEFORE && like.t <= ended + LIKE_WINDOW_AFTER) {
        like.reel = number;
        entry.likes += 1;
        if (like.captured) {
          entry.captures += 1;
          Profile.apply(entry, like.verdict, 'capture');
        }
      }
    }
    this.entries.push(entry);
    return entry;
  }

  // A like: on the reel on the phone's screen now (onScreen), or else on the last reel counted.
  like(t, source, onScreen) {
    if (!this.on) return null;
    let like;
    const made = { number: this.likesMade + 1, t, source, captured: false, verdict: null, thumb: null };
    if (onScreen) {
      like = { ...made, reel: null };
    } else if (this.entries.length) {
      const last = this.entries[this.entries.length - 1];
      like = { ...made, reel: last.number };
      last.likes += 1;
    } else {
      return null;
    }
    this.likesMade += 1;
    this.likes.push(like);
    return like;
  }

  // The last like taken back (the heart tapped again).
  unlike() {
    if (!(this.on && this.likes.length)) return false;
    const like = this.likes.pop();
    const entry = this.entry(like.reel);
    if (entry) {
      entry.likes = Math.max(0, entry.likes - 1);
      entry.captures = Math.max(0, entry.captures - (like.captured ? 1 : 0));
    }
    this.unlikes += 1;
    return true;
  }

  // The classifier's verdict on a reel, from a still of it (reel) or the operator's (test).
  // A liked reel's capture has the last word, so a still's verdict never replaces it.
  classify(number, verdict, source = 'reel') {
    const entry = this.entry(number);
    if (!entry || (entry.categoryFrom === 'capture' && source !== 'capture')) return false;
    Profile.apply(entry, verdict, source);
    return true;
  }

  // A like's capture, classified (like number). Its reel's category comes from it from now on.
  captured(number, verdict, thumb) {
    const like = this.likes.find((candidate) => candidate.number === number);
    if (!like || like.captured) return null;
    Object.assign(like, { captured: true, verdict, thumb });
    const entry = this.entry(like.reel);
    if (entry) {
      entry.captures += 1;
      Profile.apply(entry, verdict, 'capture');
    }
    return like;
  }

  static apply(entry, verdict, source) {
    if (!verdict || (entry.categoryFrom === 'test' && source !== 'test')) return; // the operator's test category stands
    Object.assign(entry, {
      category: verdict.category, confidence: Number(verdict.confidence), runnerUp: verdict.runner_up ?? null,
      runnerUpConfidence: verdict.runner_up_confidence ?? null, guess: verdict.guess ?? null, categoryFrom: source,
    });
  }

  entry(number) {
    return number === null || number === undefined ? null : this.entries.find((entry) => entry.number === number) ?? null;
  }

  // What it adds up to

  weightOf(entry) {
    const weights = this.settings.weights;
    const watch = entry.watched >= this.settings.full_watch_seconds ? weights.full_watch : weights.partial_watch;
    return weights.like * entry.likes + watch + (entry.revisited ? weights.revisit : 0);
  }

  categoryWeights() {
    const totals = new Map();
    for (const entry of this.entries) {
      const category = entry.category ?? this.settings.unclassified;
      totals.set(category, (totals.get(category) ?? 0) + this.weightOf(entry));
    }
    // Heaviest first; a stable sort keeps first-seen order on ties, as Python's sorted() does.
    return Object.fromEntries([...totals].sort((a, b) => b[1] - a[1]).map(([category, weight]) => [category, round(weight, 2)]));
  }

  // Swipes that didn't end a counted reel: reels swiped past too soon.
  get skipped() {
    const tracked = this.entries.filter((entry) => entry.source === 'phone').length;
    return Math.max(0, this.swipes - tracked);
  }

  // What's held in memory about this visit, counted (for the wipe at the end to report, truthfully).
  held() {
    return {
      reels: this.entries.length,
      stills: this.entries.reduce((sum, entry) => sum + entry.stills, 0),
      captures: this.likes.filter((like) => like.captured).length,
      likes: this.likes.length,
    };
  }

  static likeMessage(like) {
    const verdict = like.verdict ?? {};
    return {
      number: like.number, reel: like.reel, source: like.source, captured: like.captured,
      category: verdict.category ?? null, confidence: verdict.confidence ?? null,
      runner_up: verdict.runner_up ?? null, runner_up_confidence: verdict.runner_up_confidence ?? null, thumb: like.thumb,
    };
  }

  message() {
    const weights = this.categoryWeights();
    return {
      type: 'profile',
      on: this.on,
      reels: this.entries.length,
      watched: round(this.entries.reduce((sum, entry) => sum + entry.watched, 0), 1),
      likes: this.likes.length,
      liked_reels: this.entries.filter((entry) => entry.likes).length,
      pending_likes: this.likes.filter((like) => like.reel === null).length,
      unlikes: this.unlikes,
      swipes: this.swipes,
      back: this.back,
      revisits: this.entries.filter((entry) => entry.revisited).length,
      skipped: this.skipped,
      weights,
      top: Object.keys(weights)[0] ?? null,
      recent: this.entries.slice(-8).map((entry) => ({
        number: entry.number, source: entry.source, watched: entry.watched, likes: entry.likes, revisited: entry.revisited,
        category: entry.category, confidence: entry.confidence, runner_up: entry.runnerUp, category_from: entry.categoryFrom,
        weight: round(this.weightOf(entry), 2),
      })),
      liked: this.likes.slice(-6).map((like) => Profile.likeMessage(like)),
      held: this.held(),
    };
  }
}
