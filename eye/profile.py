"""The visit profile: what the system learns about a visitor, in memory, for one visit.

Every reel counted this visit gets an entry: how long it was watched, whether
it was liked (and how often), whether the visitor came back to it with a swipe
back, and, once there's a classifier (A3 phase 2), its category with the
classifier's confidence and runner-up. From those, a running weight per
category: likes count most, then a reel watched to the end, then one watched
partly. Reels swiped past too soon to count are counted as skips.

Likes come in as events from any source (a test like from the operator, a key
or like pad, later the heart seen on the phone's screen: see config.yaml,
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
    category: str | None = None  # what the classifier thinks it is (phase 2)
    confidence: float | None = None
    runner_up: str | None = None
    captures: int = 0            # captures taken at the moment of a like (phase 2)


@dataclass
class Like:
    t: float
    source: str                  # test, key, pad, heart...
    reel: int | None             # the reel's number; None while it's the one on screen, not yet recorded


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
        self.entries.append(entry)
        return entry

    def like(self, t: float, source: str, on_screen: bool) -> Like | None:
        """A like: on the reel on the phone's screen now (on_screen), or else on the last reel counted.
        Returns it, or None if there's nothing to like yet."""
        if not self.on:
            return None
        if on_screen:
            like = Like(t, source, None)
        elif self.entries:
            like = Like(t, source, self.entries[-1].number)
            self.entries[-1].likes += 1
        else:
            return None
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
        self.unlikes += 1
        return True

    def classify(self, number: int, category: str, confidence: float, runner_up: str | None = None) -> bool:
        """The classifier's verdict on a reel (phase 2)."""
        entry = self._entry(number)
        if entry is None:
            return False
        entry.category, entry.confidence, entry.runner_up = category, float(confidence), runner_up
        return True

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
                "captures": sum(entry.captures for entry in self.entries), "likes": len(self.likes)}

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
                        "runner_up": entry.runner_up, "weight": round(self.weight_of(entry), 2)}
                       for entry in self.entries[-8:]],
            "held": self.held(),
        }
