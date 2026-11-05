"""Run the swipe detector of both eyes on the same clip, side by side: the
Python one (eye/detector.py) and the Chrome version's copy
(web/js/eye/detector.js, in Node). They should see the same swipes; run this
after changing either.

    python tools/check_browser_eye.py tests/clips/synthetic-seed1.avi [--zone x,y,x,y,x,y,x,y]

Needs Node.js (18 or newer) on PATH. Scores both against the clip's
.truth.csv, if it has one (tools/make_test_clip.py makes clips with one).
"""

import argparse
import json
import shutil
import struct
import subprocess
import sys
import threading
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from eye import settings  # noqa: E402
from eye.detector import Detector  # noqa: E402
from tools.detect_clip import frame_times, score  # noqa: E402

NODE_SIDE = Path(__file__).with_name("browser_eye_detect.mjs")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("clip", type=Path)
    parser.add_argument("--zone", help="lock the phone's corners: eight fractions of the picture, x,y for each corner")
    args = parser.parse_args()
    node = shutil.which("node")
    if not node:
        sys.exit("Node.js isn't on PATH.")
    zone = None
    if args.zone:
        values = [float(v) for v in args.zone.split(",")]
        zone = [values[i:i + 2] for i in range(0, 8, 2)]

    detection = settings.load_config()["detection"]
    capture = cv2.VideoCapture(str(args.clip))
    fps = capture.get(cv2.CAP_PROP_FPS) or 30
    width, height = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    times = frame_times(args.clip)

    browser = subprocess.Popen([node, str(NODE_SIDE)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=False)
    browser_events: list[dict] = []
    reader = threading.Thread(target=lambda: browser_events.extend(json.loads(line) for line in browser.stdout), daemon=True)
    reader.start()
    browser.stdin.write((json.dumps({"width": width, "height": height, "detection": detection, "zone": zone}) + "\n").encode())

    detector = Detector(detection)
    detector.lock(zone)
    python_events, index = [], 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        t = times[index] if times and index < len(times) else index / fps
        python_events += detector.process(frame, t)
        browser.stdin.write(struct.pack("<d", t) + frame.tobytes())
        index += 1
    capture.release()
    browser.stdin.close()
    browser.wait()
    reader.join()
    duration = index / fps

    done = next((event for event in browser_events if event["type"] == "done"), {})
    print(f"{args.clip.name}: {index} frames, {duration:.0f} s; the Chrome version took {done.get('ms_per_frame', 0):.1f} ms a frame")
    for name, events in (("python", python_events), ("chrome", browser_events)):
        phone = [f"{e['t']:.2f}s {'in' if e['present'] else 'out'}" for e in events if e["type"] == "phone"]
        print(f"\n{name}: phone {', '.join(phone) or '-'}")
        swipes = [e for e in events if e["type"] == "swipe"]
        for swipe in swipes:
            print(f"  {swipe['t']:7.2f}s  {swipe['direction']:4}  {swipe['speed']:4.1f} screens/s  confidence {swipe['confidence']:.2f}")
        truth = args.clip.with_suffix(".truth.csv")
        if truth.exists():
            for key, value in score(swipes, truth, duration).items():
                print(f"  {key.replace('_', ' ')}: {value}")

    python_swipes = [(round(e["t"], 2), e["direction"]) for e in python_events if e["type"] == "swipe"]
    chrome_swipes = [(round(e["t"], 2), e["direction"]) for e in browser_events if e["type"] == "swipe"]
    same = python_swipes == chrome_swipes
    print("\nThe same swipes at the same times." if same else "\nThey differ: see above.")
    sys.exit(0 if same else 1)


if __name__ == "__main__":
    main()
