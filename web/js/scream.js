// The oracle's digital scream, as it fractures. Made on the spot: harsh tones
// tearing upwards then plunging, through noise, clipped and chopped into pieces.
// A recording (voice/scream.wav) plays instead if there is one.

export function scream(seconds, clip) {
  if (clip) {
    new Audio(clip).play().catch(() => {});
    return;
  }
  const context = new AudioContext();
  context.resume().catch(() => {});
  const start = context.currentTime;
  const end = start + seconds;

  const clipped = context.createWaveShaper();
  clipped.curve = Float32Array.from({ length: 257 }, (_, i) => Math.max(-0.7, Math.min(0.7, ((i - 128) / 128) * 6)));
  // Chopped into pieces: the sound cutting in and out, like a signal failing.
  const chopped = context.createGain();
  for (let t = start; t < end; t += 0.018 + Math.random() * 0.045) chopped.gain.setValueAtTime(Math.random() < 0.8 ? 1 : 0.05, t);
  chopped.gain.setValueAtTime(0, end);
  clipped.connect(chopped).connect(context.destination);

  // The tones: each climbs to its peak and then falls away, out of tune with the rest.
  [[620, 'sawtooth'], [930, 'square'], [1480, 'sawtooth']].forEach(([pitch, type]) => {
    const tone = context.createOscillator();
    tone.type = type;
    tone.frequency.setValueAtTime(pitch, start);
    tone.frequency.exponentialRampToValueAtTime(pitch * 2.6, start + seconds * 0.45);
    tone.frequency.exponentialRampToValueAtTime(pitch * 0.18, end);
    const level = context.createGain();
    level.gain.value = 0.22;
    tone.connect(level).connect(clipped);
    tone.start(start);
    tone.stop(end);
  });

  // The noise under them.
  const noise = context.createBuffer(1, Math.ceil(context.sampleRate * seconds), context.sampleRate);
  const samples = noise.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
  const hiss = context.createBufferSource();
  hiss.buffer = noise;
  const hissLevel = context.createGain();
  hissLevel.gain.value = 0.3;
  hiss.connect(hissLevel).connect(clipped);
  hiss.start(start);

  setTimeout(() => context.close().catch(() => {}), (seconds + 0.5) * 1000);
}
