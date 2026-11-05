"""The eye's web server.

Serves the setup editor (/editor), the look editor (/look) and each screen
(/screen.html?id=<id>) to this computer only, streams
camera pictures to them over one WebSocket per page, saves what the editor
sends to setup.json, and opens screens fullscreen on their monitors.

It also runs the swipe detector on the phone camera, the journey (the visit,
from "I see you." to the face forming) and the reel face's formation, and
keeps every page up to date.

Messages, as JSON:
  to pages:   hello (with look_settings, for the look editor), setup, devices, status, notice,
              journey (where the visit is, often), oracle {text} (a new line, as it's said),
              reel_face (how far the face has formed, and its desire),
              tile (one tile of the face, as it's released),
              word {text, desire, clip, muted} (the face speaking, as it starts), swipe (each one detected)
  from pages: watch {cameras}, setup {setup}, refresh_devices,
              open_screen {id}, close_screen {id}, lock_zone, unlock_zone,
              set_zone {zone: four [x, y] corners as fractions of the picture},
              record {on: true/false} (footage of a test session, into footage/live-tests),
              face_seen {present} (a reel face page sees a face, or not),
              place_phone {present: true/null} (the operator: phone placed, or back to the tracker),
              reset (the operator: everything wiped, back to stage 0),
              reelface_reset (the face back to nothing, the visit goes on),
              reelface_scrub {reels or null}, reelface_test_reels {count},
              reelface_intensity {value 0-1, or null to follow the session},
              speech_pause {paused}, speech_mute {muted}
Camera pictures go to pages as binary: one byte for the camera's name's
length, the name, then a JPEG. The detection view is sent the same way, as
"@detection", and the face camera as "@face". Nothing from the face camera
is ever kept.
"""

from __future__ import annotations

import asyncio
import json
import mimetypes
import os
import re
import secrets
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib.parse import quote, urlencode

import cv2
import numpy as np
import segno
from aiohttp import WSMsgType, web

from . import cameras, look, monitors, settings
from .journey import Journey
from .reel_face import PlanJob, ReelFace
from .reel_sampler import ReelRecord, ReelSampler
from .watcher import DETECTION_VIEW, SwipeWatcher

UPDATES_PER_SECOND = 10
FACE_VIEW = "@face"
FACE_REPORT_SECONDS = 2  # a page's "I see a face" holds this long without another
MOVEMENT_REPORT_SECONDS = 3  # ...and its "I see movement"
HOTSPOT_ADDRESS = "192.168.137.1"  # this computer, when it runs Windows' mobile hotspot
STILL_MOST_BYTES = 8 * 1024 * 1024

WEB = settings.ROOT / "web"
_APP_DATA = (Path.home() / "Library" / "Application Support" if sys.platform == "darwin"
             else Path(os.environ.get("LOCALAPPDATA", Path.home())))
BROWSER_PROFILES = _APP_DATA / "TheReelLife" / "browser-profiles"


def _valid_zone(zone: object) -> list | None:
    """Four [x, y] corners, each a fraction of the picture, or None."""
    try:
        corners = [[float(x), float(y)] for x, y in zone]
    except (TypeError, ValueError):
        return None
    if len(corners) != 4 or not all(0 <= v <= 1 for corner in corners for v in corner):
        return None
    return [[round(x, 4), round(y, 4)] for x, y in corners]


def encode_preview(name: str, frame: np.ndarray, max_width: int, quality: int) -> bytes:
    height, width = frame.shape[:2]
    if width > max_width:
        frame = cv2.resize(frame, (max_width, round(height * max_width / width)), interpolation=cv2.INTER_AREA)
    _, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    label = name.encode("utf-8")[:255]
    return bytes([len(label)]) + label + jpeg.tobytes()


class Client:
    """One open page. Everything sent to it goes out through writer(), one
    message at a time. Only the newest frame per camera is kept, so a slow
    page skips frames instead of falling behind."""

    def __init__(self, ws: web.WebSocketResponse) -> None:
        self.ws = ws
        self.watching: set[str] = set()
        self.face_seen_at = -1e9  # when this page last said it sees a face
        self.movement_seen_at = -1e9  # ...or movement
        self._messages: list[str] = []
        self._frames: dict[str, bytes] = {}
        self._wake = asyncio.Event()

    def send_json(self, message: dict) -> None:
        self._messages.append(json.dumps(message))
        self._wake.set()

    def send_frame(self, camera: str, data: bytes) -> None:
        self._frames[camera] = data
        self._wake.set()

    async def writer(self) -> None:
        try:
            while not self.ws.closed:
                await self._wake.wait()
                self._wake.clear()
                messages, self._messages = self._messages, []
                frames, self._frames = self._frames, {}
                for text in messages:
                    await self.ws.send_str(text)
                for data in frames.values():
                    await self.ws.send_bytes(data)
        except (ConnectionResetError, RuntimeError):
            pass


