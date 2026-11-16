"""The visit profile: what the system learns about a visitor, in memory, for one visit.

Every reel counted this visit gets an entry: how long it was watched, whether
it was liked (and how often), whether the visitor came back to it with a swipe
back, and, once there's a classifier (A3 phase 2), its category with the
classifier's confidence and runner-up. From those, a running weight per
category: likes count most, then a reel watched to the end, then one watched
partly. Reels swiped past too soon to count are counted as skips.

A like also brings a capture: the reel at that moment, made private
(privacy.py), classified, and kept only as a tiny degraded thumbnail. A
liked reel's category comes from its capture, which wins over the one from
its still.

Likes come in as events from any source (a test like from the operator, a key
or like pad, the heart seen on the phone's screen: see config.yaml,
profile.like_sources). A like lands on the reel on the phone's screen now: as
that reel hasn't been swiped away yet, there's no record of it, so the like
waits and joins the reel's entry when its record arrives. With no phone being
tracked (the operator's "phone placed" and test reels), it lands on the last
reel counted instead.

Nothing here is ever written anywhere. It's wiped when a visit starts and ends,
like the reel face (visits are counted, so nothing of one reaches the next).
The Chrome version's copy is web/js/eye/profile.js: change both together.
"""

from __future__ import annotations

from dataclasses import dataclass, field

LIKE_WINDOW_BEFORE = 0.3   # a like this soon before a reel's start still belongs to it (it was landing)
LIKE_WINDOW_AFTER = 0.5    # ...and this soon after its end (the swipe away was starting)
SWIPES_KEPT = 64


@dataclass
class Entry:
    number: int                  # the reel's number this visit, from 1 (as the reel face counts them)
    source: str                  # phone (the tracker saw it) or test (the operator's)
    started: float               # when it landed on the phone's screen (monotonic seconds)
    watched: float               # seconds on screen
    stills: int                  # stills of it held in memory (by the reel face)
    likes: int = 0
    revisited: bool = False      # the visitor came back to it with a swipe back
    category: str | None = None  # what the classifier thinks it is (Unreadable below its floor)
    confidence: float | None = None
    runner_up: str | None = None
    runner_up_confidence: float | None = None
    guess: str | None = None     # its best guess, even when that's below the floor
    category_from: str | None = None  # reel (a still of it), capture (a like's) or test (the operator's)
    captures: int = 0            # captures taken at the moment of a like


@dataclass
class Like:
    number: int                  # its place among this visit's likes, from 1
    t: float
    source: str                  # test, key, heart
    reel: int | None             # the reel's number; None while it's the one on screen, not yet recorded
    captured: bool = False       # its capture has been taken and classified
    verdict: dict | None = None  # the classifier's: category, confidence, runner_up, runner_up_confidence, guess
    thumb: str | None = None     # base64 JPEG, tiny and degraded


