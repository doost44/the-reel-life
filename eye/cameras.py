"""Capture devices and recorded clips: open them by name, read each on its
own thread, keep the newest frame.

A recorded clip works like a camera named "clip: <path>": it plays on a
loop at its own speed, so the detector and the game can be tried and tuned
without a phone under the camcorder.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

import cv2
import numpy as np

from .settings import ROOT

CLIP_PREFIX = "clip: "
CLIP_FOLDERS = [ROOT / "recordings", ROOT / "tests" / "clips"]
_NO_CONSOLE = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def list_cameras() -> list[str]:
    """Names of the video capture devices, in the order OpenCV numbers them.

    OpenCV opens cameras by number and can't tell us their names; ffmpeg can.
    Both ask DirectShow for the same list, so the positions match.
    """
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return []
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        creationflags=_NO_CONSOLE, timeout=15,
    )
    return re.findall(r'"([^"]+)" \(video\)', result.stderr)


def list_clips() -> list[str]:
    """Recorded clips that can stand in for a camera."""
    return [f"{CLIP_PREFIX}{path.relative_to(ROOT).as_posix()}"
            for folder in CLIP_FOLDERS if folder.exists()
            for path in sorted(folder.glob("*.avi"))]


def list_sources() -> list[str]:
    return list_cameras() + list_clips()


def open_capture(index: int, mode: dict) -> cv2.VideoCapture:
    capture = cv2.VideoCapture(index, cv2.CAP_DSHOW)
    capture.set(cv2.CAP_PROP_FRAME_WIDTH, mode["width"])
    capture.set(cv2.CAP_PROP_FRAME_HEIGHT, mode["height"])
    capture.set(cv2.CAP_PROP_FPS, mode["fps"])
    # Exposure: None leaves it automatic. A number fixes it, in DirectShow's
    # steps: -5 is 1/32 s, -7 is 1/128 s. Shorter keeps a bright phone screen
    # from washing out, blurs swipes less, and lets a webcam keep its full
    # frame rate in a dim room. Not every camera honours it.
    if mode.get("exposure") is None:
        capture.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.75)
    else:
        capture.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25)
        capture.set(cv2.CAP_PROP_EXPOSURE, mode["exposure"])
    return capture


class Camera:
    """One capture device or clip, read on its own thread. Reconnects by
    itself when the device is missing, busy or drops out.

    status is one of: starting, ok, no_signal, missing, busy, lost, stopped.
    """

    def __init__(self, name: str, mode: dict, settings: dict) -> None:
        self.name = name
        self.mode = dict(mode)
        self.status = "starting"
        self.fps = 0.0
        self.size = (0, 0)
        self._flatness = settings["no_signal_flatness"]
        self._retry_seconds = settings["reconnect_seconds"]
        self._new_frame = threading.Condition()
        self._frame: np.ndarray | None = None
        self._frame_time = 0.0
        self._frame_id = 0
        self._stopping = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"camera: {name}", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self, wait: float = 0) -> None:
        self._stopping.set()
        if wait:
            self._thread.join(wait)

    def latest(self) -> tuple[np.ndarray | None, int]:
        """The newest frame and its number. Frames are replaced, never changed, so it's safe to keep."""
        with self._new_frame:
            return self._frame, self._frame_id

    def wait_newer(self, frame_id: int, timeout: float) -> tuple[np.ndarray | None, int, float]:
        """Wait for a frame newer than frame_id. Returns it, its number and when it arrived."""
        with self._new_frame:
            self._new_frame.wait_for(lambda: self._frame_id != frame_id, timeout)
            return self._frame, self._frame_id, self._frame_time

    def info(self) -> dict:
        return {"status": self.status, "fps": round(self.fps, 1), "width": self.size[0], "height": self.size[1]}

    def _run(self) -> None:
        while not self._stopping.is_set():
            if self.name.startswith(CLIP_PREFIX):
                self._play_clip(ROOT / self.name[len(CLIP_PREFIX):])
            else:
                self._read_device()
            self._stopping.wait(self._retry_seconds)
        self.status = "stopped"

    def _read_device(self) -> None:
        devices = list_cameras()
        if self.name not in devices:
            self.status = "missing"
            return
        capture = open_capture(devices.index(self.name), self.mode)
        if capture.isOpened():
            self._read_until_lost(capture)
            self.status = "lost"
        else:
            self.status = "busy"
        capture.release()

    def _play_clip(self, path: Path) -> None:
        capture = cv2.VideoCapture(str(path))
        if not capture.isOpened():
            self.status = "missing"
            return
        frame_seconds = 1 / (capture.get(cv2.CAP_PROP_FPS) or 30)
        self.status = "ok"
        self.fps = 1 / frame_seconds
        next_frame = time.monotonic()
        while not self._stopping.is_set():
            ok, frame = capture.read()
            if not ok:
                capture.set(cv2.CAP_PROP_POS_FRAMES, 0)  # loop
                continue
            next_frame += frame_seconds
            time.sleep(max(0.0, next_frame - time.monotonic()))
            self.size = (frame.shape[1], frame.shape[0])
            self._publish(frame)
        capture.release()

    def _read_until_lost(self, capture: cv2.VideoCapture) -> None:
        failures = 0
        counted = 0
        window_start = time.monotonic()
        while not self._stopping.is_set():
            ok, frame = capture.read()
            if not ok:
                failures += 1
                if failures >= 30:
                    return
                time.sleep(0.02)
                continue
            failures = 0
            self._publish(frame)
            counted += 1
            now = time.monotonic()
            if now - window_start >= 1:
                self.fps = counted / (now - window_start)
                self.size = (frame.shape[1], frame.shape[0])
                self.status = "no_signal" if self._looks_like_no_signal(frame) else "ok"
                counted = 0
                window_start = now

    def _publish(self, frame: np.ndarray) -> None:
        with self._new_frame:
            self._frame = frame
            self._frame_time = time.monotonic()
            self._frame_id += 1
            self._new_frame.notify_all()

    def _looks_like_no_signal(self, frame: np.ndarray) -> bool:
        # The capture card keeps sending frames with nothing plugged in: black,
        # or the converter's blue screen. A dark mat with nothing on it is
        # still noisy enough to pass.
        small = cv2.resize(frame, (80, 60), interpolation=cv2.INTER_AREA).reshape(-1, 3).astype(np.float32)
        blue, green, red = small.mean(axis=0)
        flat = small.std(axis=0).max() < self._flatness
        black = max(blue, green, red) < 12
        converter_blue = blue > 120 and green < 60 and red < 60
        return flat and (black or converter_blue)


class CameraHub:
    """Keeps exactly the cameras the setup uses open, each at its chosen mode."""

    def __init__(self, settings: dict) -> None:
        self._settings = settings
        self._cameras: dict[str, Camera] = {}

    def sync(self, wanted: dict[str, dict]) -> None:
        for name, camera in list(self._cameras.items()):
            if wanted.get(name) != camera.mode:
                del self._cameras[name]
                camera.stop()
        for name, mode in wanted.items():
            if name not in self._cameras:
                camera = Camera(name, mode, self._settings)
                self._cameras[name] = camera
                camera.start()

    def get(self, name: str) -> Camera | None:
        return self._cameras.get(name)

    def info(self) -> dict[str, dict]:
        return {name: camera.info() for name, camera in self._cameras.items()}

    def stop_all(self) -> None:
        for camera in self._cameras.values():
            camera.stop()
        for camera in self._cameras.values():
            camera.stop(wait=3)
        self._cameras.clear()
