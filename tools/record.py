"""Record calibration clips from the camcorder.

    python tools/record.py                 preview window: R starts and stops a clip, Q quits
    python tools/record.py --seconds 300   record one 5-minute clip straight away, then quit

Each clip goes in recordings/ as an .avi, plus a .frames.csv with the time of
every frame, so swipe timings stay exact even if the capture drops frames.

Stop the eye first: only one program can use the capture card at a time.
At the start of each clip, flash your phone screen white (or clap in front
of the lens) so the clip can be lined up with your phone's screen recording.

This is the only part of the project that saves video. The exhibit never does.
"""

import argparse
import sys
import time
from datetime import datetime
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from eye import cameras, settings  # noqa: E402

RECORDINGS = settings.ROOT / "recordings"
WINDOW = "Reel Life recorder (R = record/stop, Q = quit)"


class Clip:
    def __init__(self, camera: str, size: tuple[int, int], fps: float) -> None:
        RECORDINGS.mkdir(exist_ok=True)
        stem = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        self.path = RECORDINGS / f"{stem}.avi"
        self.writer = cv2.VideoWriter(str(self.path), cv2.VideoWriter_fourcc(*"MJPG"), fps, size)
        self.writer.set(cv2.VIDEOWRITER_PROP_QUALITY, 95)
        self.times = open(RECORDINGS / f"{stem}.frames.csv", "w", encoding="utf-8")
        self.times.write(f"# camera: {camera}\nframe,seconds\n")
        self.started = time.monotonic()
        self.frames = 0
        print(f"Recording {self.path.name}")

    def add(self, frame) -> None:
        self.writer.write(frame)
        self.times.write(f"{self.frames},{time.monotonic() - self.started:.4f}\n")
        self.frames += 1

    def elapsed(self) -> float:
        return time.monotonic() - self.started

    def close(self) -> None:
        self.writer.release()
        self.times.close()
        print(f"Saved {self.path.name}: {self.frames} frames, {self.elapsed():.1f} s")


def main() -> None:
    setup = settings.load_setup() or {}
    parser = argparse.ArgumentParser(description="Record calibration clips from the camcorder.")
    parser.add_argument("--camera", default=setup.get("detection_camera") or settings.load_config()["cameras"]["default_device"],
                        help="camera name (default: the detection camera from the editor)")
    parser.add_argument("--seconds", type=float, help="record one clip this long straight away, then quit")
    parser.add_argument("--no-preview", action="store_true", help="no preview window (needs --seconds)")
    args = parser.parse_args()
    if args.no_preview and not args.seconds:
        parser.error("--no-preview needs --seconds")

    devices = cameras.list_cameras()
    if args.camera not in devices:
        sys.exit(f"Camera {args.camera!r} isn't connected. Connected: {', '.join(devices) or 'none'}")
    mode = {**settings.DEFAULT_MODE, **setup.get("cameras", {}).get(args.camera, {})}
    capture = cameras.open_capture(devices.index(args.camera), mode)
    ok, frame = capture.read() if capture.isOpened() else (False, None)
    if not ok:
        sys.exit(f"Couldn't read from {args.camera!r}. Is the eye (or OBS) using it? Stop it and try again.")
    size = (frame.shape[1], frame.shape[0])
    print(f"{args.camera}: {size[0]}x{size[1]} at {mode['fps']} fps")

    clip = Clip(args.camera, size, mode["fps"]) if args.seconds else None
    failures = 0
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                failures += 1
                if failures > 100:
                    print("The camera stopped sending frames.")
                    break
                time.sleep(0.02)
                continue
            failures = 0
            if clip:
                clip.add(frame)
                if args.seconds and clip.elapsed() >= args.seconds:
                    break
            if args.no_preview:
                continue
            preview = frame.copy()
            if clip:
                cv2.circle(preview, (24, 24), 10, (0, 0, 255), -1)
                cv2.putText(preview, f"REC {clip.elapsed():.0f}s", (42, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
            cv2.imshow(WINDOW, preview)
            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
            if key == ord("r"):
                if clip:
                    clip.close()
                    clip = None
                else:
                    clip = Clip(args.camera, size, mode["fps"])
    finally:
        if clip:
            clip.close()
        capture.release()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
