"""Run the visit profile of both eyes on the same visit, side by side: the
Python one (eye/profile.py) and the Chrome version's copy
(web/js/eye/profile.js, in Node). They should agree on everything, and be
empty once the visit ends. Run this after changing either.

    python tools/check_profile.py

Needs Node.js (18 or newer) on PATH.
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from eye import settings  # noqa: E402
from eye.profile import Profile  # noqa: E402

NODE_SIDE = Path(__file__).with_name("profile_events.mjs")

# A made-up visit: (kind, ...arguments). Times in seconds.
VISIT = [
    ("like", 0.5, "test", False),        # before the visit: nothing
    ("begin",),
    ("like", 1.0, "test", False),        # no reels yet: nothing to like
    ("swipe", 2.0, "next"),
    ("like", 4.0, "key", True),          # on the reel on screen: waits for its record
    ("swipe", 9.5, "next"),
    ("reel", 1, "phone", 2.3, 7.2, 3),   # ...which takes the like
    ("swipe", 10.0, "next"),             # skipped
    ("swipe", 12.0, "back"),
    ("swipe", 14.0, "next"),
    ("reel", 2, "phone", 12.3, 1.7, 2),  # came back to it
    ("like", 15.0, "test", True),
    ("like", 15.2, "test", True),
    ("unlike",),                         # one taken back
    ("swipe", 26.0, "next"),
    ("reel", 3, "phone", 14.3, 11.7, 3), # watched to the end, liked
    ("captured", 2, {"category": "Food", "confidence": 0.38, "runner_up": "Pets / cute", "runner_up_confidence": 0.31,
                     "guess": "Food"}, "dGh1bWI="),  # the like on reel 3, its capture classified
    ("classify", 3, {"category": "Travel / scenery", "confidence": 0.9, "runner_up": "Food", "runner_up_confidence": 0.05,
                     "guess": "Travel / scenery"}, "reel"),  # a still's verdict can't replace the capture's
    ("reel", 4, "test", 30.0, 4.4, 3),
    ("like", 31.0, "test", False),       # no phone: on the last reel
    ("classify", 4, {"category": "Food", "confidence": 0.71, "runner_up": "Travel / scenery", "runner_up_confidence": 0.2,
                     "guess": "Food"}, "reel"),
    ("reel", 5, "test", 32.0, 2.1, 3),
    ("classify", 5, {"category": "Unreadable", "confidence": 0.22, "runner_up": "Food", "runner_up_confidence": 0.2,
                     "guess": "Pets / cute"}, "test"),
    ("end",),
]


def run_python(config: dict) -> list:
    profile, out = Profile(config), []
    for kind, *args in VISIT:
        if kind == "begin":
            profile.begin()
        elif kind == "end":
            profile.end()
        elif kind == "clear":
            profile.clear_reels()
        elif kind == "swipe":
            profile.on_swipe({"t": args[0], "direction": args[1]})
        elif kind == "reel":
            profile.add_reel(*args)
        elif kind == "like":
            like = profile.like(*args)
            out.append(["liked", like.reel if like else None])
        elif kind == "unlike":
            profile.unlike()
        elif kind == "classify":
            profile.classify(*args)
        elif kind == "captured":
            profile.captured(*args)
        out.append(profile.message())
    return out


def main() -> None:
    node = shutil.which("node")
    if not node:
        sys.exit("Node.js isn't on PATH.")
    config = settings.load_config()["profile"]
    python = run_python(config)
    result = subprocess.run([node, str(NODE_SIDE)], input=json.dumps({"settings": config, "events": VISIT}),
                            capture_output=True, text=True, check=True)
    chrome = json.loads(result.stdout)

    peak = max((m for m in python if isinstance(m, dict)), key=lambda m: m["reels"])
    print(f"At its fullest: {peak['reels']} reels, {peak['likes']} likes ({peak['liked_reels']} reels liked), "
          f"{peak['back']} back, {peak['revisits']} came back to, {peak['skipped']} skipped")
    print(f"  weights: {peak['weights']}")
    print(f"  held: {peak['held']}")
    last = python[-1]
    empty = not last["on"] and last["reels"] == 0 and last["likes"] == 0 and not last["weights"] \
        and all(value == 0 for value in last["held"].values())
    print("Empty after the visit." if empty else f"NOT EMPTY after the visit: {last}")
    differences = [(i, VISIT[min(i, len(VISIT) - 1)], p, c) for i, (p, c) in enumerate(zip(python, chrome)) if p != c]
    if len(python) != len(chrome):
        differences.append((-1, "length", len(python), len(chrome)))
    for index, event, p, c in differences[:5]:
        print(f"\nDiffer at step {index} {event}:\n  python {p}\n  chrome {c}")
    print("Both eyes agree." if not differences else f"{len(differences)} differences.")
    sys.exit(0 if empty and not differences else 1)


if __name__ == "__main__":
    main()
