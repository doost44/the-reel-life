"""config.yaml (edited by hand) and setup.json (saved by the editor)."""

from __future__ import annotations

import json
import os
from pathlib import Path

from ruamel.yaml import YAML

from . import look

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.yaml"
SETUP_PATH = ROOT / "setup.json"

DEFAULT_MODE = {"width": 720, "height": 480, "fps": 30}
# The detection camera defaults to 60 fps: half the movement between frames, so fast swipes measure cleanly.
DETECTION_MODE = {**DEFAULT_MODE, "fps": 60}


def load_config() -> dict:
    return YAML(typ="safe").load(CONFIG_PATH.read_text(encoding="utf-8"))


def load_setup() -> dict | None:
    if not SETUP_PATH.exists():
        return None
    try:
        setup = json.loads(SETUP_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        print(f"setup.json couldn't be read ({error}); starting from the default layout.")
        return None
    if not is_valid(setup):
        return None
    return migrated(setup)


# The exhibit used to be a casino game (archive/the-reel-life-game-version-*.zip).
RETIRED = {"stat", "meter", "callout", "banner", "gauge", "reservoir", "heartbeat", "flush", "hits", "voice",
           "face", "payout", "mirror"}
RETIRED_SCREENS = {"game", "game-casino-v1"}


def migrated(setup: dict) -> dict:
    """An older setup made fit for the reel face: the YOU mirror's camera
    becomes the face camera, the casino game's screens and sources go, and the
    reel face gets its screen and the oracle's words if it has none."""
    if "mirror_camera" in setup:
        setup["face_camera"] = setup.pop("mirror_camera")
    screens = []
    for screen in setup["screens"]:
        if screen.get("id") in RETIRED_SCREENS:
            continue
        kept = [item for item in screen["items"] if item.get("type") not in RETIRED]
        for item in kept:
            if item.get("type") != "oracle":
                item.pop("states", None)  # the game's phases mean nothing to the journey
            elif "seen" in item.get("states", []) or "oracle" in item.get("states", []):
                item["states"] = ["awake", "asking", "forming"]  # the journey's older stages
        screens.append({**screen, "items": kept})
    setup["screens"] = screens
    home = next((screen for screen in screens if any(item.get("type") == "reelface" for item in screen["items"])), None)
    if home is None:
        screens.insert(0, reel_face_screen())
    elif not any(item.get("type") == "oracle" for screen in screens for item in screen["items"]):
        home["items"].append(reel_face_screen()["items"][1])
    setup["look"] = look.complete(setup.get("look"))
    return setup


def save_setup(setup: dict) -> None:
    # Write a copy and swap it in, so a crash mid-write can't leave half a file.
    temporary = SETUP_PATH.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(setup, indent=2), encoding="utf-8")
    os.replace(temporary, SETUP_PATH)


def is_valid(setup: object) -> bool:
    return (
        isinstance(setup, dict)
        and isinstance(setup.get("screens"), list)
        and all(isinstance(screen, dict) and isinstance(screen.get("items"), list) for screen in setup["screens"])
    )


def camera_modes(setup: dict, face: str = "") -> dict[str, dict]:
    """Every camera the setup uses (by any source, hidden or not, by the
    detector, or as the face camera), with the capture size and frame rate to
    open it at."""
    names = {
        item.get("camera")
        for screen in setup["screens"]
        for item in screen["items"]
        if item.get("type") == "camera"
    }
    detection = setup.get("detection_camera")
    names.add(detection)
    names.add(face)
    names.discard(None)
    names.discard("")
    chosen = setup.get("cameras", {})
    return {name: {**(DETECTION_MODE if name == detection else DEFAULT_MODE), **chosen.get(name, {})} for name in names}


def reel_face_screen() -> dict:
    """The exhibit's main screen: the participant's face forming, full screen
    on a plain background, with the faceless oracle's words along the bottom."""
    background = "#b4b1ab"
    return {
        "id": "reelface", "name": "Reel face", "width": 1920, "height": 1080, "background": background, "monitor": "",
        "sound": True,
        "items": [
            {"id": "reel-face", "type": "reelface", "name": "Reel face", "visible": True,
             "x": 0, "y": 0, "w": 1920, "h": 1080, "background": background, "shade": 40, "fill": 60,
             "size": 40, "font": "Consolas", "color": "#141414"},
            {"id": "oracle", "type": "oracle", "name": "Oracle", "visible": True,
             "x": 160, "y": 950, "w": 1600, "h": 100, "size": 44, "font": "Consolas", "color": "#141414",
             "align": "center", "speak": True, "states": ["awake", "asking", "forming"]},
        ],
    }


def operator_screen() -> dict:
    """A screen for whoever runs the exhibit: what the phone tracker sees."""
    return {
        "id": "operator", "name": "Operator", "width": 1280, "height": 720, "background": "#000000", "monitor": "", "sound": False,
        "items": [{"id": "operator-detection", "type": "detection", "name": "Detection view", "visible": True,
                   "x": 0, "y": 0, "w": 1280, "h": 720}],
    }


def default_setup(devices: list[str], preferred: str) -> dict:
    """A first layout: the reel face, and an operator screen showing what the phone tracker sees."""
    camera = next((name for name in devices if preferred in name), devices[0] if devices else "")
    return {
        "detection_camera": camera,
        "detection_zone": None,
        "face_camera": "",  # the camera at the platform, looking up at the face; none: the test clip
        "cameras": {camera: dict(DETECTION_MODE)} if camera else {},
        "look": look.default_look(),
        "screens": [reel_face_screen(), operator_screen()],
    }
