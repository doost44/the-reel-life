// The visit, as a journey through its stages. The Chrome version's copy of
// eye/journey.py (where the stages are described): change both together.
//
//   empty → awake → asking → forming → climax → dark → still → ended
//
// Times are in seconds, from the eye's own clock.

export const STAGES = ['empty', 'awake', 'asking', 'forming', 'climax', 'dark', 'still', 'ended'];

export class Journey {
  constructor(settings, emit, now) {
    this.settings = settings;
    this.emit = emit;
    this.visits = 0;               // every visit started, so nothing of one can reach the next
    this.present = false;          // someone's there: movement or a face
    this.face = false;             // a face is found
    this.phone = false;
    this.phoneOverride = null;     // the operator's "phone placed", for testing without one
    this.presentChangedAt = now;
    this.phoneChangedAt = now;
    this.line = '';                // what the oracle is saying now
    this.lines = [];               // ...and what it will say next
    this.lineAt = now;
    this.cleared = true;           // nobody has been there since the last visit ended, so the next can start
    this.waited = 0;               // how many times it has pressed for reels: 0, 1 ("download it"), 2 ("then leave")
    this.stage = 'empty';
    this.since = now;
  }

  get phonePresent() {
    return this.phoneOverride === null ? this.phone : this.phoneOverride;
  }

  // Reels count once one has been watched, while the phone stays on the platform.
  get counting() {
    return this.stage === 'forming' && this.phonePresent;
  }

  // Inputs

  onPresence(present, face, t) {
    this.face = face;
    if (present !== this.present) {
      this.present = present;
      this.presentChangedAt = t;
    }
  }

  onPhone(present, t) {
    if (present !== this.phone) {
      this.phone = present;
      if (this.phoneOverride === null) this.phoneChangedAt = t;
    }
  }

  overridePhone(present, t) {
    this.phoneOverride = present;
    this.phoneChangedAt = t;
  }

  // A reel was watched: the oracle has what it asked for.
  beginWatching(t) {
    if (this.stage === 'asking') {
      this.enter('forming', t);
      this.say(this.settings.oracle.begin, t);
    }
  }

  // The face is complete.
  beginClimax(t) {
    if (this.stage === 'forming') {
      this.enter('climax', t);
      this.line = '';
      this.lines = [];
    }
  }

  // The operator: everything wiped, back to nobody there.
  reset(t) {
    this.phoneOverride = null;
    this.cleared = true;
    this.enter('empty', t);
  }

  // Time passing

  tick(t) {
    const s = this.settings;
    const inStage = t - this.since;
    if (!this.present) this.cleared = true;
    if (this.stage === 'empty') {
      // Someone told to leave who stays isn't a new visitor, not for a while anyway.
      if (this.present && (this.cleared || inStage >= s.restart_after)) {
        this.visits += 1;
        this.enter('awake', t);
      }
      return;
    }
    if (this.stage === 'ended') {
      if (inStage >= s.rest_seconds) this.enter('empty', t);
      return;
    }
    if (this.stage === 'climax') {
      if (inStage >= s.becomes_seconds + s.fracture_seconds) this.enter('dark', t);
      return;
    }
    if (this.stage === 'dark') {
      if (inStage >= s.dark_seconds) this.enter('still', t);
      return;
    }
    const gone = !this.present && !this.phonePresent;
    const away = Math.min(t - this.presentChangedAt, t - this.phoneChangedAt);
    if (this.stage === 'still') {
      if (inStage >= s.still_seconds || (!this.present && t - this.presentChangedAt >= s.leave_after)) this.enter('ended', t);
      return;
    }
    if (gone && away >= s.leave_after) {
      this.enter('empty', t); // they've gone: the visit is over
      return;
    }
    this.nextLine(t);
    if (this.stage === 'awake') {
      if (inStage >= s.burst_seconds && !this.line && !this.lines.length) {
        this.say(s.oracle.place, t);
      } else if (this.line && !this.lines.length) {
        // The phone on the platform for a moment, once the oracle has asked for it (even if it was already there).
        const settled = Math.min(t - this.phoneChangedAt, t - this.lineAt);
        if (this.phonePresent && settled >= s.place_after) {
          this.enter('asking', t);
          this.waited = 0;
          this.say(s.oracle.ask, t);
        }
      }
    } else if (this.stage === 'asking' && !this.lines.length) {
      const waited = t - this.lineAt;
      if (this.waited === 0 && waited >= s.ask_patience) {
        this.waited = 1;
        this.say(s.oracle.download, t);
      } else if (this.waited === 1 && waited >= s.download_patience) {
        this.waited = 2;
        this.say(s.oracle.leave, t);
      } else if (this.waited === 2 && waited >= s.line_seconds) {
        this.line = '';
        this.enter('ended', t);
      }
    }
  }

  enter(stage, t) {
    this.stage = stage;
    this.since = t;
    if (stage === 'empty' || stage === 'ended') {
      this.line = '';
      this.lines = [];
    }
    if (stage === 'ended') this.cleared = false;
  }

  // The oracle

  // Queues lines; each stays for line_seconds, the last one until the next is said.
  say(lines, t) {
    this.lines = [...lines];
    this.lineAt = -1e9;
    this.nextLine(t);
  }

  nextLine(t) {
    if (t - this.lineAt < this.settings.line_seconds) return;
    if (this.lines.length) {
      this.line = this.lines.shift();
      this.lineAt = t;
      this.emit({ type: 'oracle', text: this.line, stage: this.stage });
    } else if (this.stage === 'forming' && this.line) {
      this.line = ''; // it has said its piece, and steps back
    }
  }

  // What pages see

  snapshot(t) {
    const s = this.settings;
    return {
      type: 'journey',
      stage: this.stage,
      stage_time: Math.round((t - this.since) * 100) / 100,
      present: this.present,
      face: this.face,
      phone: this.phonePresent,
      phone_override: this.phoneOverride,
      counting: this.counting,
      visits: this.visits,
      oracle_line: this.line,
      climax: { becomes_seconds: s.becomes_seconds, fracture_seconds: s.fracture_seconds, becomes: s.becomes },
    };
  }
}
