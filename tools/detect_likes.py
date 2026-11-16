"""Run the like detector (eye/hearts.py) on a recorded clip and list every
like it sees, the way the eye does: the swipe detector finds the phone, and
the like button's square is read on it every frame.

    python tools/detect_likes.py tests/clips/synthetic-likes-seed6.avi --button 0.9,0.436
    python tools/detect_likes.py recordings/2026-11-20_140210.avi --button 0.91,0.62 [--zone x,y,x,y,x,y,x,y]

--button is where the like button sits on the upright phone screen, as
fractions (the Detection view's "Click the like button" saves the same thing
to setup.json as like_button; without --button that's used). If a .likes.csv
sits next to the clip (tools/make_test_clip.py --likes makes one; for a real
recording, write one by hand: a "t" column of seconds), it's scored: likes
caught (precision and recall) and how late each was seen.
"""

import argparse
import csv
import json
import sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from eye import settings  # noqa: E402
from eye.detector import Detector  # noqa: E402
from eye.hearts import HeartWatcher  # noqa: E402
from tools.detect_clip import frame_times  # noqa: E402

CAUGHT_WITHIN = (-0.3, 1.0)  # a like seen this long before or after the true one counts as it


def detect(clip: Path, config: dict, button: list, zone: list | None, quiet: bool = False) -> tuple[list[dict], float, int]:
    capture = cv2.VideoCapture(str(clip))
    fps = capture.get(cv2.CAP_PROP_FPS) or 30
    times = frame_times(clip)
    detector = Detector(config["detection"])
    detector.lock(zone)
    hearts = HeartWatcher(config["hearts"])
    hearts.set_button(button)
    rotate = config["detection"]["rotate"]
    events, index = [], 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        t = times[index] if times and index < len(times) else index / fps
        for event in detector.process(frame, t):
            if event["type"] == "swipe":
                hearts.reset()
        quad = detector.quad if detector.present else None
        for event in hearts.process(frame, quad, rotate, t, detector._run is None, detector._landed_at):
            event["detected_at"] = t
            events.append(event)
            if not quiet:
                print(f"  {event['t']:7.2f}s  {event['type']:6}  (seen {1000 * (t - event['t']):.0f} ms after it began)")
        index += 1
    capture.release()
    return events, index / fps, index


def score(likes: list[dict], truth_file: Path) -> dict:
    with open(truth_file, encoding="utf-8") as file:
        truth = [float(row["t"]) for row in csv.DictReader(file)]
    found = [event["detected_at"] for event in likes]
    unused = list(found)
    caught, delays = 0, []
    for t in truth:
        match = next((f for f in unused if CAUGHT_WITHIN[0] <= f - t <= CAUGHT_WITHIN[1]), None)
        if match is not None:
            unused.remove(match)
            caught += 1
            delays.append(match - t)
    made_up = len(unused)
    return {
        "caught (recall)": f"{caught}/{len(truth)}" + (f" ({caught / len(truth):.0%})" if truth else ""),
        "right (precision)": f"{caught}/{len(found)}" + (f" ({caught / len(found):.0%})" if found else ""),
        "made up": made_up,
        "seen after, median": f"{1000 * sorted(delays)[len(delays) // 2]:.0f} ms" if delays else "-",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("clip", type=Path)
    parser.add_argument("--button", help="the like button on the upright screen: x,y as fractions")
    parser.add_argument("--zone", help="lock the phone's corners: eight fractions of the picture, x,y for each corner")
    args = parser.parse_args()
    config = settings.load_config()
    if args.button:
        button = [float(v) for v in args.button.split(",")]
    else:
        button = (settings.load_setup() or {}).get("like_button")
        if not button:
            sys.exit("Say where the like button is: --button x,y (or click it on a Detection view first).")
    zone = None
    if args.zone:
        values = [float(v) for v in args.zone.split(",")]
        zone = [values[i:i + 2] for i in range(0, 8, 2)]
    events, duration, frames = detect(args.clip, config, button, zone)
    likes = [event for event in events if event["type"] == "like"]
    print(f"{args.clip.name}: {frames} frames, {duration:.0f} s, {len(likes)} likes, "
          f"{sum(event['type'] == 'unlike' for event in events)} unlikes")
    truth = args.clip.with_suffix(".likes.csv")
    if truth.exists():
        for key, value in score(likes, truth).items():
            print(f"  {key}: {value}")
    print(json.dumps({"button": button}))


if __name__ == "__main__":
    main()
