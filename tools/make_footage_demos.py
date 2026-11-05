"""Make demonstration footage for presenting the project, from the synthetic
test clips (no real people in them), into footage/demos/:

- tracking-handheld.mp4: the detection view following a phone held in a
  hand (moving, turning, tilting) while it scrolls, with SWIPE markers
- tracking-still.mp4: the same for a phone lying still
- screen-finder-angles.jpg: phones at random angles and on different
  backgrounds, with the outline the finder drew on each

    python tools/make_footage_demos.py [--seconds 60]

Needs the synthetic clips first: tools/make_test_clip.py --seed 1, and
--seed 11 --handheld.
"""

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from eye import settings  # noqa: E402
from eye.detector import Detector, find_screen  # noqa: E402
from eye.footage import convert_to_mp4  # noqa: E402
import test_screen_finder  # noqa: E402

DEMOS = settings.ROOT / "footage" / "demos"
CLIPS = settings.ROOT / "tests" / "clips"


def tracking_video(clip: Path, name: str, seconds: float, detection: dict) -> None:
    capture = cv2.VideoCapture(str(clip))
    fps = capture.get(cv2.CAP_PROP_FPS) or 30
    detector = Detector(detection)
    writer = None
    for index in range(int(seconds * fps)):
        ok, frame = capture.read()
        if not ok:
            break
        t = index / fps
        detector.process(frame, t)
        view = detector.debug_frame(frame, t)
        if writer is None:
            writer = cv2.VideoWriter(str(DEMOS / f"{name}.avi"), cv2.VideoWriter_fourcc(*"MJPG"), fps, view.shape[1::-1])
            writer.set(cv2.VIDEOWRITER_PROP_QUALITY, 92)
        writer.write(view)
    capture.release()
    if writer:
        writer.release()
    print(f"{name}: {detector.swipes} swipes in {seconds:.0f} s")


def finder_sheet(detection: dict, count: int = 12) -> None:
    rng = np.random.default_rng(21)
    tiles = []
    for index in range(count):
        kind = test_screen_finder.BACKGROUNDS[index % 4]
        image, truth, info = test_screen_finder.scene(rng, kind)
        found = find_screen(image, detection)
        ok = found is not None and test_screen_finder.overlap(found, truth) >= 0.85
        if found is not None:
            cv2.polylines(image, [found.astype(np.int32)], True, (80, 255, 80) if ok else (0, 0, 255), 3)
        label = f"{kind}, turned {info['roll']:.0f} deg, tilted {info['tilt']:.0f} deg"
        width = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.8, 2)[0][0]
        panel = image[4:40, 4:20 + width]
        panel[:] = panel * 0.3  # a dark panel behind the label, so it reads on any background
        cv2.putText(image, label, (12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2, cv2.LINE_AA)
        tiles.append(cv2.resize(image, (480, 320)))
    sheet = np.vstack([np.hstack(tiles[row:row + 4]) for row in range(0, count, 4)])
    cv2.imwrite(str(DEMOS / "screen-finder-angles.jpg"), sheet, [cv2.IMWRITE_JPEG_QUALITY, 92])
    print("screen-finder-angles.jpg: green = found, red = found wrongly, none = not found")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seconds", type=float, default=60)
    args = parser.parse_args()
    DEMOS.mkdir(parents=True, exist_ok=True)
    detection = settings.load_config()["detection"]
    for clip, name in [(CLIPS / "synthetic-handheld-seed11.avi", "tracking-handheld"), (CLIPS / "synthetic-seed1.avi", "tracking-still")]:
        if clip.exists():
            tracking_video(clip, name, args.seconds, detection)
        else:
            print(f"{clip.name} isn't there yet: see the top of this file")
    finder_sheet(detection)
    convert_to_mp4(DEMOS)
    print(f"Saved in {DEMOS}")


if __name__ == "__main__":
    main()
