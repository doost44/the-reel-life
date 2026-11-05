"""Recording test sessions for presenting the project: the detection camera,
the detection view and every swipe, into footage/live-tests/<date and time>/.

The exhibit never records visitors. This is switched on by hand from the
editor for your own test sessions, and switches itself off after 10 minutes.
"""

from __future__ import annotations

import shutil
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from .settings import ROOT

LIVE_TESTS = ROOT / "footage" / "live-tests"
MAX_SECONDS = 600
_NO_CONSOLE = getattr(subprocess, "CREATE_NO_WINDOW", 0)


class FootageRecorder:
    def __init__(self, fps: float) -> None:
        self.folder = LIVE_TESTS / datetime.now().strftime("%Y-%m-%d_%H%M%S")
        self.folder.mkdir(parents=True, exist_ok=True)
        self.started = time.monotonic()
        self._fps = max(1.0, fps)
        self._writers: dict[str, cv2.VideoWriter] = {}
        self._swipes = open(self.folder / "swipes.csv", "w", encoding="utf-8")
        self._swipes.write("seconds,direction,dwell,speed,confidence\n")

    @property
    def seconds(self) -> float:
        return time.monotonic() - self.started

    def add(self, name: str, image: np.ndarray) -> None:
        writer = self._writers.get(name)
        if writer is None:
            height, width = image.shape[:2]
            writer = cv2.VideoWriter(str(self.folder / f"{name}.avi"), cv2.VideoWriter_fourcc(*"MJPG"), self._fps, (width, height))
            writer.set(cv2.VIDEOWRITER_PROP_QUALITY, 90)
            self._writers[name] = writer
        writer.write(image)

    def swipe(self, event: dict) -> None:
        dwell = "" if event["dwell"] is None else f"{event['dwell']:.2f}"
        self._swipes.write(f"{event['t'] - self.started:.2f},{event['direction']},{dwell},{event['speed']},{event['confidence']}\n")

    def close(self) -> None:
        """Finish the files, then turn them into MP4s (playable anywhere) in the background."""
        for writer in self._writers.values():
            writer.release()
        self._swipes.close()
        threading.Thread(target=convert_to_mp4, args=(self.folder,), name="footage to mp4", daemon=True).start()


def convert_to_mp4(folder: Path) -> None:
    """Every .avi in the folder to an H.264 .mp4, which plays in any player
    and slideshow; each .avi is removed once its .mp4 is made."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return  # the .avi files stay; they play in VLC
    for avi in folder.glob("*.avi"):
        done = subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-i", str(avi), "-c:v", "libx264", "-pix_fmt", "yuv420p",
             "-crf", "20", "-movflags", "+faststart", str(avi.with_suffix(".mp4"))],
            creationflags=_NO_CONSOLE,
        )
        if done.returncode == 0:
            avi.unlink()
