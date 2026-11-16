"""The health of every part of the exhibit, for the operator panel (the editor's Visit tab).

Each part is ok (green), warn (amber: working, but not as it would be on the
day), bad (red: not working) or off (grey: switched off, or not built yet).
The status message carries the list once a second. The Chrome version's copy
is web/js/eye/health.js: change both together.
"""

from __future__ import annotations

CAMERA_STATES = {"ok": "ok", "starting": "warn", "no_signal": "warn"}  # anything else (missing, busy, lost, stopped) is bad
CAMERA_WORDS = {"ok": "live", "starting": "starting", "no_signal": "no signal", "missing": "not connected",
                "busy": "busy: another app has it?", "lost": "lost: reconnecting", "stopped": "stopped"}


def _part(id_: str, name: str, state: str, detail: str) -> dict:
    return {"id": id_, "name": name, "state": state, "detail": detail}


def _camera(info: dict | None) -> tuple[str, str]:
    if not info:
        return "warn", "starting"
    status = info.get("status", "")
    detail = CAMERA_WORDS.get(status, status)
    if status == "ok":
        detail = f"live, {info.get('fps', 0)} fps"
    return CAMERA_STATES.get(status, "bad"), detail


def parts(*, eye: str, detection_camera: str, camera: dict | None, detection: dict | None, face_feed: str,
          face_camera: dict | None, face_reports: list[dict], like_sources: dict, like_button: bool,
          classifier: dict, clips: int, clips_wanted: int) -> list[dict]:
    """eye: python or chrome. camera: the detection camera's info (None: no report yet). face_feed: camera,
    test or none; face_camera: its info where the eye opens it (the Python eye), else None. face_reports:
    what the open reel face screens last said (tracking, picture, face). clips: recorded words found."""
    result = [_part("eye", "Eye", "ok", "Python eye" if eye == "python" else "in Chrome, hosted by one open page")]

    # The phone camera and the swipe detector on it.
    if not detection_camera:
        result.append(_part("phone_camera", "Phone camera", "bad", "none chosen (Cameras tab)"))
        result.append(_part("detector", "Swipe detector", "off", "no phone camera"))
    else:
        state, detail = _camera(camera)
        result.append(_part("phone_camera", "Phone camera", state, detail))
        if state != "ok":
            result.append(_part("detector", "Swipe detector", "warn", "waiting for the phone camera"))
        elif detection and detection.get("present"):
            result.append(_part("detector", "Swipe detector", "ok",
                                f"phone found ({detection.get('zone', 'auto')}), {detection.get('swipes', 0)} swipes"))
        else:
            zone = (detection or {}).get("zone", "auto")
            result.append(_part("detector", "Swipe detector", "warn", f"no phone in view ({zone})"))

    # The face camera, and MediaPipe tracking it, as the reel face screens see them.
    if face_feed == "none":
        result.append(_part("face_camera", "Face camera", "bad", "none chosen, and no test clip"))
    elif face_feed == "test":
        result.append(_part("face_camera", "Face camera", "warn", "test clip, not a live camera"))
    elif face_camera is not None and CAMERA_STATES.get(face_camera.get("status", "")) != "ok":
        state, detail = _camera(face_camera)
        result.append(_part("face_camera", "Face camera", state, detail))
    elif face_reports:
        pictures = any(report.get("picture") for report in face_reports)
        result.append(_part("face_camera", "Face camera", "ok" if pictures else "bad",
                            "live" if pictures else "no pictures reaching the screen"))
    else:
        result.append(_part("face_camera", "Face camera", "warn", "chosen; no Reel face screen open to check it"))
    if not face_reports:
        result.append(_part("tracking", "Face tracking", "warn", "no Reel face screen open"))
    else:
        tracking = {report.get("tracking") for report in face_reports}
        if "failed" in tracking:
            result.append(_part("tracking", "Face tracking", "bad", "MediaPipe failed to start on a screen"))
        elif "starting" in tracking:
            result.append(_part("tracking", "Face tracking", "warn", "MediaPipe starting"))
        else:
            seen = any(report.get("face") for report in face_reports)
            result.append(_part("tracking", "Face tracking", "ok", "a face in view" if seen else "running, no face in view"))

    # Likes: the operator's test likes always work; the others as config.yaml switches them.
    sources = ["test"]
    if like_sources.get("key"):
        sources.append("key / like pad")
    # The heart is read reliably only with the phone's position locked: a thumb can pull a found outline off it.
    locked = (detection or {}).get("zone") == "locked"
    if like_sources.get("heart"):
        sources.append("heart on screen (click the like button on a Detection view)" if not like_button
                       else "heart on screen" if locked else "heart on screen (lock the phone position to read it reliably)")
    working = like_sources.get("key") or (like_sources.get("heart") and like_button and locked)
    result.append(_part("likes", "Like sources", "ok" if working else "warn", ", ".join(sources)))

    # The classifier: loads the first time a reel needs it.
    state = {"ready": "warn" if classifier.get("stale") else "ok", "loading": "warn", "off": "off", "failed": "bad"}
    detail = classifier.get("detail", "")
    if classifier.get("state") == "ready" and classifier.get("ms"):
        detail += f", {classifier['ms']} ms a picture"
    if classifier.get("state") == "failed":
        detail += "; every reel is Unreadable"
    result.append(_part("classifier", "Classifier", state.get(classifier.get("state"), "warn"), detail))
    if clips >= clips_wanted:
        result.append(_part("voice", "Voice", "ok", f"all {clips_wanted} recorded clips"))
    else:
        result.append(_part("voice", "Voice", "warn",
                            f"{clips} of {clips_wanted} recorded clips; the rest use the browser's voice"))
    result.append(_part("recogniser", "Listening", "off", "not built yet: it can't hear anyone"))
    return result
