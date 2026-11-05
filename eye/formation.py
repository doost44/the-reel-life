"""How the reel face forms: each reel watched breaks into fragments of the face.

The fragments sit on MediaPipe's face layout (the square every point of the
face has a place on: canonical_face_model.obj), so wherever the participant's
head turns, a fragment stays on the same patch of their face. Each is a torn,
irregular piece of one of the reel's stills, turned at its own angle. The
first reels give a few big, faint pieces; later reels give more, smaller,
more ragged ones (the look's settings: look.py). Pieces go where the face is
still missing, so it fills in until the whole face has formed, and once it's
under way they lean towards the eyes, brows, nose and mouth so the likeness
sharpens.

Each piece is damaged as far as the face has got: colour knocked off its
neighbours', pixelated, saved again and again as a worse JPEG.

The face layout stops at the edge of the face, so some of each reel's pieces go
on a second layout instead, the head layout: the head as seen from the front,
measured in face heights, so pieces keep their shape wherever they land, and a
patch for each ear. The eye doesn't know where anyone's hair is, so they're
scattered round the face until it's covered, and each screen shows only the
ones that land on the hair and ears it finds (segmenter.js, reelface.js).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

from . import distortion, look
from .reel_sampler import STILL_SIZE, ReelRecord
from .settings import ROOT

LAYOUT_PATH = ROOT / "web" / "vendor" / "mediapipe" / "canonical_face_model.obj"
ATLAS_PIXELS = 1024  # the face layout's size on the screens (reelface.js)
GRID = 48            # how finely it keeps track of where the face is still missing
# The head layout (reelface.js builds its mesh with the same numbers): how many face heights
# it runs each way from the face's middle, and the two ears' patches (x, y, width, height), below the rest.
HEAD_REACH = 1.2
FACE_HEIGHT_ON_HEAD = 1 / (2 * HEAD_REACH)
FACE_HEIGHT_ON_EAR = 0.5
EAR_PATCHES = ((0.02, 0.87, 0.30, 0.12), (0.68, 0.87, 0.30, 0.12))

# The face's outline and features, by MediaPipe's landmark numbers.
OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176,
        149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
TOP, CHIN, SIDES = 10, 152, (234, 454)  # where the face is measured from, as in reelface.js
FEATURES = [
    [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],         # an eye
    [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],      # the other eye
    [70, 63, 105, 66, 107, 55, 65, 52, 53, 46],                                           # a brow
    [300, 293, 334, 296, 336, 285, 295, 282, 283, 276],                                   # the other brow
    [1, 2, 98, 327, 168, 6, 197, 195, 5, 4, 45, 275, 64, 294],                             # the nose
    [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185],  # the mouth
]


@dataclass
class Tile:
    number: int       # its place in the order fragments are shown, from 1
    reel: int         # the reel it came from
    rect: tuple       # x, y and size of the square its picture fills, on the face layout, 0-1 (x right, y down)
    outline: list     # its torn edge: [x, y] points on the face layout, 0-1
    jpeg: bytes       # its piece of a still
    due: float = 0.0  # when it's shown (monotonic seconds)
    layer: str = "face"  # the layout it's on: face, or head (the hair and ears)


def _layout_places() -> dict:
    """Where each point of the face sits on the face layout, 0-1."""
    places, place_of = [], {}
    for line in LAYOUT_PATH.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if parts and parts[0] == "vt":
            places.append((float(parts[1]), 1 - float(parts[2])))
        elif parts and parts[0] == "f":
            for corner in parts[1:4]:
                point, place = (int(n) - 1 for n in corner.split("/")[:2])
                place_of.setdefault(point, places[place])
    return place_of


def _head_ring() -> np.ndarray:
    """Where hair can be on the head layout: round the head, not on the face
    (with an overlap, so no gap opens along its edge), not far below the chin."""
    model = [tuple(float(n) for n in line.split()[1:4])
             for line in LAYOUT_PATH.read_text(encoding="utf-8").splitlines() if line.startswith("v ")]
    middle = np.mean([model[point] for point in (TOP, CHIN, *SIDES)], axis=0)
    tall = float(np.linalg.norm(np.subtract(model[TOP], model[CHIN])))

    def to_grid(across: float, up: float) -> tuple:
        return ((across / (2 * HEAD_REACH) + 0.5) * GRID, (0.5 - up / (2 * HEAD_REACH)) * GRID)

    oval = np.array([to_grid((model[p][0] - middle[0]) / tall, (model[p][1] - middle[1]) / tall) for p in OVAL], np.int32)
    face = np.zeros((GRID, GRID), np.uint8)
    cv2.fillPoly(face, [oval], 1)
    face = cv2.erode(face, np.ones((5, 5), np.uint8))
    round_head = np.zeros((GRID, GRID), np.uint8)
    cv2.circle(round_head, tuple(int(n) for n in to_grid(0, 0.1)), int(1.05 / (2 * HEAD_REACH) * GRID), 1, -1)
    round_head[int(to_grid(0, -0.85)[1]):] = 0
    return ((round_head > 0) & (face == 0)).astype(np.float32)


def _ear_patch(patch: tuple) -> np.ndarray:
    x, y, width, height = (int(round(n * GRID)) for n in patch)
    where = np.zeros((GRID, GRID))
    where[y:y + height, x:x + width] = 1
    return where


class FaceMap:
    """Where the face is on the layout, and where its features are, on a coarse
    grid; and where the hair and ears go on the head layout."""

    def __init__(self) -> None:
        place_of = _layout_places()
        self.head = _head_ring()
        self.ears = [_ear_patch(patch) for patch in EAR_PATCHES]
        self.face = np.zeros((GRID, GRID), np.uint8)
        cv2.fillPoly(self.face, [(np.array([place_of[p] for p in OVAL]) * GRID).astype(np.int32)], 1)
        self.face = self.face.astype(bool)
        self.features = np.zeros((GRID, GRID), np.uint8)
        for feature in FEATURES:
            hull = cv2.convexHull((np.array([place_of[p] for p in feature]) * GRID).astype(np.int32))
            cv2.fillConvexPoly(self.features, hull, 1)
        self.features = cv2.dilate(self.features, np.ones((3, 3), np.uint8)).astype(bool)


class Planner:
    """Breaks each reel into fragments of the face, reel by reel."""

    def __init__(self, settings: dict, face_map: FaceMap, seed: int) -> None:
        self.settings = settings
        self.map = face_map
        self.random = np.random.default_rng(seed)
        self.cover = np.zeros((GRID, GRID), np.float32)  # how many pieces have landed on each part of the face
        self.head_cover = np.zeros((GRID, GRID), np.float32)  # ...and of the head layout
        self.reels = 0
        self.watched = 0.0

    @property
    def progress(self) -> float:
        return distortion.progress(self.reels, self.watched, self.settings)

    @property
    def covered(self) -> float:
        """The share of the face at least one piece has landed on."""
        return float((self.cover[self.map.face] > 0).mean())

    def plan(self, reel: ReelRecord, settings: dict) -> list:
        """This reel's fragments: their places, edges and pictures (numbers and times come later)."""
        self.reels += 1
        self.watched += reel.watched
        at = self.progress
        stills = [cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR) for jpeg in reel.stills]
        stills = [still for still in stills if still is not None] or [_colour_tile(reel.colour, self.random)]
        count = max(1, round(look.value(settings, "fragments", at) * self.random.uniform(0.75, 1.25)))
        size = look.value(settings, "fragment_size", at)
        jagged = look.value(settings, "jagged", at)
        jpeg, bleed = look.value(settings, "jpeg", at), look.value(settings, "bleed", at)
        tiles = []
        for _ in range(count):
            centre = self._where(at)
            radius = size / 2 * self.random.uniform(0.6, 1.4)
            outline = self._torn(centre, radius, jagged)
            side = radius * 4  # room for the torn outline at its widest
            rect = (centre[0] - side / 2, centre[1] - side / 2, side)
            still = stills[int(self.random.integers(len(stills)))]
            tiles.append(Tile(0, reel.number, rect, outline, self._piece(still, side, jpeg, bleed)))
            self._land(self.cover, centre, radius)
        tiles += self._plan_head(reel, stills, settings, at, jagged, jpeg, bleed)
        self.random.shuffle(tiles)  # the face and its hair form together
        return tiles

    def _plan_head(self, reel: ReelRecord, stills: list, settings: dict, at: float, jagged: float, jpeg: float, bleed: float) -> list:
        """This reel's pieces for the hair and ears, on the head layout."""
        if max(settings["values"]["hair"]) <= 0:
            return []  # switched off
        count = round(look.value(settings, "hair_fragments", at) * self.random.uniform(0.75, 1.25))
        # A share of the face, like the face's pieces, so they come out about the same size on screen.
        size = look.value(settings, "hair_size", at)
        ears = self.map.ears if count >= len(self.map.ears) else []  # one for each ear, the rest on the head
        tiles = []
        for number in range(count):
            on_ear = number < len(ears)
            where = ears[number] if on_ear else self.map.head
            scale = FACE_HEIGHT_ON_EAR if on_ear else FACE_HEIGHT_ON_HEAD
            centre = _least_covered(where, self.head_cover, self.random)
            radius = min(size, 0.25 if on_ear else size) * scale / 2 * self.random.uniform(0.6, 1.4)
            side = radius * 4  # room for the torn outline at its widest
            rect = (centre[0] - side / 2, centre[1] - side / 2, side)
            still = stills[int(self.random.integers(len(stills)))]
            piece = self._piece(still, side, jpeg, bleed)
            tiles.append(Tile(0, reel.number, rect, self._torn(centre, radius, jagged), piece, layer="head"))
            self._land(self.head_cover, centre, radius)
        return tiles

    def _where(self, at: float) -> tuple:
        """Where a piece lands: mostly where the face is still missing, and,
        once it's under way, towards the features."""
        favour = np.where(self.map.features, 2.5, 1.0) if at > 0.1 else 1.0
        return _least_covered(self.map.face * favour, self.cover, self.random)

    def _torn(self, centre: tuple, radius: float, jagged: float) -> list:
        """A torn, irregular outline round a centre: stretched and turned, its
        edge pulled in and out, with the odd spike."""
        points = 8 + int(jagged * 14)
        stretch, turn = self.random.uniform(0.55, 1.45), self.random.uniform(0, math.pi)
        angles = np.sort(self.random.uniform(0, 2 * math.pi, points))
        outline = []
        for angle in angles:
            reach = radius * (1 - jagged * 0.55 * self.random.uniform())
            if self.random.uniform() < jagged * 0.25:
                reach *= 1.35  # a spike
            x, y = math.cos(angle) * reach * stretch, math.sin(angle) * reach / stretch
            outline.append([round(centre[0] + x * math.cos(turn) - y * math.sin(turn), 4),
                            round(centre[1] + x * math.sin(turn) + y * math.cos(turn), 4)])
        return outline

    @staticmethod
    def _land(cover: np.ndarray, centre: tuple, radius: float) -> None:
        mark = np.zeros((GRID, GRID), np.uint8)
        cv2.circle(mark, (int(centre[0] * GRID), int(centre[1] * GRID)), max(1, int(radius * 0.8 * GRID)), 1, -1)
        cover += mark

    def _piece(self, still: np.ndarray, side: float, jpeg: float, bleed: float) -> bytes:
        """A piece of a still, turned at its own angle, at the size it's drawn, damaged."""
        height, width = still.shape[:2]
        crop = int(min(width, height) * self.random.uniform(0.45, 1.0))
        x = int(self.random.integers(0, width - crop + 1))
        y = int(self.random.integers(0, height - crop + 1))
        pixels = int(np.clip(side * ATLAS_PIXELS, 24, 512))
        piece = cv2.resize(still[y:y + crop, x:x + crop], (pixels, pixels), interpolation=cv2.INTER_AREA)
        turn = cv2.getRotationMatrix2D((pixels / 2, pixels / 2), float(self.random.uniform(-35, 35)), 1.15)
        piece = cv2.warpAffine(piece, turn, (pixels, pixels), borderMode=cv2.BORDER_REFLECT)
        piece = _damage(piece, jpeg, bleed, self.random)
        return cv2.imencode(".jpg", piece, [cv2.IMWRITE_JPEG_QUALITY, 82])[1].tobytes()