@dataclass
class Profile:
    settings: dict
    visit: int = 0
    on: bool = False
    entries: list[Entry] = field(default_factory=list)
    likes: list[Like] = field(default_factory=list)
    swipes: int = 0
    back: int = 0
    unlikes: int = 0
    _likes_made: int = 0
    _swipe_log: list[tuple[float, str]] = field(default_factory=list)

    def __post_init__(self) -> None:
        self._wipe()

    def _wipe(self) -> None:
        self.on = False
        self.entries = []
        self.likes = []
        self.swipes = 0
        self.back = 0
        self.unlikes = 0
        self._likes_made = 0
        self._swipe_log = []

    # A visit

    def begin(self) -> None:
        self.visit += 1
        self._wipe()
        self.on = True

    def end(self) -> None:
        self.visit += 1
        self._wipe()

    def clear_reels(self) -> None:
        """The operator's Clear face: the reels go, and their likes with them (the visit goes on)."""
        if self.on:
            self._wipe()
            self.on = True

    # What happens

    def on_swipe(self, swipe: dict) -> None:
        """Every swipe while the visit counts reels, next or back."""
        if not self.on:
            return
        self.swipes += 1
        if swipe.get("direction") == "back":
            self.back += 1
        self._swipe_log.append((float(swipe["t"]), swipe.get("direction", "next")))
        del self._swipe_log[:-SWIPES_KEPT]

    def add_reel(self, number: int, source: str, started: float, watched: float, stills: int) -> Entry | None:
        """A reel counted (the reel face's number for it). Likes that waited for it join it."""
        if not self.on:
            return None
        entry = Entry(number, source, started, watched, stills)
        # It came back to this reel if the swipe that brought it on screen was a swipe back.
        arrived = [direction for t, direction in self._swipe_log if t < started]
        entry.revisited = source == "phone" and bool(arrived) and arrived[-1] == "back"
        ended = started + watched
        for like in self.likes:
            if like.reel is None and started - LIKE_WINDOW_BEFORE <= like.t <= ended + LIKE_WINDOW_AFTER:
                like.reel = number
                entry.likes += 1
                if like.captured:
                    entry.captures += 1
                    self._apply(entry, like.verdict, "capture")
        self.entries.append(entry)
        return entry

    def like(self, t: float, source: str, on_screen: bool) -> Like | None:
        """A like: on the reel on the phone's screen now (on_screen), or else on the last reel counted.
        Returns it, or None if there's nothing to like yet."""
        if not self.on:
            return None
        if on_screen:
            like = Like(self._likes_made + 1, t, source, None)
        elif self.entries:
            like = Like(self._likes_made + 1, t, source, self.entries[-1].number)
            self.entries[-1].likes += 1
        else:
            return None
        self._likes_made += 1
        self.likes.append(like)
        return like

    def unlike(self) -> bool:
        """The last like taken back (the heart tapped again)."""
        if not (self.on and self.likes):
            return False
        like = self.likes.pop()
        entry = self._entry(like.reel)
        if entry:
            entry.likes = max(0, entry.likes - 1)
            entry.captures = max(0, entry.captures - (1 if like.captured else 0))
        self.unlikes += 1
        return True

    def classify(self, number: int, verdict: dict, source: str = "reel") -> bool:
        """The classifier's verdict on a reel, from a still of it (reel) or the operator's (test).
        A liked reel's capture has the last word, so a still's verdict never replaces it."""
        entry = self._entry(number)
        if entry is None or (entry.category_from == "capture" and source != "capture"):
            return False
        self._apply(entry, verdict, source)
        return True

    def captured(self, number: int, verdict: dict, thumb: str | None) -> Like | None:
        """A like's capture, classified (like number). Its reel's category comes from it from now on."""
        like = next((like for like in self.likes if like.number == number), None)
        if like is None or like.captured:
            return None
        like.captured, like.verdict, like.thumb = True, verdict, thumb
        entry = self._entry(like.reel)
        if entry:
            entry.captures += 1
            self._apply(entry, verdict, "capture")
        return like

    @staticmethod
    def _apply(entry: Entry, verdict: dict | None, source: str) -> None:
        if not verdict or (entry.category_from == "test" and source != "test"):
            return  # the operator's test category stands
        entry.category, entry.confidence = verdict["category"], float(verdict["confidence"])
        entry.runner_up, entry.runner_up_confidence = verdict.get("runner_up"), verdict.get("runner_up_confidence")
        entry.guess, entry.category_from = verdict.get("guess"), source

    def _entry(self, number: int | None) -> Entry | None:
        return next((entry for entry in self.entries if entry.number == number), None) if number is not None else None

    # What it adds up to

    def weight_of(self, entry: Entry) -> float:
        weights = self.settings["weights"]
        watch = weights["full_watch"] if entry.watched >= self.settings["full_watch_seconds"] else weights["partial_watch"]
        return weights["like"] * entry.likes + watch + (weights["revisit"] if entry.revisited else 0.0)

    def category_weights(self) -> dict[str, float]:
        totals: dict[str, float] = {}
        for entry in self.entries:
            category = entry.category or self.settings["unclassified"]
            totals[category] = totals.get(category, 0.0) + self.weight_of(entry)
        return {category: round(weight, 2) for category, weight in sorted(totals.items(), key=lambda item: -item[1])}

    @property
    def skipped(self) -> int:
        """Swipes that didn't end a counted reel: reels swiped past too soon."""
        tracked = sum(1 for entry in self.entries if entry.source == "phone")
        return max(0, self.swipes - tracked)

    def held(self) -> dict:
        """What's held in memory about this visit, counted (for the wipe at the end to report, truthfully)."""
        return {"reels": len(self.entries), "stills": sum(entry.stills for entry in self.entries),
                "captures": sum(1 for like in self.likes if like.captured), "likes": len(self.likes)}

    @staticmethod
    def like_message(like: Like) -> dict:
        verdict = like.verdict or {}
        return {"number": like.number, "reel": like.reel, "source": like.source, "captured": like.captured,
                "category": verdict.get("category"), "confidence": verdict.get("confidence"),
                "runner_up": verdict.get("runner_up"), "runner_up_confidence": verdict.get("runner_up_confidence"),
                "thumb": like.thumb}

    def message(self) -> dict:
        weights = self.category_weights()
        return {
            "type": "profile",
            "on": self.on,
            "reels": len(self.entries),
            "watched": round(sum(entry.watched for entry in self.entries), 1),
            "likes": len(self.likes),
            "liked_reels": sum(1 for entry in self.entries if entry.likes),
            "pending_likes": sum(1 for like in self.likes if like.reel is None),
            "unlikes": self.unlikes,
            "swipes": self.swipes,
            "back": self.back,
            "revisits": sum(1 for entry in self.entries if entry.revisited),
            "skipped": self.skipped,
            "weights": weights,
            "top": next(iter(weights), None),
            "recent": [{"number": entry.number, "source": entry.source, "watched": entry.watched, "likes": entry.likes,
                        "revisited": entry.revisited, "category": entry.category, "confidence": entry.confidence,
                        "runner_up": entry.runner_up, "category_from": entry.category_from,
                        "weight": round(self.weight_of(entry), 2)}
                       for entry in self.entries[-8:]],
            "liked": [self.like_message(like) for like in self.likes[-6:]],
            "held": self.held(),
        }