class Eye:
    def __init__(self, config: dict, port: int) -> None:
        self.config = config
        self.port = port
        self.camera_settings = config["cameras"]
        self.devices = cameras.list_sources()
        self.monitors = monitors.list_monitors()
        self.setup = settings.load_setup() or settings.default_setup(self.devices, self.camera_settings["default_device"])
        self.hub = cameras.CameraHub(self.camera_settings)
        self.journey = Journey(config["journey"], self._broadcast)
        self.reel_face = ReelFace(config["reel_face"])
        self._visit_seen = self.journey.visits
        self._stage_seen = self.journey.stage
        self.sampler: ReelSampler | None = None
        self.watcher: SwipeWatcher | None = None
        self.clients: set[Client] = set()
        self.windows: dict[str, subprocess.Popen] = {}
        self._pending_save: asyncio.TimerHandle | None = None
        self._tasks: list[asyncio.Task] = []
        self.still: dict | None = None  # this visit's still, in memory only: token, jpeg, url, qr, expires
        self._still_site: web.AppRunner | None = None

    # Lifecycle

    async def start(self, app: web.Application) -> None:
        self._sync_cameras()
        loop = asyncio.get_running_loop()
        self.sampler = ReelSampler(self.config["reel_face"], self.config["detection"]["rotate"],
                                   lambda reel: loop.call_soon_threadsafe(self._on_reel, reel))
        self.sampler.start()
        self.watcher = SwipeWatcher(self.hub, self.config["detection"], self._on_detection, loop, self.sampler)
        self._watch_detection_camera()
        self.watcher.start()
        self._tasks = [asyncio.create_task(self._pump_frames()), asyncio.create_task(self._pump_status()),
                       asyncio.create_task(self._pump_journey())]
        await self._open_still_site()
        if app["open_screens"]:
            for screen in self.setup["screens"]:
                if screen.get("monitor"):
                    self._report(self.open_screen(screen["id"]))
        if app["open_editor"]:
            webbrowser.open(f"http://localhost:{self.port}/editor")

    async def stop(self, _app: web.Application) -> None:
        for task in self._tasks:
            task.cancel()
        if self._still_site:
            await self._still_site.cleanup()
        if self._pending_save:
            self._pending_save.cancel()
            settings.save_setup(self.setup)
        for screen_id in list(self.windows):
            self.close_screen(screen_id)
        if self.watcher:
            await asyncio.to_thread(self.watcher.stop)
        if self.sampler:
            await asyncio.to_thread(self.sampler.stop)
        await asyncio.to_thread(self.hub.stop_all)

    # Pages

    async def websocket(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=10, max_msg_size=8 * 1024 * 1024)
        await ws.prepare(request)
        client = Client(ws)
        self.clients.add(client)
        writer = asyncio.create_task(client.writer())
        client.send_json({"type": "hello", "setup": self.setup, "devices": self.devices,
                          "monitors": self.monitors, "status": self._status(),
                          "journey": self.journey.snapshot(time.monotonic()), "reel_face": self.reel_face.message(),
                          "still": self._still_message(),
                          "look_settings": look.described()})
        for tile in self.reel_face.shown_tiles():
            client.send_json(ReelFace.tile_message(tile, animate=False))  # the face so far, at once
        try:
            async for message in ws:
                if message.type == WSMsgType.TEXT:
                    await self._handle(client, json.loads(message.data))
        finally:
            self.clients.discard(client)
            writer.cancel()
        return ws

    async def _handle(self, client: Client, message: dict) -> None:
        kind = message.get("type")
        t = time.monotonic()
        if kind == "watch":
            client.watching = set(message.get("cameras") or [])
        elif kind == "setup":
            setup = message.get("setup")
            if not settings.is_valid(setup):
                client.send_json({"type": "notice", "text": "The eye ignored a setup it couldn't read."})
                return
            setup["look"] = look.complete(setup.get("look") or self.setup.get("look"))
            self.setup = setup
            self._sync_cameras()
            self._watch_detection_camera()
            self._save_soon()
            self._broadcast({"type": "setup", "setup": setup}, skip=client)
        elif kind == "refresh_devices":
            self.devices = await asyncio.to_thread(cameras.list_sources)
            self.monitors = await asyncio.to_thread(monitors.list_monitors)
            self._broadcast({"type": "devices", "devices": self.devices, "monitors": self.monitors})
        elif kind in ("lock_zone", "unlock_zone", "set_zone"):
            if kind == "lock_zone":
                zone = self.watcher.detector.zone_from_quad(self.watcher.frame_size)
            elif kind == "set_zone":
                zone = _valid_zone(message.get("zone"))
            else:
                zone = None
            if kind != "unlock_zone" and zone is None:
                problem = ("No phone outline to lock yet. Put the phone under the camera first." if kind == "lock_zone"
                           else "The eye couldn't use those corners. Click four on the detection view.")
                client.send_json({"type": "notice", "text": problem})
                return
            self.setup["detection_zone"] = zone
            self._watch_detection_camera()
            self._save_soon()
            self._broadcast({"type": "setup", "setup": self.setup})
        elif kind == "record":
            self.watcher.record(bool(message.get("on")))
        elif kind == "face_seen":
            client.face_seen_at = t if message.get("present") else -1e9
            client.movement_seen_at = t if message.get("moving") else client.movement_seen_at
        elif kind == "place_phone":
            self.journey.override_phone(True if message.get("present") else None, t)
            self._broadcast(self._status())
        elif kind == "reset":
            self.journey.reset(t)
        elif kind == "reelface_intensity":
            value = message.get("value")
            self.reel_face.set_intensity(value if isinstance(value, (int, float)) else None)
            self._broadcast(self.reel_face.message())
        elif kind == "reelface_scrub":
            reels = message.get("reels")
            self.reel_face.scrub(reels if isinstance(reels, int) else None)
            self._broadcast(self.reel_face.message())
        elif kind == "reelface_reset":
            self.reel_face.reset_copy()
            self._broadcast(self.reel_face.message())
        elif kind in ("speech_pause", "speech_mute"):
            if kind == "speech_pause":
                self.reel_face.speech_paused = bool(message.get("paused"))
            else:
                self.reel_face.muted = bool(message.get("muted"))
            self._broadcast(self.reel_face.message())
        elif kind == "reelface_test_reels":
            self.journey.begin_watching(t)
            if not (self.journey.stage == "forming" and self.reel_face.add_test_reels(int(message.get("count", 1)), t)):
                client.send_json({"type": "notice", "text": "Test reels count once the oracle has asked to watch some: wait for it to ask for the phone, then press Phone placed."})
            self._broadcast(self.reel_face.message())
        elif kind == "climax_now":
            if self.journey.stage == "forming" and self.reel_face.shown:
                self._begin_climax(t)
            else:
                client.send_json({"type": "notice", "text": "The climax needs a face to break: add reels first."})
        elif kind == "open_screen":
            problem = self.open_screen(message.get("id", ""))
            if problem:
                client.send_json({"type": "notice", "text": problem})
            self._broadcast(self._status())
        elif kind == "close_screen":
            self.close_screen(message.get("id", ""))
            self._broadcast(self._status())

    def _broadcast(self, message: dict, skip: Client | None = None) -> None:
        for client in self.clients:
            if client is not skip:
                client.send_json(message)

    def _status(self) -> dict:
        open_screens = [screen_id for screen_id, window in self.windows.items() if window.poll() is None]
        return {"type": "status", "cameras": self.hub.info(), "open_screens": open_screens,
                "detection": self.watcher.info() if self.watcher else None,
                "phone_override": self.journey.phone_override}

    # The cameras

    def _face_feed(self) -> tuple[str, str]:
        """The face camera, which the reel face tracks live: the one chosen, or
        with none, the test clip, which the screen labels as test tracking.
        Returns its name and what it is: camera, test or none."""
        chosen = self.setup.get("face_camera") or ""
        if chosen:
            return chosen, "test" if chosen.startswith(cameras.CLIP_PREFIX) else "camera"
        clip = self.config["reel_face"].get("test_face_clip") or ""
        if clip and (settings.ROOT / clip).exists():
            return cameras.CLIP_PREFIX + clip, "test"
        return "", "none"

    def _sync_cameras(self) -> None:
        """Open the cameras the setup uses, the face camera among them: it
        streams all the time, for the reel face to see whoever comes."""
        face, kind = self._face_feed()
        self.reel_face.face_feed = kind
        self.reel_face.look = look.complete(self.setup.get("look"))
        self.hub.sync(settings.camera_modes(self.setup, face))

    def _frames_for(self, name: str):
        """Where a page's frames come from. The face camera's pictures only go
        to pages on this computer, live, and are never kept."""
        if name == DETECTION_VIEW:
            return self.watcher
        if name == FACE_VIEW:
            face, _ = self._face_feed()
            return self.hub.get(face) if face else None
        return self.hub.get(name)

    def _watch_detection_camera(self) -> None:
        if self.watcher:
            self.watcher.watch(self.setup.get("detection_camera", ""), self.setup.get("detection_zone"))

    # The visit

    def _on_detection(self, event: dict) -> None:
        if event["type"] == "phone":
            self.journey.on_phone(event["present"], event["t"])
        elif event["type"] == "swipe":
            self._broadcast(event)  # every detected swipe, for testing and tuning

    def _on_reel(self, reel: ReelRecord) -> None:
        """A reel was watched long enough (from the sampler's thread, via the loop).
        It counts only once the phone is on the platform."""
        self.journey.begin_watching(time.monotonic())  # the oracle asked, and here's the first
        if self.journey.counting and self.reel_face.add_reel(reel):
            self._broadcast(self.reel_face.message())

    def _follow_visit(self, t: float) -> None:
        """Wipes the reel face when a visit starts or ends (visits are counted,
        so one that ends and another that starts between two ticks still can't
        carry anything over), and starts counting reels at the threshold."""
        changed = False
        if self.journey.visits != self._visit_seen:
            self._visit_seen = self.journey.visits
            self.reel_face.begin()
            changed = True
        elif self.journey.stage in ("empty", "ended") and self.reel_face.on:
            self.reel_face.end()
            changed = True
        if self.journey.stage != self._stage_seen:
            if self.journey.stage == "asking":
                self.sampler.reset()  # reels watched before the phone went down don't count
            self._stage_seen = self.journey.stage
        if changed:
            self.sampler.reset()
            self._broadcast(self.reel_face.message())

    def _begin_climax(self, t: float) -> None:
        self.journey.begin_climax(t)
        self._broadcast({"type": "scream", "clip": self.reel_face.clip_for("scream")})

    def _save_soon(self) -> None:
        # The editor sends changes many times a second while dragging; write the file once it settles.
        if self._pending_save:
            self._pending_save.cancel()
        self._pending_save = asyncio.get_running_loop().call_later(0.5, settings.save_setup, self.setup)

    def _report(self, problem: str | None) -> None:
        if problem:
            print(problem)

    # Screens on monitors

    def open_screen(self, screen_id: str) -> str | None:
        """Open a screen fullscreen on its monitor. Returns what went wrong, if anything."""
        screen = next((screen for screen in self.setup["screens"] if screen["id"] == screen_id), None)
        if screen is None:
            return "That screen isn't in the setup."
        self.monitors = monitors.list_monitors()
        monitor = next((monitor for monitor in self.monitors if monitor["id"] == screen.get("monitor")), None)
        if monitor is None:
            return f"Choose a monitor for {screen['name']} first, or check that it's connected."
        browser = monitors.find_browser(self.config.get("browser", {}).get("path", ""))
        if browser is None:
            return "Couldn't find Chrome or Edge. Set browser.path in config.yaml."
        self.close_screen(screen_id)
        profile = BROWSER_PROFILES / re.sub(r"[^\w-]", "_", screen_id)
        url = f"http://127.0.0.1:{self.port}/screen.html?id={quote(screen_id)}"
        self.windows[screen_id] = monitors.open_fullscreen(url, monitor, profile, browser)
        return None

    def close_screen(self, screen_id: str) -> None:
        window = self.windows.pop(screen_id, None)
        if window and window.poll() is None:
            window.terminate()

    # Background loops

    async def _pump_frames(self) -> None:
        period = 1 / self.camera_settings["preview_fps"]
        max_width = self.camera_settings["preview_max_width"]
        quality = self.camera_settings["jpeg_quality"]
        last_sent: dict[str, int] = {}
        loop = asyncio.get_running_loop()
        next_tick = loop.time()
        while True:
            next_tick = max(next_tick + period, loop.time())
            await asyncio.sleep(next_tick - loop.time())
            for name in {name for client in self.clients for name in client.watching}:
                source = self._frames_for(name)
                frame, frame_id = source.latest() if source else (None, 0)
                if frame is None or last_sent.get(name) == frame_id:
                    continue
                last_sent[name] = frame_id
                data = await asyncio.to_thread(encode_preview, name, frame, max_width, quality)
                for client in self.clients:
                    if name in client.watching:
                        client.send_frame(name, data)

    async def _pump_status(self) -> None:
        while True:
            await asyncio.sleep(1)
            self._broadcast(self._status())

    async def _pump_journey(self) -> None:
        while True:
            await asyncio.sleep(1 / UPDATES_PER_SECOND)
            t = time.monotonic()
            face = any(t - client.face_seen_at < FACE_REPORT_SECONDS for client in self.clients)
            moving = any(t - client.movement_seen_at < MOVEMENT_REPORT_SECONDS for client in self.clients)
            self.journey.on_presence(face or moving, face, t)
            self.journey.tick(t)
            self._follow_visit(t)
            self._drop_old_still(t)
            job = self.reel_face.next_to_plan()
            if job:
                asyncio.create_task(self._plan(job))
            tiles = self.reel_face.tick(t)
            for tile in tiles:
                self._broadcast(ReelFace.tile_message(tile))
            if tiles:
                self._broadcast(self.reel_face.message())
            # The face speaks while it's forming and someone is there to speak for.
            word = self.reel_face.speak(t, self.journey.stage == "forming" and self.journey.present)
            if word:
                self._broadcast(word)
            if self.journey.stage == "forming" and self.reel_face.progress >= 1:
                self._begin_climax(t)  # the face is complete
            self._broadcast(self.journey.snapshot(t))

    async def _plan(self, job: PlanJob) -> None:
        """Cuts a reel into fragments on a worker thread, so the pages are never
        kept waiting while it does."""
        try:
            tiles = await asyncio.to_thread(job.plan)
        except Exception as error:  # a reel that can't be cut is skipped, not the end of the visit
            print(f"Couldn't cut reel {job.reel.number} into fragments: {error!r}")
            tiles = []
        self.reel_face.planned(job, tiles, time.monotonic())

    # The visitor's still: the one thing another device can reach

    async def _open_still_site(self) -> None:
        """A second, tiny site for phones on the same network: nothing but a
        still, at a link nobody could guess. Everything else stays on this computer."""
        app = web.Application(middlewares=[_no_cache])
        app.router.add_get("/s/{token}", self.serve_still)
        self._still_site = web.AppRunner(app, access_log=None)
        await self._still_site.setup()
        try:
            await web.TCPSite(self._still_site, "0.0.0.0", self.config["still"]["port"]).start()
        except OSError as error:
            print(f"The visitor's still can't be reached from phones: {error}")

    async def serve_still(self, request: web.Request) -> web.Response:
        still = self.still
        if not still or not secrets.compare_digest(request.match_info["token"], still["token"]):
            return web.Response(status=404, text="This face is gone.")
        return web.Response(body=still["jpeg"], content_type="image/jpeg",
                            headers={"Content-Disposition": 'inline; filename="my-reel-face.jpg"'})

    async def receive_still(self, request: web.Request) -> web.Response:
        """A page's picture of the face at its peak; the first one of each visit is kept."""
        if self.journey.stage not in ("climax", "dark", "still") or self.still:
            return web.Response(status=204)
        jpeg = await request.read()
        if not jpeg.startswith(b"\xff\xd8"):
            return web.Response(status=400)
        token = secrets.token_urlsafe(16)
        address = self._network_address()
        url = f"http://{address}:{self.config['still']['port']}/s/{token}" if address else None
        self.still = {"token": token, "jpeg": jpeg, "url": url, "visit": self.journey.visits,
                      "expires": time.monotonic() + self.config["still"]["keep_seconds"],
                      "qr": [[int(bool(cell)) for cell in row] for row in segno.make(url, error="m").matrix] if url else None}
        self._broadcast(self._still_message())
        return web.Response(status=204)

    def _still_message(self) -> dict:
        return {"type": "still", "url": self.still["url"] if self.still else None, "qr": self.still["qr"] if self.still else None}

    def _drop_old_still(self, t: float) -> None:
        if self.still and (t >= self.still["expires"] or self.still["visit"] != self.journey.visits):
            self.still = None
            self._broadcast(self._still_message())

    def _network_address(self) -> str | None:
        """This computer's address on the network phones are on: as set, or its
        own hotspot's if it's running one, or the one it reaches the world from."""
        chosen = self.config["still"].get("host")
        if chosen:
            return chosen
        try:
            if HOTSPOT_ADDRESS in socket.gethostbyname_ex(socket.gethostname())[2]:
                return HOTSPOT_ADDRESS
        except OSError:
            pass
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            try:
                probe.connect(("10.255.255.255", 1))  # sends nothing: only asks which address it would use
                return probe.getsockname()[0]
            except OSError:
                return None


