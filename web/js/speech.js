// The face's voice: the words it says for the participant, in the first
// person, wanting more. Each word comes from the eye (reel_face.py) with how
// desiring the face is. This says it, with a recorded clip when there is one
// (voice/), otherwise the computer's voice: quicker, louder and more insistent
// as desire rises, never breathy. Moment by moment it tells the face how open
// its mouth should be and which word to show. On a screen without sound, or
// muted, or where the browser won't play it, the mouth still moves and the
// word still shows.

const LETTER_MS = 75; // roughly how long a letter takes to say, at the normal rate
const FADE_MS = 900;  // the word stays on screen this long after it's said

export class FaceVoice {
  constructor() {
    this.word = null;
    this.shape = [];
    this.analyser = null;
    this.level = 0;
  }

  // A word from the eye. sound: this screen may make sound.
  say(message, sound) {
    const rate = 0.95 + 0.55 * message.desire;
    this.shape = mouthShape(message.text);
    this.letterMs = LETTER_MS / rate;
    this.analyser = null;
    this.word = { text: message.text, desire: message.desire, at: performance.now(), duration: this.shape.length * this.letterMs };
    if (!sound || message.muted) return;
    if (message.clip) this.playClip(message.clip, message.desire);
    else this.speak(message.text, message.desire, rate);
  }

  speak(text, desire, rate) {
    if (!('speechSynthesis' in window)) return;
    const word = this.word;
    const voice = new SpeechSynthesisUtterance(text);
    voice.rate = rate;
    voice.pitch = 1 + 0.25 * desire;
    voice.volume = 0.5 + 0.5 * desire; // faint at first
    voice.voice = faceVoice();
    voice.onstart = () => { word.at = performance.now(); }; // the mouth starts with the sound
    speechSynthesis.speak(voice);
  }

  playClip(url, desire) {
    const word = this.word;
    this.context ??= new AudioContext();
    this.context.resume().catch(() => {}); // made before the page was clicked, it stays silent until resumed
    const audio = new Audio(url);
    audio.volume = Math.min(1, 0.6 + 0.4 * desire);
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 512;
    this.context.createMediaElementSource(audio).connect(analyser);
    analyser.connect(this.context.destination);
    audio.onloadedmetadata = () => { word.duration = audio.duration * 1000; };
    audio.onplay = () => {
      word.at = performance.now();
      this.analyser = analyser; // the mouth follows the sound itself
      this.samples = new Float32Array(analyser.fftSize);
    };
    audio.onended = () => { if (this.word === word) this.analyser = null; };
    audio.play().catch(() => {}); // not allowed to play: the mouth still moves, from the letters
  }

  // How open the mouth is now, 0 to 1.
  mouth(now) {
    if (!this.word) return 0;
    let target = 0;
    if (this.analyser) {
      this.analyser.getFloatTimeDomainData(this.samples);
      let sum = 0;
      for (const sample of this.samples) sum += sample * sample;
      target = Math.min(1, Math.sqrt(sum / this.samples.length) * 7);
    } else {
      const t = (now - this.word.at) / this.letterMs;
      if (t >= 0 && t < this.shape.length) {
        const i = Math.floor(t);
        const next = this.shape[Math.min(i + 1, this.shape.length - 1)];
        target = this.shape[i] + (next - this.shape[i]) * (t - i);
      }
    }
    this.level += (target - this.level) * 0.45; // no snapping shut or open
    return this.level;
  }

  // The word to show and how strongly: it fades once it's been said.
  shown(now) {
    if (!this.word) return null;
    const after = now - this.word.at - this.word.duration;
    const alpha = after < 0 ? 1 : 1 - after / FADE_MS;
    return alpha > 0 ? { text: this.word.text, alpha, desire: this.word.desire } : null;
  }
}

// How open the mouth is on each letter: wide on vowels, shut on m, b and p.
export function mouthShape(text) {
  return [...text.toLowerCase()].map((letter) => {
    if ('aeo'.includes(letter)) return 0.95;
    if ('iuy'.includes(letter)) return 0.6;
    if ('mbp'.includes(letter)) return 0.02;
    if ('fvw'.includes(letter)) return 0.2;
    if (/[a-z]/.test(letter)) return 0.35;
    return 0.08; // spaces and punctuation: a breath
  }).concat([0]);
}

// A voice for the face: an English one other than the oracle's default, if there is one.
function faceVoice() {
  const english = speechSynthesis.getVoices().filter((voice) => voice.lang.startsWith('en'));
  return english.find((voice) => !voice.default) ?? english[0] ?? null;
}
