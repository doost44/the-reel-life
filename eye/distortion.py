"""How far the reel face has got: its progress, from 0 (the first reel) to 1.

Progress comes mostly from the reels watched and partly from the time spent
watching them, so a long scroll is measurably further gone than a short
one. Every setting of the look (look.py) slides from its first-reels value
to its full-face value with it, and desire rises with it. An override sets
it by hand, for testing.
"""

from __future__ import annotations


def progress(reels: int, watched: float, settings: dict) -> float:
    """0 at the start, 1 at full: mostly the reels, partly the time."""
    distortion = settings["distortion"]
    return min(1.0, 0.6 * reels / distortion["full_at_reels"] + 0.4 * watched / distortion["full_at_seconds"])
