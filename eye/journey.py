"""The visit, as a journey through these stages:

    empty    nobody there: the energy lies dormant
    awake    someone's there (any movement will do, a face isn't needed): the
             energy bursts to life, and asks for the phone on the platform
    asking   the phone is down: the oracle says it has never seen a reel, and
             asks to watch some. It waits. No reels: "download it". Still none:
             "then leave", and the visit is over
    forming  the first reel is watched: reels count from here, and the face
             forms out of them. Nobody has been told it would
    climax   the face is complete: it becomes the person, then fractures, fast,
             with a digital scream
    dark     a few seconds of nothing
    still    their face comes back, with a code to take a still of it away
    ended    dark again for a moment, so the next person starts clean

The reel face's page says whether it sees movement and a face; the phone tracker
says whether the phone is on the platform. A visit also ends if everyone and
the phone have been gone for a while, or when the operator resets it; everything
made of it is wiped then (the eye does that, counting visits).
"""

from __future__ import annotations

import time
from typing import Callable

STAGES = ("empty", "awake", "asking", "forming", "climax", "dark", "still", "ended")


class Journey:
    def __init__(self, settings: dict, emit: Callable[[dict], None]) -> None:
        self.settings = settings
        self._emit = emit
        now = time.monotonic()
        self.visits = 0               # every visit started, so nothing of one can reach the next
        self.present = False          # someone's there: movement or a face
        self.face = False             # a face is found
        self.phone = False
        self.phone_override: bool | None = None  # the operator's "phone placed", for testing without one
        self._present_changed_at = now
        self._phone_changed_at = now
        self.line = ""                # what the oracle is saying now
        self._lines: list[str] = []   # ...and what it will say next
        self._line_at = now
        self._cleared = True          # nobody has been there since the last visit ended, so the next can start
        self._waited = 0              # how many times it has pressed for reels: 0, 1 ("download it"), 2 ("then leave")
        self.stage = "empty"
        self.since = now

    @property
    def phone_present(self) -> bool:
        return self.phone if self.phone_override is None else self.phone_override

    @property
    def counting(self) -> bool:
        """Reels count once one has been watched, while the phone stays on the platform."""
        return self.stage == "forming" and self.phone_present

    # Inputs

    def on_presence(self, present: bool, face: bool, t: float) -> None:
        self.face = face
        if present != self.present:
            self.present = present
            self._present_changed_at = t

    def on_phone(self, present: bool, t: float) -> None:
        if present != self.phone:
            self.phone = present
            if self.phone_override is None:
                self._phone_changed_at = t

    def override_phone(self, present: bool | None, t: float) -> None:
        self.phone_override = present
        self._phone_changed_at = t

    def begin_watching(self, t: float) -> None:
        """A reel was watched: the oracle has what it asked for."""
        if self.stage == "asking":
            self._enter("forming", t)
            self._say(self.settings["oracle"]["begin"], t)

    def begin_climax(self, t: float) -> None:
        """The face is complete."""
        if self.stage == "forming":
            self._enter("climax", t)
            self.line, self._lines = "", []

    def reset(self, t: float) -> None:
        """The operator: everything wiped, back to nobody there (anyone still there starts a new visit)."""
        self.phone_override = None
        self._cleared = True
        self._enter("empty", t)

    # Time passing

    def tick(self, t: float) -> None:
        s = self.settings
        in_stage = t - self.since
        if not self.present:
            self._cleared = True
        if self.stage == "empty":
            # Someone told to leave who stays isn't a new visitor, not for a while anyway.
            if self.present and (self._cleared or in_stage >= s["restart_after"]):
                self.visits += 1
                self._enter("awake", t)
            return
        if self.stage == "ended":
            if in_stage >= s["rest_seconds"]:
                self._enter("empty", t)
            return
        if self.stage == "climax":
            if in_stage >= s["becomes_seconds"] + s["fracture_seconds"]:
                self._enter("dark", t)
            return
        if self.stage == "dark":
            if in_stage >= s["dark_seconds"]:
                self._enter("still", t)
            return
        gone = not self.present and not self.phone_present
        away = min(t - self._present_changed_at, t - self._phone_changed_at)
        if self.stage == "still":
            if in_stage >= s["still_seconds"] or (not self.present and t - self._present_changed_at >= s["leave_after"]):
                self._enter("ended", t)
            return
        if gone and away >= s["leave_after"]:
            self._enter("empty", t)  # they've gone: the visit is over
            return
        self._next_line(t)
        if self.stage == "awake":
            if in_stage >= s["burst_seconds"] and not self.line and not self._lines:
                self._say(s["oracle"]["place"], t)
            # The phone on the platform for a moment, once the oracle has asked for it (even if it was already there).
            elif self.line and not self._lines:
                settled = min(t - self._phone_changed_at, t - self._line_at)
                if self.phone_present and settled >= s["place_after"]:
                    self._enter("asking", t)
                    self._waited = 0
                    self._say(s["oracle"]["ask"], t)
        elif self.stage == "asking" and not self._lines:
            waited = t - self._line_at
            if self._waited == 0 and waited >= s["ask_patience"]:
                self._waited = 1
                self._say(s["oracle"]["download"], t)
            elif self._waited == 1 and waited >= s["download_patience"]:
                self._waited = 2
                self._say(s["oracle"]["leave"], t)
            elif self._waited == 2 and waited >= s["line_seconds"]:
                self.line = ""
                self._enter("ended", t)

    def _enter(self, stage: str, t: float) -> None:
        self.stage = stage
        self.since = t
        if stage in ("empty", "ended"):
            self.line, self._lines = "", []
        if stage == "ended":
            self._cleared = False

    # The oracle

    def _say(self, lines: list[str], t: float) -> None:
        """Queues lines; each stays for line_seconds, the last one until the next is said."""
        self._lines = list(lines)
        self._line_at = -1e9
        self._next_line(t)

    def _next_line(self, t: float) -> None:
        if t - self._line_at < self.settings["line_seconds"]:
            return
        if self._lines:
            self.line = self._lines.pop(0)
            self._line_at = t
            self._emit({"type": "oracle", "text": self.line, "stage": self.stage})
        elif self.stage == "forming" and self.line:
            self.line = ""  # it has said its piece, and steps back

    # What pages see

    def snapshot(self, t: float) -> dict:
        s = self.settings
        return {
            "type": "journey",
            "stage": self.stage,
            "stage_time": round(t - self.since, 2),
            "present": self.present,
            "face": self.face,
            "phone": self.phone_present,
            "phone_override": self.phone_override,
            "counting": self.counting,
            "visits": self.visits,
            "oracle_line": self.line,
            "climax": {"becomes_seconds": s["becomes_seconds"], "fracture_seconds": s["fracture_seconds"], "becomes": s["becomes"]},
        }