@web.middleware
async def _no_cache(request: web.Request, handler) -> web.StreamResponse:
    # Always serve the latest page and scripts after an edit.
    response = await handler(request)
    if not response.prepared:
        response.headers["Cache-Control"] = "no-store"
    return response


def _page(filename: str):
    async def handler(_request: web.Request) -> web.FileResponse:
        return web.FileResponse(WEB / filename)
    return handler


async def _to_editor(_request: web.Request) -> web.Response:
    raise web.HTTPFound("/editor")


async def _to_screen(request: web.Request) -> web.Response:
    """The old address of a screen, /screen/<id>: the pages use relative paths now, so they work anywhere."""
    query = {"id": request.match_info["id"], **{k: v for k, v in request.query.items() if k != "id"}}
    raise web.HTTPFound(f"/screen.html?{urlencode(query)}")


async def _this_is_the_eye(_request: web.Request) -> web.Response:
    """Pages ask, to know they're served by the Python eye and not somewhere
    that only serves files (GitHub Pages), where the eye runs in Chrome instead (web/js/link.js)."""
    return web.json_response({"eye": "python"}, headers={"X-Reel-Life-Eye": "python"})


def run(port: int | None = None, open_editor: bool = False, open_screens: bool = False) -> None:
    config = settings.load_config()
    port = port or config["server"]["port"]
    eye = Eye(config, port)

    app = web.Application(middlewares=[_no_cache], client_max_size=STILL_MOST_BYTES)
    app["open_editor"] = open_editor
    app["open_screens"] = open_screens
    app.router.add_get("/", _to_editor)
    app.router.add_get("/eye", _this_is_the_eye)
    app.router.add_get("/editor", _page("editor.html"))
    app.router.add_get("/look", _page("look.html"))
    for name in ("editor.html", "look.html", "screen.html"):
        app.router.add_get(f"/{name}", _page(name))
    app.router.add_get("/screen/{id}", _to_screen)
    # What the Chrome version of the eye reads at start, for pages opened here with ?local (web/js/link.js).
    for name in ("config.yaml", "setup.json"):
        app.router.add_get(f"/{name}", lambda _request, name=name: web.FileResponse(settings.ROOT / name))
    app.router.add_get("/ws", eye.websocket)
    app.router.add_post("/still", eye.receive_still)
    app.router.add_static("/js", WEB / "js")
    app.router.add_static("/css", WEB / "css")
    # MediaPipe, for tracking the participant's face. Windows can't be trusted with these types.
    mimetypes.add_type("text/javascript", ".mjs")
    mimetypes.add_type("application/wasm", ".wasm")
    app.router.add_static("/vendor", WEB / "vendor")
    # Recorded words for the face to speak (reel_face.voice.clips), if any.
    voice = settings.ROOT / config["reel_face"]["voice"]["clips"]
    voice.mkdir(exist_ok=True)
    app.router.add_static("/voice", voice)
    app.on_startup.append(eye.start)
    app.on_cleanup.append(eye.stop)

    print(f"The Reel Life eye is running. Editor: http://localhost:{port}/editor  (Ctrl+C to stop)")
    missing = "none (is the camera allowed? See README.md)" if sys.platform == "darwin" else "none (is ffmpeg installed?)"
    print(f"Cameras found: {', '.join(eye.devices) or missing}")
    web.run_app(app, host="127.0.0.1", port=port, print=None)
