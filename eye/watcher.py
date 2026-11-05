"""Runs the swipe detector on the detection camera's frames, on its own
thread, and hands phone and swipe events to the game on the server's loop.

It also makes the detection view: the camera picture with the phone
outline, the straightened screen and live numbers, which pages show like
a camera called "@detection". And it passes frames and swipes on to the reel
sampler (the reel face's stills), which never makes it wait.
"""

from __future__ import annotations

import asyncio
import threading
import traceback
from typing import Callable

import numpy as np

from .cameras import Camera, CameraHub
from .detector import Detector
from .footage import MAX_SECONDS, FootageRecorder
from .reel_sampler import ReelSampler

DETECTION_VIEW = "@detection"


class SwipeWatcher:
    def __init__(self, hub: CameraHub, settings: dict, on_event: Callable[[dict], None],
                 loop: asyncio.AbstractEventLoop, sampler: ReelSampler | None = None) -> None:
        self.hub = hub
        self.sampler = sampler
        self.detector = Detector(settings)
        self.camera_name = ""
        self.frame_size = (0, 0)
        self._on_event = on_event
        self._loop = loop
        self._view: np.ndarray | None = None
        self._view_id = 0
        self._view_lock = threading.Lock()
        self._wanted: tuple[str, list | None] | None = None
        self._record_wanted: bool | None = None
        self.recorder: FootageRecorder | None = None
        self._last_error_at = 0.0
        self._stopping = threading.Event()
        self._thread = threading.Thread(target=self._run, name="swipe watcher", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stopping.set()
        self._thread.join(2)
        if self.recorder:
            self.recorder.close()
            self.recorder = None

    def record(self, on: bool) -> None:
        """Start or stop recording footage (from the server's thread: picked up between frames)."""
        self._record_wanted = on

    def watch(self, camera_name: str, zone: list | None) -> None:
        """Called from the server's thread. The detector is only ever touched on
        the watcher's own thread, so this just leaves a note it picks up
        between frames."""
        self._wanted = (camera_name or "", zone)

    def latest(self) -> tuple[np.ndarray | None, int]:
        """The newest detection view, shaped like Camera.latest() so pages can watch it."""
        with self._view_lock:
            return self._view, self._view_id

    def info(self) -> dict:
        detector = self.detector
        return {
            "camera": self.camera_name,
            "present": detector.present,
            "zone": "locked" if detector.zone is not None else "auto",
            "found": detector.quad is not None,
            "swipes": detector.swipes,
            "last": detector.last_swipe,
            "recording": round(self.recorder.seconds) if self.recorder else None,
            "recording_folder": self.recorder.folder.name if self.recorder else None,
        }

    def _run(self) -> None:
        frame_id = 0
        while not self._stopping.is_set():
            self._apply_wanted()
            camera = self.hub.get(self.camera_name)
            self._apply_recording(camera)
            if camera is None or camera.status != "ok":
                self._stopping.wait(0.2)
                continue
            frame, new_id, arrived = camera.wait_newer(frame_id, timeout=0.5)
            if frame is None or new_id == frame_id:
                continue
            frame_id = new_id
            self.frame_size = (frame.shape[1], frame.shape[0])
            try:
                for event in self.detector.process(frame, arrived):
                    self._loop.call_soon_threadsafe(self._on_event, event)
                    if self.recorder and event["type"] == "swipe":
                        self.recorder.swipe(event)
                    if self.sampler and event["type"] == "swipe":
                        self.sampler.offer_swipe(event)
                if self.sampler and self.detector.present and self.detector.quad is not None:
                    self.sampler.offer_frame(frame, self.detector.quad, arrived)
                # The view only needs to be watchable, not every frame; a recording has every frame.
                if frame_id % 2 == 0 or self.recorder:
                    view = self.detector.debug_frame(frame, arrived)
                    with self._view_lock:
                        self._view = view
                        self._view_id += 1
                    if self.recorder:
                        self.recorder.add("camera", frame)
                        self.recorder.add("detection", view)
            except Exception:
                # One bad frame mustn't stop detection for the rest of the day.
                if arrived - self._last_error_at > 10:
                    self._last_error_at = arrived
                    traceback.print_exc()

    def _apply_recording(self, camera: Camera | None) -> None:
        wanted, self._record_wanted = self._record_wanted, None
        if self.recorder and (wanted is False or self.recorder.seconds > MAX_SECONDS):
            self.recorder.close()
            self.recorder = None
        elif wanted and self.recorder is None:
            self.recorder = FootageRecorder(camera.fps if camera and camera.fps else 30)

    def _apply_wanted(self) -> None:
        wanted, self._wanted = self._wanted, None
        if wanted is None:
            return
        camera_name, zone = wanted
        if camera_name != self.camera_name:
            self.detector = Detector(self.detector.settings)  # a different camera starts from nothing
            self.camera_name = camera_name
        self.detector.lock(zone)
