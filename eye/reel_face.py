"""The reel face: the participant's own face, formed out of the reels they watch.

Reels count once the phone is on the platform (journey.py). Each reel waits
its turn, is cut into tiles (formation.py: on the eye's worker thread, as it
takes a moment, see PlanJob), and its tiles are released
one at a time, a fraction of a second apart, so the face visibly builds:
never a whole reel at once, never a backlog dumped. The screens draw each
tile in as it's released (reelface.js), on top of the participant's
live-tracked face.

As fragments arrive, the face's progress rises (distortion.py), and with it
every setting of its look (look.py: tuned in the look editor) and desire:
one value, 0 to its cap, never resolving.
Once it has started forming, the face speaks for the participant, wanting
more: a word every few seconds, more insistent as desire rises. The eye picks
the words and when, so every screen says the same word at the same time.

Everything is held in memory for one visit and wiped when it ends. Nothing
is saved.
"""

from __future__ import annotations

import base64
import copy
import re
from dataclasses import dataclass

import numpy as np

from . import distortion, look
from .formation import FaceMap, Planner, Tile
from .reel_sampler import ReelRecord, test_reel
from .settings import ROOT

CLIP_TYPES = (".wav", ".mp3", ".ogg")


@dataclass
class PlanJob:
    """One reel to cut into fragments. Cutting takes up to half a second of
    image work, so the eye runs plan() on a worker thread, one job at a time,
    and hands the result back with ReelFace.planned()."""
    planner: Planner
    reel: ReelRecord
    look: dict

    def plan(self) -> list[Tile]:
        return self.planner.plan(self.reel, self.look)