def _least_covered(where: np.ndarray, cover: np.ndarray, random: np.random.Generator) -> tuple:
    """A place on a layout, 0-1: somewhere in where, mostly where least has landed."""
    weights = where / (1 + cover) ** 2
    weights = weights.ravel() / weights.sum()
    row, column = divmod(int(random.choice(weights.size, p=weights)), GRID)
    return ((column + random.uniform()) / GRID, (row + random.uniform()) / GRID)


def _damage(still: np.ndarray, jpeg: float, bleed: float, random: np.random.Generator) -> np.ndarray:
    """A piece of still, damaged as far as the face has got: its exposure and
    colour knocked off its neighbours', pixelated, and saved as a JPEG again
    and again at a falling quality, nudged a little each time (generation loss)."""
    gain = 1 + random.normal(0, 0.25 * bleed)
    cast = random.normal(0, 22 * bleed, 3)
    damaged = np.clip(still.astype(np.float32) * gain + cast, 0, 255).astype(np.uint8)
    height, width = damaged.shape[:2]
    if jpeg > 0.15:
        factor = 1 + 5 * jpeg * random.uniform(0.5, 1.0)
        small = cv2.resize(damaged, (max(4, int(width / factor)), max(4, int(height / factor))), interpolation=cv2.INTER_AREA)
        damaged = cv2.resize(small, (width, height), interpolation=cv2.INTER_NEAREST)
    quality = max(4, int(round(85 - 80 * jpeg)))
    for _ in range(1 + int(jpeg * 3)):
        damaged = np.roll(damaged, tuple(random.integers(-2, 3, 2)), axis=(0, 1))
        damaged = cv2.imdecode(cv2.imencode(".jpg", damaged, [cv2.IMWRITE_JPEG_QUALITY, quality])[1], cv2.IMREAD_COLOR)
    return damaged


def _colour_tile(colour: tuple, random: np.random.Generator) -> np.ndarray:
    """A reel with no usable still: its main colour, blurred and uneven."""
    width, height = STILL_SIZE
    noise = random.normal(0, 18, (height // 24, width // 24, 1))
    tile = np.clip(np.array(colour, np.float32) + cv2.resize(noise, (width, height), interpolation=cv2.INTER_CUBIC)[..., None], 0, 255)
    return cv2.GaussianBlur(tile.astype(np.uint8), (0, 0), 6)
