"""Stills of the reels a visitor watches, for the reel face.

The swipe watcher hands over the camera frame and the phone screen's corners
a few times a second, without ever waiting; on a thread of its own, this
straightens the screen into an upright still. When a reel is swiped away,
the stills taken while it was on screen become that reel's record, if it was
watched long enough rather than just scrolled past. Blurry is fine: it's
what the camera saw. Records live in memory for the visit, never saved.

The system can't tell which reel it was (no ID, caption or sound), only when
it changed and how long it was watched.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Callable

import cv2
import numpy as np

from .settings import ROOT

STILL_SIZE = (270, 480)  # width, height: an upright phone screen, 9:16
CANDIDATES = 12          # stills kept while one reel plays (thinned out evenly when it plays long)
TEST_REELS = ROOT / "tests" / "reels"  # pictures or videos to feed in as test reels (optional)
_PICTURES = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
_VIDEOS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}


@dataclass
class ReelRecord:
    number: int         # its place among the reels watched this visit, from 1
    started: float      # when it landed on the screen (monotonic seconds)
    watched: float      # seconds on the screen
    stills: list        # JPEGs of the screen while it played; empty if none was usable
    colour: tuple       # its main colour (BGR), for when there's no usable still


class ReelSampler:
    def __init__(self, settings: dict, rotate: int, on_reel: Callable[[ReelRecord], None]) -> None:
        self.settings = settings
        self._rotate = rotate
        self._on_reel = on_reel
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._pending: list = []  # frames and swipes, in order; at most one frame waits
        self._last_offer = -1e9
        self._stopping = threading.Event()
        self._thread = threading.Thread(target=self._run, name="reel sampler", daemon=True)
        self._clear()

    def _clear(self) -> None:
        self._stills: list = []  # (time, still) for the reel on screen now
        self._reel_since: float | None = None
        self._count = 0

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stopping.set()
        self._wake.set()
        self._thread.join(2)

    # Called from other threads; none of these wait.

    def offer_frame(self, frame: np.ndarray, quad: np.ndarray, t: float) -> None:
        """A camera frame with the phone screen in it (the watcher's thread)."""
        if t - self._last_offer < self.settings["sample_seconds"]:
            return
        self._last_offer = t
        with self._lock:
            if self._pending and self._pending[-1][0] == "frame":
                self._pending[-1] = ("frame", frame, quad.copy(), t)  # only the newest waits
            else:
                self._pending.append(("frame", frame, quad.copy(), t))
        self._wake.set()

    def offer_swipe(self, swipe: dict) -> None:
        """A reel was swiped away (the watcher's thread)."""
        with self._lock:
            self._pending.append(("swipe", swipe))
        self._wake.set()

    def reset(self) -> None:
        """A new visit: forget the reel on screen and count from 1 again."""
        with self._lock:
            self._pending.append(("reset",))
        self._wake.set()

    # Its own thread

    def _run(self) -> None:
        while not self._stopping.is_set():
            self._wake.wait(0.5)
            self._wake.clear()
            with self._lock:
                pending, self._pending = self._pending, []
            for item in pending:
                try:
                    if item[0] == "frame":
                        self._take_still(*item[1:])
                    elif item[0] == "swipe":
                        self._reel_ended(item[1])
                    else:
                        self._clear()
                except Exception as error:  # a bad frame mustn't stop the sampling
                    print(f"Reel sampler: {error!r}")

    def _take_still(self, frame: np.ndarray, quad: np.ndarray, t: float) -> None:
        if self._reel_since is None:
            self._reel_since = t
        corners = np.roll(quad, -(self._rotate // 90) % 4, axis=0).astype(np.float32)
        width, height = STILL_SIZE
        upright = np.float32([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]])
        still = cv2.warpPerspective(frame, cv2.getPerspectiveTransform(corners, upright), STILL_SIZE,
                                    flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        self._stills.append((t, still))
        if len(self._stills) > CANDIDATES:
            self._stills = self._stills[::2]  # keep them spread across the reel

    def _reel_ended(self, swipe: dict) -> None:
        ended = swipe["t"]  # when the swipe began
        started = ended - swipe["dwell"] if swipe.get("dwell") is not None else self._reel_since
        stills, self._stills = self._stills, []
        self._reel_since = swipe["detected_at"]
        if started is None or ended - started < self.settings["min_watch_seconds"]:
            return  # scrolled past, not watched
        # Only stills from while it sat still on screen, not mid-swipe.
        during = [still for t, still in stills if started + 0.2 <= t <= ended - 0.1]
        usable = [still for still in during if _usable(still)]
        if len(usable) > self.settings["stills_per_reel"]:
            picks = np.linspace(0, len(usable) - 1, self.settings["stills_per_reel"]).round().astype(int)
            usable = [usable[i] for i in picks]
        colour = _main_colour(usable or during or [still for _, still in stills])
        self._count += 1
        jpegs = [cv2.imencode(".jpg", still, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes() for still in usable]
        self._on_reel(ReelRecord(self._count, started, round(ended - started, 2), jpegs, colour))


def test_reel(number: int, t: float, random: np.random.Generator) -> ReelRecord:
    """A made-up reel, for trying the reel face without a phone: stills from a
    picture or video in tests/reels if there are any, otherwise invented ones
    (bold colour, a shape, "TEST REEL n")."""
    files = sorted(path for path in TEST_REELS.glob("*") if path.suffix.lower() in _PICTURES | _VIDEOS) \
        if TEST_REELS.exists() else []
    stills = []
    if files:
        path = files[int(random.integers(len(files)))]
        stills = [_fill(still) for still in _stills_from(path, random)]
    if not stills:
        stills = [_invented(number, random, take) for take in range(3)]
    jpegs = [cv2.imencode(".jpg", still, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes() for still in stills]
    return ReelRecord(number, t, round(float(random.uniform(1.5, 7.0)), 2), jpegs, _main_colour(stills))


def _stills_from(path, random: np.random.Generator) -> list:
    if path.suffix.lower() in _PICTURES:
        still = cv2.imread(str(path))
        return [still] if still is not None else []
    capture = cv2.VideoCapture(str(path))
    frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    stills = []
    for at in sorted(random.integers(0, frames, 3)):
        capture.set(cv2.CAP_PROP_POS_FRAMES, int(at))
        ok, frame = capture.read()
        if ok:
            stills.append(frame)
    capture.release()
    return stills


def _fill(image: np.ndarray) -> np.ndarray:
    """Cropped to fill an upright phone screen."""
    width, height = STILL_SIZE
    scale = max(width / image.shape[1], height / image.shape[0])
    resized = cv2.resize(image, (round(image.shape[1] * scale), round(image.shape[0] * scale)), interpolation=cv2.INTER_AREA)
    x, y = (resized.shape[1] - width) // 2, (resized.shape[0] - height) // 2
    return resized[y:y + height, x:x + width]


def _invented(number: int, random: np.random.Generator, take: int) -> np.ndarray:
    width, height = STILL_SIZE
    hue = (number * 37 + take * 6) % 180
    colour = cv2.cvtColor(np.uint8([[[hue, 200, 230]]]), cv2.COLOR_HSV2BGR)[0, 0].tolist()
    other = cv2.cvtColor(np.uint8([[[(hue + 90) % 180, 220, 160]]]), cv2.COLOR_HSV2BGR)[0, 0].tolist()
    still = np.full((height, width, 3), colour, np.uint8)
    for stripe in range(0, height, 48):
        cv2.rectangle(still, (0, stripe), (width, stripe + 10), other, -1)
    centre = (int(random.integers(60, width - 60)), int(random.integers(120, height - 120)))
    cv2.circle(still, centre, int(random.integers(40, 110)), (255, 255, 255), -1)
    cv2.putText(still, "TEST", (20, 70), cv2.FONT_HERSHEY_DUPLEX, 1.6, (20, 20, 20), 3)
    cv2.putText(still, f"REEL {number}", (20, height - 40), cv2.FONT_HERSHEY_DUPLEX, 1.5, (20, 20, 20), 3)
    return still


def _usable(still: np.ndarray) -> bool:
    """Not black, and not one flat colour."""
    gray = cv2.cvtColor(still, cv2.COLOR_BGR2GRAY)
    return float(gray.mean()) > 20 and float(gray.std()) > 10


def _main_colour(stills: list) -> tuple:
    if not stills:
        return (90, 90, 90)
    pixels = np.concatenate([cv2.resize(still, (27, 48), interpolation=cv2.INTER_AREA).reshape(-1, 3) for still in stills])
    return tuple(int(v) for v in np.median(pixels, axis=0))