class ReelFace:
    def __init__(self, settings: dict) -> None:
        self.settings = settings
        self.override: float | None = None  # the operator's intensity, for testing; None follows the session
        self.face_feed = "none"  # the face camera: camera, test (a recorded clip) or none; set by the eye
        self.speech_paused = False  # the operator: no words for now
        self.muted = False          # the operator: words shown and mouthed, not heard
        self._next_word_at = 0.0
        self.look = look.default_look()  # set by the eye from setup.json
        self._face_map = FaceMap()
        self._random = np.random.default_rng()
        self._visit = 0
        self._wipe()

    def _wipe(self) -> None:
        self.on = False                     # a visit is on
        self.reels: list[ReelRecord] = []   # the reels counted this visit, oldest first
        self.tiles: list[Tile] = []         # every tile planned, in order; shown once due
        self.shown = 0                      # how many of them are out
        self.scrub_to: int | None = None    # show the face as it was after this many reels
        self._planner = Planner(self.settings, self._face_map, seed=self._visit * 1000 + int(self._random.integers(1000)))
        self._planned = 0                   # reels planned into tiles so far
        self._job: PlanJob | None = None     # the reel being cut now, if any

    # What happens

    def begin(self) -> None:
        """A visit started: a clean slate."""
        self._visit += 1
        self._wipe()
        self.on = True

    def end(self) -> None:
        """The visit is over: forget everything, and let go of any hand on the intensity."""
        self._visit += 1
        self.override = None
        self._wipe()

    def add_reel(self, reel: ReelRecord) -> bool:
        if not self.on:
            return False
        self.reels.append(reel)
        return True

    def add_test_reels(self, count: int, t: float) -> bool:
        """Made-up reels, for trying it without a phone (tests/reels, or invented)."""
        if not self.on:
            return False
        for _ in range(max(0, min(count, 50))):
            self.reels.append(test_reel(len(self.reels) + 1, t, self._random))
        return True

    def reset_copy(self) -> None:
        """Back to no face at all: the reels so far are dropped (the visit goes on)."""
        if self.on:
            self._wipe()
            self.on = True

    def scrub(self, reels: int | None) -> None:
        """Show the face as it was after this many reels (None: as it is now)."""
        self.scrub_to = None if reels is None else max(0, int(reels))

    def set_intensity(self, value: float | None) -> None:
        """The operator's override of how broken it looks (0-1), or None to follow the session."""
        self.override = None if value is None else min(1.0, max(0.0, float(value)))

    def next_to_plan(self) -> PlanJob | None:
        """The next reel to cut, once the queue of tiles runs short; one at a time."""
        waiting = len(self.tiles) - self.shown
        if self._job or self._planned >= len(self.reels) or waiting >= self.settings["queue_tiles"]:
            return None
        reel = self.reels[self._planned]
        self._planned += 1
        self._job = PlanJob(self._planner, reel, copy.deepcopy(self.look))
        return self._job

    def planned(self, job: PlanJob, tiles: list[Tile], t: float) -> None:
        """A reel's fragments, cut: queued to be released one at a time. Dropped
        if the face was wiped while they were being cut."""
        if job is not self._job:
            return
        self._job = None
        # Steady, whatever the backlog: a little quicker when reels pile up, never all at once.
        seconds = self.settings["reel_seconds"] * (0.5 if len(self.reels) - self._planned > 3 else 1.0)
        gap = seconds / max(1, len(tiles))
        last = self.tiles[-1].due if self.tiles else t
        for tile in tiles:
            last = max(last + gap, t)
            tile.number, tile.due = len(self.tiles) + 1, last
            self.tiles.append(tile)

    def tick(self, t: float) -> list[Tile]:
        """The tiles due by now that haven't been shown."""
        due = []
        while self.shown < len(self.tiles) and self.tiles[self.shown].due <= t:
            due.append(self.tiles[self.shown])
            self.shown += 1
        return due

    def speak(self, t: float, allowed: bool) -> dict | None:
        """The next word, when it's time: chosen by how desiring the face is,
        sooner the more it is. Returns a word message, or None."""
        voice = self.settings["voice"]
        if not (allowed and self.on and not self.speech_paused and self.progress >= voice["speak_from"]):
            self._next_word_at = max(self._next_word_at, t + 1.5)  # never the instant it's allowed again
            return None
        if t < self._next_word_at:
            return None
        desire = self.message()["desire"]
        bands = voice["words"]
        words = bands[min(len(bands) - 1, int(desire * len(bands)))]
        text = words[int(self._random.integers(len(words)))]
        calm, urgent = voice["gap_seconds"]
        self._next_word_at = t + (calm + (urgent - calm) * desire) * self._random.uniform(0.85, 1.15)
        return {"type": "word", "text": text, "desire": desire, "clip": self.clip_for(text), "muted": self.muted}

    def clip_for(self, text: str) -> str | None:
        """A recorded clip of the word (voice/dont-stop.wav for "don't stop"), if there is one."""
        folder = ROOT / self.settings["voice"]["clips"]
        name = re.sub(r"[^a-z0-9]+", "-", text.lower().replace("'", "")).strip("-")
        for extension in CLIP_TYPES:
            if (folder / f"{name}{extension}").exists():
                return f"/voice/{name}{extension}"
        return None

    # How far it has got

    def _formed(self) -> list[ReelRecord]:
        """The reels whose tiles are all out: the face as it stands (as far back as the history goes)."""
        complete = {tile.reel for tile in self.tiles[:self.shown]}
        if self.shown < len(self.tiles):
            complete.discard(self.tiles[self.shown].reel)
        reels = [reel for reel in self.reels if reel.number in complete]
        return reels if self.scrub_to is None else reels[:self.scrub_to]

    def _shown_reels(self) -> tuple[int, float]:
        """Reels formed, and their seconds."""
        reels = self._formed()
        return len(reels), sum(reel.watched for reel in reels)

    def _reel_marks(self) -> list[float]:
        """How far formed the face was after each reel: where each reel took it (the look editor's timeline)."""
        marks, watched = [], 0.0
        for number, reel in enumerate(self._formed(), 1):
            watched += reel.watched
            marks.append(round(distortion.progress(number, watched, self.settings), 3))
        return marks

    @property
    def progress(self) -> float:
        reels, watched = self._shown_reels()
        return distortion.progress(reels, watched, self.settings)

    # What pages see

    def message(self) -> dict:
        reels, watched = self._shown_reels()
        at = distortion.progress(reels, watched, self.settings) if self.override is None else self.override
        desire = min(self.settings["desire_cap"], at)  # never quite 1: it never resolves
        waiting_reels = len(self.reels) - reels
        return {
            "type": "reel_face",
            "on": self.on,
            "face_feed": self.face_feed,
            "reels": len(self.reels),
            "formed_reels": reels,
            "waiting_reels": max(0, waiting_reels) if self.scrub_to is None else 0,
            "watched": round(sum(reel.watched for reel in self.reels), 1),
            "fragments": self.shown,
            "scrub": self.scrub_to,
            "progress": round(at, 3),
            "desire": round(desire, 3),
            "override": self.override,
            "covered": round(self._planner.covered, 3),
            "reel_marks": self._reel_marks(),
            "speech_paused": self.speech_paused,
            "muted": self.muted,
        }

    @staticmethod
    def tile_message(tile: Tile, animate: bool = True) -> dict:
        return {"type": "tile", "number": tile.number, "reel": tile.reel, "rect": tile.rect, "outline": tile.outline,
                "layer": tile.layer, "image": base64.b64encode(tile.jpeg).decode(), "animate": animate}

    def shown_tiles(self) -> list[Tile]:
        return self.tiles[:self.shown]
