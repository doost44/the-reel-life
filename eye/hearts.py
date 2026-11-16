"""Seeing a like on the phone's own screen.

There's no way for a third party to know someone tapped the heart in the
Instagram app, and visitors install nothing and log in to nothing. So the
eye looks: once the operator has clicked where the like button sits on the
phone's screen (setup.json, like_button: a point on the upright screen, as
fractions), each frame it straightens just a small square there and measures
how much of it is the heart's saturated red. Red that holds for a few frames
while the screen sits still is a like; red going away is an unlike. A
double-tap on the video fills the same button, so that's caught too.

Only that square is ever looked at, so red in the video itself can't set it
off; and nothing is read mid-swipe. Nor while the phone's outline has moved
since the button was last read (a thumb over a corner can pull the outline
off, and the square with it): with the phone's position locked (the
Detection panel), as it should be on the platform, that never happens. After a swipe lands, the new reel's
button is read once to learn its state (it may already be liked), which is
not a like.

The Chrome version's copy is web/js/eye/hearts.js: change both together.
"""

from __future__ import annotations

import cv2
import numpy as np

from .reel_sampler import STILL_SIZE

PATCH = 24  # the square, straightened, in pixels


def screen_transform(quad: np.ndarray, rotate: int) -> np.ndarray:
    """Frame pixels to the upright screen (STILL_SIZE pixels), as the sampler straightens it."""
    corners = np.roll(quad, -(rotate // 90) % 4, axis=0).astype(np.float32)
    width, height = STILL_SIZE
    upright = np.float32([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]])
    return cv2.getPerspectiveTransform(corners, upright)


def point_on_screen(point: tuple[float, float], frame_size: tuple[int, int], quad: np.ndarray, rotate: int) -> list | None:
    """A point clicked on the camera picture (fractions of it) as fractions of the upright screen, or None if it's off the screen."""
    x, y = point[0] * frame_size[0], point[1] * frame_size[1]
    u, v = cv2.perspectiveTransform(np.float32([[[x, y]]]), screen_transform(quad, rotate))[0, 0]
    u, v = u / (STILL_SIZE[0] - 1), v / (STILL_SIZE[1] - 1)
    if not (0 <= u <= 1 and 0 <= v <= 1):
        return None
    return [round(float(u), 4), round(float(v), 4)]


class HeartWatcher:
    def __init__(self, settings: dict) -> None:
        self.settings = settings
        self.button: tuple[float, float] | None = None  # on the upright screen, as fractions
        self.state: str | None = None    # red or outline, once learnt for the reel on screen
        self.share = 0.0                 # how much of the square was red, last frame
        self.box: np.ndarray | None = None  # the square's corners on the camera picture, for the detection view
        self.likes = 0
        self._reading: str | None = None
        self._count = 0
        self._since = 0.0
        self._anchor: np.ndarray | None = None  # the phone's outline when the button was last read

    def set_button(self, button: list | None) -> None:
        self.button = (float(button[0]), float(button[1])) if button else None
        self.reset()

    def reset(self) -> None:
        """A new reel (or a new button): its state is learnt afresh, not taken as a like."""
        self.state = None
        self._reading, self._count = None, 0
        self._anchor = None

    def drifted(self, quad: np.ndarray) -> bool:
        """The outline has moved since the button was last read: the square may be off the button."""
        if self._anchor is None:
            return False
        diagonal = float(np.linalg.norm(self._anchor[2] - self._anchor[0]))
        return float(np.abs(quad - self._anchor).max()) > self.settings["max_drift"] * diagonal

    def look(self, frame: np.ndarray, quad: np.ndarray, rotate: int) -> float:
        """How much of the square round the button is the heart's red (0-1)."""
        width = STILL_SIZE[0]
        side = self.settings["box"] * width
        cx, cy = self.button[0] * (STILL_SIZE[0] - 1), self.button[1] * (STILL_SIZE[1] - 1)
        x0, y0 = cx - side / 2, cy - side / 2
        scale = PATCH / side
        zoom = np.array([[scale, 0, -x0 * scale], [0, scale, -y0 * scale], [0, 0, 1]], dtype=np.float64)
        transform = zoom @ screen_transform(quad, rotate)
        patch = cv2.warpPerspective(frame, transform, (PATCH, PATCH), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        corners = np.float32([[[0, 0]], [[PATCH, 0]], [[PATCH, PATCH]], [[0, PATCH]]])
        self.box = cv2.perspectiveTransform(corners, np.linalg.inv(transform))[:, 0]
        hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
        hue, saturation, value = hsv[..., 0], hsv[..., 1], hsv[..., 2]
        low, high = self.settings["red_hues"]
        red = ((hue >= low) | (hue <= high)) & (saturation >= self.settings["min_saturation"]) & (value >= self.settings["min_value"])
        return float(red.mean())

    def process(self, frame: np.ndarray, quad: np.ndarray | None, rotate: int, t: float,
                still: bool, landed_at: float | None) -> list[dict]:
        """One frame. still: the screen isn't moving (no swipe under way). Returns like and unlike events."""
        if self.button is None or quad is None:
            self.box = None
            return []
        self.share = self.look(frame, quad, rotate)
        settings = self.settings
        if (not still or (landed_at is not None and t - landed_at < settings["settle_seconds"])
                or self.drifted(quad)):
            self._reading, self._count = None, 0
            return []
        reading = ("red" if self.share >= settings["red_share"]
                   else "outline" if self.share <= settings["outline_share"] else None)
        if reading is None:
            return []
        if reading != self._reading:
            self._reading, self._count, self._since = reading, 0, t
        self._count += 1
        if self._count < settings["frames"]:
            return []
        if self._anchor is None:
            self._anchor = np.array(quad, dtype=np.float32)
        if reading == self.state:
            return []
        if self.state is None:
            self.state = reading  # the reel's button as it was when it landed: learnt, not a like
            return []
        self.state = reading
        if reading == "red":
            self.likes += 1
        return [{"type": "like" if reading == "red" else "unlike", "source": "heart", "t": self._since}]
