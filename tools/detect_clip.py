"""Run the swipe detector on a recorded clip and list every swipe it finds.

    python tools/detect_clip.py recordings/2026-11-05_140210.avi
    python tools/detect_clip.py tests/clips/synthetic-seed1.avi        (scored against its .truth.csv)

Frame times come from the clip's .frames.csv when tools/record.py made it,
so dwell times are real seconds. If a .truth.csv sits next to the clip, the
detector is scored: how many real swipes it caught, and how many it made up.
"""

import argparse
import csv
import statistics
import sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from eye import settings  # noqa: E402
from eye.detector import Detector  # noqa: E402


def frame_times(clip: Path) -> list[float] | None:
    times_file = clip.with_suffix(".frames.csv")
    if not times_file.exists():
        return None
    rows = [line for line in times_file.read_text(encoding="utf-8").splitlines() if line and line[0].isdigit()]
    return [float(line.split(",")[1]) for line in rows]


def detect(clip: Path, detection_settings: dict, quiet: bool = False) -> tuple[list[dict], float]:
    capture = cv2.VideoCapture(str(clip))
    fps = capture.get(cv2.CAP_PROP_FPS) or 30
    times = frame_times(clip)
    detector = Detector(detection_settings)
    swipes, index = [], 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        t = times[index] if times and index < len(times) else index / fps
        for event in detector.process(frame, t):
            if event["type"] == "swipe":
                swipes.append(event)
                if not quiet:
                    dwell = f"{event['dwell']:5.2f}s" if event["dwell"] is not None else "    -"
                    print(f"  {event['t']:7.2f}s  {event['direction']:4}  after {dwell}  "
                          f"{event['speed']:4.1f} screens/s  confidence {event['confidence']:.2f}  "
                          f"(reported {1000 * (event['detected_at'] - event['t']):.0f} ms in)")
            elif not quiet:
                print(f"  {event['t']:7.2f}s  phone {'placed' if event['present'] else 'removed'}")
        index += 1
    capture.release()
    return swipes, index / fps


def score(swipes: list[dict], truth_file: Path, duration: float) -> dict:
    with open(truth_file, encoding="utf-8") as file:
        truth = [{**row, "start": float(row["start"]), "end": float(row["end"]), "dwell_before": float(row["dwell_before"])}
                 for row in csv.DictReader(file)]
    real = [swipe for swipe in truth if swipe["kind"] != "partial"]
    unmatched = list(swipes)
    caught, dwell_errors, delays = 0, [], []
    for true_swipe in real:
        match = next((s for s in unmatched if true_swipe["start"] - 0.15 <= s["t"] <= true_swipe["end"] + 0.15), None)
        if match is None:
            print(f"  MISSED  {true_swipe['kind']} at {true_swipe['start']:.2f}s")
            continue
        unmatched.remove(match)
        caught += 1
        delays.append(match["detected_at"] - true_swipe["start"])
        if match["dwell"] is not None:
            dwell_errors.append(abs(match["dwell"] - true_swipe["dwell_before"]))
    for extra in unmatched:
        partial = any(s["kind"] == "partial" and s["start"] - 0.15 <= extra["t"] <= s["end"] + 0.15 for s in truth)
        print(f"  EXTRA   {extra['direction']} at {extra['t']:.2f}s{' (a half-swipe)' if partial else ''}")
    return {
        "caught": f"{caught}/{len(real)} ({100 * caught / max(1, len(real)):.0f}%)",
        "made_up": f"{len(unmatched)} ({len(unmatched) / (duration / 60):.2f} per minute)",
        "dwell_error_median": f"{statistics.median(dwell_errors):.2f}s" if dwell_errors else "-",
        "reported_after_median": f"{1000 * statistics.median(delays):.0f} ms" if delays else "-",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the swipe detector on a clip.")
    parser.add_argument("clip", type=Path)
    parser.add_argument("--truth", type=Path, help="true swipe times (default: the clip's .truth.csv if there is one)")
    parser.add_argument("--quiet", action="store_true", help="only print the score")
    args = parser.parse_args()

    detection_settings = settings.load_config()["detection"]
    print(f"{args.clip.name}:")
    swipes, duration = detect(args.clip, detection_settings, args.quiet)
    print(f"{len(swipes)} swipes in {duration:.0f} s")
    truth = args.truth or args.clip.with_suffix(".truth.csv")
    if truth.exists():
        for key, value in score(swipes, truth, duration).items():
            print(f"  {key.replace('_', ' ')}: {value}")


if __name__ == "__main__":
    main()
