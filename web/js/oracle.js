// The oracle: faceless, the whole way through. No avatar, no eyes, no mouth:
// only its words, typed out on screen, and its voice, on screens with sound.
// It stays faceless so that the participant's face is the only face that
// ever forms. Its lines come from the eye (journey.py, config.yaml).

import { readable } from './reelface.js';

export const ORACLE_DEFAULTS = { size: 44, font: 'Consolas', color: '#141414', align: 'center', speak: true,
  states: ['awake', 'asking', 'forming'] };

const TYPE_SPEED = 28; // letters a second

export class OracleView {
  constructor(stage) {
    this.stage = stage;
    this.el = document.createElement('div');
    this.el.className = 'oracle-source';
    this.text = '';
    this.since = 0;
  }

  update(item) {
    Object.assign(this.el.style, {
      fontSize: `${item.size}px`,
      color: readable(item.color, this.stage.look?.background), // still readable on the face's background
      fontFamily: `"${item.font}", monospace`,
      textAlign: item.align,
    });
  }

  // The line on show now, from the journey: right even on a screen opened part-way through.
  journey(snapshot) {
    const text = snapshot.oracle_line ?? '';
    if (text !== this.text) {
      this.text = text;
      this.since = performance.now();
    }
  }

  // A new line, as it's said: spoken once, by every screen with sound.
  oracle(line) {
    if (!this.item?.speak || !this.stage.speechAllowed || !('speechSynthesis' in window) || !line.text) return;
    speechSynthesis.cancel();
    const voice = new SpeechSynthesisUtterance(line.text);
    voice.rate = 0.85;
    voice.pitch = 0.6; // flat and low: a voice without a body
    speechSynthesis.speak(voice);
  }

  draw(now) {
    const typed = Math.floor(((now - this.since) / 1000) * TYPE_SPEED);
    const shown = this.text.slice(0, typed).toUpperCase();
    if (this.el.textContent !== shown) this.el.textContent = shown;
  }
}
