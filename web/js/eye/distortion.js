// How far the reel face has got: its progress, from 0 (the first reel) to 1.
// The Chrome version's copy of eye/distortion.py: change both together.

// 0 at the start, 1 at full: mostly the reels, partly the time.
export function progressOf(reels, watched, settings) {
  const { distortion } = settings;
  return Math.min(1, 0.6 * reels / distortion.full_at_reels + 0.4 * watched / distortion.full_at_seconds);
}
