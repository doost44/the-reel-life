"""Swipe detection: find the phone screen in the camera picture and turn its
motion into swipes.

A swipe to the next reel moves the whole phone screen up at once; a video
playing on the screen doesn't. So every frame the phone screen is
straightened into a small upright picture and compared with the previous
one by phase correlation, which says how far the picture as a whole moved
and how clearly (its response). A swipe is enough mostly-vertical movement
in one direction over a run of frames. It's reported as soon as it has
travelled far enough, without waiting for the reel to land.

Detector has no threads and no camera of its own: feed it frames with
process(). tools/detect_clip.py runs it on recordings the same way.
"""

from __future__ import annotations

import itertools
import math

import cv2
import numpy as np

WARP_WIDTH, WARP_HEIGHT = 108, 192  # the straightened phone screen, 9:16


class Detector:
    def __init__(self, settings: dict) -> None:
        self.settings = settings
        self.zone: np.ndarray | None = None   # locked corners as fractions of the frame, or None to find the phone
        self.quad: np.ndarray | None = None   # phone screen corners in frame pixels: top-left, top-right, bottom-right, bottom-left
        self.quad_found = False
        self.tracking = 0.0                   # share of the outline the tracker could see last frame
        self.present = False
        self.warped: np.ndarray | None = None
        self.swipes = 0
        self.last_swipe: dict | None = None
        self.readout: dict = {}
        self._lost_since: float | None = None
        self._searched_at = -1e9
        self._found_aspect = 2.0              # the phone's proportions when a full search last found it
        self._visible_since: float | None = None
        self._hidden_since: float | None = None
        self._previous: np.ndarray | None = None
        self._previous_time = 0.0
        self._run: dict | None = None
        self._landed_at: float | None = None
        self._window = cv2.createHanningWindow((WARP_WIDTH, WARP_HEIGHT), cv2.CV_32F)

    def lock(self, zone: list | None) -> None:
        """Fix the phone screen's corners (fractions of the frame), or None to find it automatically."""
        was_locked = self.zone is not None
        self.zone = np.array(zone, dtype=np.float32) if zone else None
        if was_locked and self.zone is None:
            self.quad = None  # unlocked: find the phone afresh

    def zone_from_quad(self, frame_size: tuple[int, int]) -> list | None:
        """The current phone outline as fractions of the frame, for locking."""
        if self.quad is None:
            return None
        width, height = frame_size
        return [[round(float(x) / width, 4), round(float(y) / height, 4)] for x, y in self.quad]

    def process(self, frame: np.ndarray, t: float) -> list[dict]:
        """Look at one frame taken at time t (seconds). Returns phone and swipe events."""
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        self._update_quad(frame, t)
        self.warped = self._warp(gray) if self.quad is not None else None
        visible = self.warped is not None and self._looks_like_screen(self.warped)

        # A dark reel can hide the outline; keep the last one while the screen area still looks like a screen.
        if self.zone is None and not self.quad_found and self.quad is not None and not visible:
            if t - (self._lost_since or t) > self.settings["hold_seconds"]:
                self.quad = None

        events = self._update_presence(visible, t)
        if visible:
            events += self._track_motion(self.warped, t)
        else:
            self._previous = None
            self._run = None
        return events

    # Finding and straightening the phone screen

    def _update_quad(self, frame: np.ndarray, t: float) -> None:
        """Track the screen from last frame's outline; search the whole picture
        only when there's nothing to track."""
        height, width = frame.shape[:2]
        if self.zone is not None:
            self.quad = self.zone * np.array([width, height], dtype=np.float32)
            self.quad_found = True
            return
        if self.quad is not None:
            value = cv2.GaussianBlur(frame.max(axis=2), (3, 3), 0)
            tracked, seen = track_screen(value, self.quad, self.settings)
            # The phone's proportions, as last found by a full search, only change
            # so much with tilt; an outline that's drifted onto a hand changes them a lot.
            keeps_shape = tracked is not None and abs(_aspect(tracked) / self._found_aspect - 1) < 0.25
            if tracked is not None and keeps_shape and _plausible(tracked) and _close(tracked, self.quad):
                self.quad, self.quad_found, self.tracking = _portrait(tracked), True, seen
                self._lost_since = None
                return
        self.quad_found, self.tracking = False, 0.0
        if self.quad is not None and self._lost_since is None:
            self._lost_since = t
        # Searching is slow, so not every frame.
        if t - self._searched_at >= self.settings["search_seconds"]:
            self._search(frame, t)

    def _search(self, frame: np.ndarray, t: float) -> None:
        """Search the whole picture for the screen."""
        self._searched_at = t
        found = find_screen(frame, self.settings)
        if found is None:
            return
        # Keep the same corner as "top-left" when finding it again.
        self.quad = found if self.quad is None else _align(found, self.quad)
        self.quad_found, self._lost_since = True, None
        self._found_aspect = _aspect(found)

    def _warp(self, gray: np.ndarray) -> np.ndarray:
        quad = np.roll(self.quad, -(self.settings["rotate"] // 90) % 4, axis=0).astype(np.float32)
        # Straighten at twice the size, then shrink: smooths camera noise and interlacing.
        size = (WARP_WIDTH * 2, WARP_HEIGHT * 2)
        target = np.array([[0, 0], [size[0], 0], [size[0], size[1]], [0, size[1]]], dtype=np.float32)
        straight = cv2.warpPerspective(gray, cv2.getPerspectiveTransform(quad, target), size)
        return cv2.resize(straight, (WARP_WIDTH, WARP_HEIGHT), interpolation=cv2.INTER_AREA)

    def _looks_like_screen(self, warped: np.ndarray) -> bool:
        return warped.mean() > self.settings["screen_brightness"] or warped.std() > self.settings["screen_texture"]

    def _update_presence(self, visible: bool, t: float) -> list[dict]:
        # Half a second either way, so a hand passing over doesn't count.
        if visible:
            self._hidden_since = None
            self._visible_since = self._visible_since or t
        else:
            self._visible_since = None
            self._hidden_since = self._hidden_since or t
        if not self.present and visible and t - self._visible_since >= 0.5:
            self.present = True
            self._landed_at = t
            return [{"type": "phone", "present": True, "t": t}]
        if self.present and not visible and t - self._hidden_since >= 0.5:
            self.present = False
            return [{"type": "phone", "present": False, "t": t}]
        return []

    # Turning movement into swipes

    def _track_motion(self, warped: np.ndarray, t: float) -> list[dict]:
        settings = self.settings
        current = warped.astype(np.float32)
        current = (current - current.mean()) / (current.std() + 1.0)
        previous, previous_time = self._previous, self._previous_time
        self._previous, self._previous_time = current, t
        if previous is None:
            return []

        (dx, dy), response = cv2.phaseCorrelate(previous, current, self._window)
        step = -dy / WARP_HEIGHT  # fraction of the screen; positive when the content moves up (next reel)
        sideways = abs(dx) / WARP_WIDTH
        # The thumb and motion blur add some sideways wobble, so only clearly sideways movement is rejected.
        moving = abs(step) >= settings["min_step"] and response >= settings["min_response"] and sideways < 1.5 * abs(step) + 0.02
        run = self._run
        self.readout = {"step": step, "response": response, "travel": run["travel"] if run else 0.0}

        events = []
        if moving:
            if run is None:
                run = self._run = {"start": previous_time, "travel": 0.0, "steps": [], "peak_speed": 0.0,
                                   "responses": [], "fired": False, "still": 0}
            run["steps"].append(step)
            run["responses"].append(response)
            run["peak_speed"] = max(run["peak_speed"], abs(step) / max(t - previous_time, 1e-3))
            run["still"] = 0
            # On the fastest frame of a swipe the screen can move almost half its
            # height, which phase correlation can read backwards. So the run's
            # direction comes from all its frames, weighted by how clear each was.
            # Movement that way counts, and so does a big, unclear jump the other
            # way, which is that misreading; a half-swipe springing back is slower
            # and clear, so it still cancels out.
            direction = 1 if sum(s * r for s, r in zip(run["steps"], run["responses"])) >= 0 else -1
            along = [abs(s) for s, r in zip(run["steps"], run["responses"])
                     if s * direction > 0 or (abs(s) >= 0.15 and r < 0.35)]
            run["travel"] = direction * sum(along)
            self.readout["travel"] = run["travel"]
            # A scene cut in a video can look like one big jump. A swipe keeps
            # moving around its biggest step, so the rest of the run must add up too.
            follow_through = sum(along) - max(along, default=0)
            # A reel swipe covers its distance quickly; a hand slowly moving the phone doesn't.
            quick = t - run["start"] <= settings["max_swipe_seconds"]
            # Nor can a real swipe start straight after the last one landed: that's the same swipe settling.
            settled = self._landed_at is None or run["start"] - self._landed_at >= settings["refractory_seconds"]
            if not run["fired"] and sum(along) >= settings["swipe_travel"] and follow_through >= settings["min_follow_through"]:
                run["fired"] = True  # one decision per run, whether or not it counts
                if quick and settled:
                    events.append(self._swipe(run, t))
                else:
                    run["ignored"] = True
        elif run is not None:
            # "No movement" only counts as stillness when it's clearly measured:
            # mid-swipe the screen can move too fast to measure, which reads as
            # no movement with low clarity.
            if response >= settings["still_clarity"]:
                run["still"] += 1
            if run["still"] >= settings["settle_frames"] or t - run["start"] > 1.0:
                if run["fired"] and not run.get("ignored"):
                    self._landed_at = t
                self._run = None
        return events

    def _swipe(self, run: dict, t: float) -> dict:
        self.swipes += 1
        self.last_swipe = {
            "type": "swipe",
            "t": run["start"],
            "detected_at": t,
            "direction": "next" if run["travel"] > 0 else "back",
            "dwell": run["start"] - self._landed_at if self._landed_at is not None else None,
            "speed": round(run["peak_speed"], 2),  # screen heights per second
            "confidence": round(min(1.0, float(np.mean(run["responses"])) / (3 * self.settings["min_response"])), 2),
        }
        return self.last_swipe

    # The debug view

    def debug_frame(self, frame: np.ndarray, t: float) -> np.ndarray:
        """The camera picture with the phone outline, the straightened screen and live numbers."""
        view = frame.copy()
        if self.quad is not None:
            color = (80, 255, 80) if self.present else (0, 200, 255)
            cv2.polylines(view, [self.quad.astype(np.int32)], True, color, 2)
            cv2.circle(view, tuple(int(v) for v in self.quad[0]), 6, color, -1)
        if self.warped is not None:
            inset = cv2.cvtColor(cv2.resize(self.warped, (WARP_WIDTH * 2, WARP_HEIGHT * 2), interpolation=cv2.INTER_NEAREST), cv2.COLOR_GRAY2BGR)
            height, width = inset.shape[:2]
            if height <= view.shape[0] and width <= view.shape[1]:
                view[:height, -width:] = inset
        last = self.last_swipe
        following = ("locked zone" if self.zone is not None
                     else f"tracking {self.tracking:.0%}" if self.quad_found else "searching")
        lines = [
            f"phone {'IN' if self.present else 'out'}  {following}",
            f"move {self.readout.get('step', 0):+.3f}  clarity {self.readout.get('response', 0):.2f}",
            f"travel {self.readout.get('travel', 0):+.2f} / {self.settings['swipe_travel']:.2f}",
            f"swipes {self.swipes}",
        ]
        if last:
            dwell = f"{last['dwell']:.1f}s" if last["dwell"] is not None else "-"
            lines.append(f"last: {last['direction']} after {dwell}, {last['speed']:.1f} screens/s")
        width = max(cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 1)[0][0] for text in lines)
        panel = view[4:12 + len(lines) * 22, 4:20 + width]
        panel[:] = panel * 0.35  # darken behind the text so it reads on any picture
        for row, text in enumerate(lines):
            cv2.putText(view, text, (10, 24 + row * 22), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
        if last and t - last["detected_at"] < 0.4:
            cv2.putText(view, "SWIPE", (10, view.shape[0] - 16), cv2.FONT_HERSHEY_DUPLEX, 1.2, (80, 255, 80), 2, cv2.LINE_AA)
        return view


def find_screen(frame: np.ndarray, settings: dict) -> np.ndarray | None:
    """The lit phone screen at any angle: four straight edges with a dark bezel
    just outside them. Returns its corners as top-left, top-right,
    bottom-right, bottom-left, the top being the short side higher up."""
    small = cv2.resize(frame, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
    # Each pixel's strongest colour, so a blue or purple screen counts as lit.
    # Only a light blur: a thin bezel must stay dark.
    value = cv2.GaussianBlur(small.max(axis=2), (3, 3), 0)
    height, width = value.shape
    frame_area = width * height
    max_bezel = settings["max_bezel_brightness"]
    best, best_score = None, 0.0
    for level in _brightness_levels(value, settings):
        mask = cv2.morphologyEx((value > level).astype(np.uint8) * 255, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        # Nested outlines too: on a bright wall the screen is an island inside the dark phone.
        contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
        for contour in contours:
            if not settings["min_area"] <= cv2.contourArea(contour) / frame_area <= settings["max_area"]:
                continue
            x, y, w, h = cv2.boundingRect(contour)
            if x <= 1 or y <= 1 or x + w >= width - 1 or y + h >= height - 1:
                continue  # cut off by the edge of the picture: not a whole phone
            quad = _fit_quad(contour, value, max_bezel)
            if quad is None or not _plausible(quad):
                continue
            support = _edge_support(value, quad, max_bezel)
            if support < settings["min_edge_support"] or _fill(value, quad, level) < settings["min_screen_fill"]:
                continue
            score = support * np.sqrt(cv2.contourArea(quad) / frame_area)
            if score > best_score:
                best, best_score = quad, score
    return None if best is None else _order_corners(best * 2)


def _brightness_levels(value: np.ndarray, settings: dict) -> list[int]:
    """A few brightness thresholds to try: what separates the screen depends on what's around it."""
    otsu, _ = cv2.threshold(value, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Low levels split a dim screen, or one on a bright wall, from its dark bezel;
    # high levels split a bright screen from a lighter background.
    levels = [45, 70, otsu, (otsu + 255) / 2, *np.percentile(value, [60, 80, 92])]
    return sorted({round(max(settings["min_screen_brightness"], level)) for level in levels})


def _fit_quad(contour: np.ndarray, value: np.ndarray, max_bezel: float) -> np.ndarray | None:
    """Four corners from a shape's longest straight runs: lines fitted to them
    and intersected. Rounded screen corners and a thumb across an edge then
    don't bend the outline, and tilt just changes where the lines meet. Of the
    possible fours, the one that looks most like a screen's edge wins, so a
    thumb's straight sides lose to the bezel's."""
    perimeter = cv2.arcLength(contour, True)
    poly = cv2.approxPolyDP(contour, 0.01 * perimeter, True).reshape(-1, 2).astype(np.float32)
    runs: list[dict] = []
    for a, b in zip(poly, np.roll(poly, -1, axis=0)):
        length = float(np.linalg.norm(b - a))
        if length < 0.04 * perimeter:
            continue
        direction = (b - a) / length
        for run in runs:
            # The same edge, broken where a thumb or a dark patch crosses it?
            parallel = abs(float(run["direction"] @ direction)) > math.cos(math.radians(8))
            if parallel and abs(float(run["normal"] @ a) - run["offset"]) < 0.02 * perimeter:
                run["length"] += length
                run["points"] += [a, b]
                break
        else:
            normal = np.array([-direction[1], direction[0]], dtype=np.float32)
            runs.append({"direction": direction, "normal": normal, "offset": float(normal @ a), "length": length, "points": [a, b]})
    runs.sort(key=lambda run: -run["length"])
    hull = cv2.convexHull(contour).reshape(-1, 2).astype(np.float32)
    best, best_score = None, 0.0
    for four in itertools.combinations(runs[:6], 4):
        quad = _intersect(four)
        if quad is None:
            continue
        overlap = _overlap(quad, hull)
        if overlap >= 0.5:
            score = overlap * (0.2 + _edge_support(value, quad, max_bezel))
            if score > best_score:
                best, best_score = quad, score
    if best is None:
        # Too few straight runs (very rounded, or noisy): the simplest four-cornered outline.
        for share in (0.02, 0.04, 0.06, 0.08):
            corners = cv2.approxPolyDP(hull.reshape(-1, 1, 2), share * perimeter, True).reshape(-1, 2)
            if len(corners) == 4:
                return corners.astype(np.float32)
    return best


def _intersect(runs: tuple[dict, ...]) -> np.ndarray | None:
    """Corners where neighbouring edge lines meet, the lines taken in order round the shape."""
    lines = []
    for run in runs:
        vx, vy, x0, y0 = cv2.fitLine(np.array(run["points"], np.float32), cv2.DIST_L2, 0, 0.01, 0.01).ravel()
        lines.append((np.array([x0, y0]), np.array([vx, vy])))
    middle = np.mean([np.mean(run["points"], axis=0) for run in runs], axis=0)
    lines.sort(key=lambda line: math.atan2(*(line[0] - middle)[::-1]))
    corners = []
    for (p, d), (q, e) in zip(lines, lines[1:] + lines[:1]):
        cross = d[0] * e[1] - d[1] * e[0]
        if abs(cross) < 0.2:  # nearly parallel: these aren't neighbouring edges
            return None
        s = ((q - p)[0] * e[1] - (q - p)[1] * e[0]) / cross
        corners.append(p + s * d)
    return np.array(corners, np.float32)


def _overlap(quad: np.ndarray, hull: np.ndarray) -> float:
    """Intersection over union of two convex shapes."""
    if not cv2.isContourConvex(quad.reshape(-1, 1, 2)):
        return 0.0
    inter, _ = cv2.intersectConvexConvex(quad, hull)
    union = cv2.contourArea(quad) + cv2.contourArea(hull) - inter
    return inter / union if union > 0 else 0.0


def _plausible(quad: np.ndarray) -> bool:
    """Could this be a phone screen at some angle? Convex, every corner between
    45° and 135°, and 1.3 to 3 times as long as wide: 16:9 to 20:9,
    foreshortened or stretched by tilt."""
    if not cv2.isContourConvex(quad.astype(np.float32).reshape(-1, 1, 2)):
        return False
    for i in range(4):
        before, corner, after = quad[i - 1], quad[i], quad[(i + 1) % 4]
        a, b = before - corner, after - corner
        cosine = float(a @ b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-6)
        if not 45 <= math.degrees(math.acos(max(-1.0, min(1.0, cosine)))) <= 135:
            return False
    sides = [np.linalg.norm(quad[(i + 1) % 4] - quad[i]) for i in range(4)]
    pairs = sorted([sides[0] + sides[2], sides[1] + sides[3]])
    return 1.3 <= pairs[1] / max(pairs[0], 1.0) <= 3.0


def _edge_support(value: np.ndarray, quad: np.ndarray, max_bezel: float) -> float:
    """Share of the outline that looks like a screen's edge: clearly brighter
    just inside than just outside, and dark just outside (the bezel). A wall,
    a white box or a thumb fails this along most of its outline."""
    points, normals = _side_samples(quad, 12)
    # A few pixels in from the edge (negative) and out from it (positive).
    profiles = _profiles(value, points, normals, np.array([-5, -4, -3, -2, 1, 2, 3, 4]))
    # The middle of those inside, and the darkest outside: the bezel can be
    # thin, with the background right after it.
    inside = np.median(profiles[:, :4], axis=1)
    outside = profiles[:, 4:].min(axis=1)
    return float(((inside - outside > 20) & (outside < max_bezel)).mean())


def _side_samples(quad: np.ndarray, count: int) -> tuple[np.ndarray, np.ndarray]:
    """Points along each side, away from the rounded corners, side by side
    (top, right, bottom, left), with the outward direction at each."""
    center = quad.mean(axis=0)
    points, normals = [], []
    for i in range(4):
        a, b = quad[i], quad[(i + 1) % 4]
        along = b - a
        normal = np.array([along[1], -along[0]]) / (np.linalg.norm(along) + 1e-6)
        if normal @ ((a + b) / 2 - center) < 0:
            normal = -normal
        shares = np.linspace(0.12, 0.88, count)[:, None]
        points.append(a + along * shares)
        normals.append(np.repeat(normal[None, :], count, axis=0))
    return np.concatenate(points).astype(np.float32), np.concatenate(normals).astype(np.float32)


def _profiles(value: np.ndarray, points: np.ndarray, normals: np.ndarray, offsets: np.ndarray) -> np.ndarray:
    """The picture's brightness across the edge at each point: one row per
    point, one column per offset along its outward direction. Off the
    picture reads as bright, so it never passes for a bezel."""
    coords = points[:, None, :] + normals[:, None, :] * offsets[None, :, None]
    return cv2.remap(value, coords[..., 0].astype(np.float32), coords[..., 1].astype(np.float32),
                     cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=255).astype(np.float32)


def track_screen(value: np.ndarray, quad: np.ndarray, settings: dict) -> tuple[np.ndarray | None, float]:
    """Follow the screen from last frame's outline to this frame's.

    Along each side, look a little way in and out for the step from lit
    screen to dark bezel, fit a line through the points found (dropping the
    odd one a thumb or a dark patch throws off) and meet the lines at the
    corners. A side that can't be seen keeps its last line, as long as the
    other three can. Returns the new corners and the share of the outline
    seen (0-1), or None if too little of it could be seen.
    """
    count = 20
    sides = [np.linalg.norm(quad[(i + 1) % 4] - quad[i]) for i in range(4)]
    reach = int(np.clip(0.06 * np.mean(sides), 6, 30))  # how far the edge may have moved since last frame
    offsets = np.arange(-reach - 4, reach + 5)
    points, normals = _side_samples(quad, count)
    profiles = _profiles(value, points, normals, offsets)

    # At each candidate position: the average just inside minus the darkest just outside.
    inside = (profiles[:, :-6] + profiles[:, 1:-5] + profiles[:, 2:-4]) / 3       # positions -3..-1 from the candidate
    outside = np.minimum(np.minimum(profiles[:, 4:-2], profiles[:, 5:-1]), profiles[:, 6:])  # +1..+3
    step = np.where(outside < settings["max_bezel_brightness"], inside - outside, 0)
    # Of the clear steps, the one nearest where the edge was last frame: not the
    # strongest (an edge in the reel's own picture can be stronger) and not the
    # outermost (a lit hand beside the phone makes one further out).
    clear = step > 20
    seen = clear.any(axis=1)
    middle = reach + 1  # the step column that sits on last frame's edge
    edge_at = np.zeros(len(step), dtype=int)
    for row in np.flatnonzero(seen):
        best_distance = None
        column = 0
        while column < step.shape[1]:
            if not clear[row, column]:
                column += 1
                continue
            start = column
            while column < step.shape[1] and clear[row, column]:
                column += 1
            peak = start + int(np.argmax(step[row, start:column]))  # the step stays clear a few positions round the edge
            if best_distance is None or abs(peak - middle) < best_distance:
                best_distance, edge_at[row] = abs(peak - middle), peak
    moved = offsets[edge_at + 3].astype(np.float32)  # outwards from last frame's edge, per point
    edges = points + normals * moved[:, None]

    # How far each side moved out (or in). A phone moves as one piece: moving
    # right, its right side goes out as far as its left side comes in. A thumb
    # or a dark patch moves one side alone, so that side keeps its last line.
    shifts = [float(np.median(moved[side * count:(side + 1) * count][seen[side * count:(side + 1) * count]]))
              if seen[side * count:(side + 1) * count].sum() >= 6 else None for side in range(4)]
    limit = max(6.0, 0.06 * max(sides))
    ignored = set()
    for a, b in ((0, 2), (1, 3)):
        if shifts[a] is not None and shifts[b] is not None and abs(shifts[a] + shifts[b]) > limit:
            ignored.add(a if abs(shifts[a]) > abs(shifts[b]) else b)

    lines = []
    for side in range(4):
        rows = slice(side * count, (side + 1) * count)
        found = edges[rows][seen[rows]]
        lines.append(_robust_line(found) if len(found) >= 6 and side not in ignored else None)
    if sum(line is None for line in lines) > 1:
        return None, float(seen.mean())
    for side, line in enumerate(lines):
        if line is None:  # keep this side where it was
            a, b = quad[side], quad[(side + 1) % 4]
            lines[side] = (a, (b - a) / (np.linalg.norm(b - a) + 1e-6))

    corners = []
    for side in range(4):  # corner k is where side k-1 meets side k
        (p, d), (q, e) = lines[side - 1], lines[side]
        cross = d[0] * e[1] - d[1] * e[0]
        if abs(cross) < 0.2:
            return None, float(seen.mean())
        s = ((q - p)[0] * e[1] - (q - p)[1] * e[0]) / cross
        corners.append(p + s * d)
    return np.array(corners, np.float32), float(seen.mean())


def _robust_line(points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """A line through the points, refitted without any more than 3 pixels off it."""
    vx, vy, x0, y0 = cv2.fitLine(points, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
    origin, direction = np.array([x0, y0]), np.array([vx, vy])
    off = np.abs((points - origin) @ np.array([-vy, vx]))
    keep = points[off <= 3]
    if 6 <= len(keep) < len(points):
        vx, vy, x0, y0 = cv2.fitLine(keep, cv2.DIST_L2, 0, 0.01, 0.01).ravel()
        origin, direction = np.array([x0, y0]), np.array([vx, vy])
    return origin, direction


def _fill(value: np.ndarray, quad: np.ndarray, level: float) -> float:
    """Share of the middle of the outline that's lit. A box drawn in outline
    (like the camcorder's own warnings) is only bright round its edge."""
    center = quad.mean(axis=0)
    middle = (center + (quad - center) * 0.8).astype(np.int32)
    mask = np.zeros(value.shape, np.uint8)
    cv2.fillConvexPoly(mask, middle, 1)
    inside = value[mask == 1]
    return float((inside > level).mean()) if inside.size else 0.0


def _order_corners(quad: np.ndarray) -> np.ndarray:
    """Top-left, top-right, bottom-right, bottom-left at any rotation: round the
    middle clockwise, starting so the first edge is a short side, and that
    short side the higher of the two."""
    center = quad.mean(axis=0)
    quad = quad[np.argsort(np.arctan2(quad[:, 1] - center[1], quad[:, 0] - center[0]))]
    sides = [np.linalg.norm(quad[(i + 1) % 4] - quad[i]) for i in range(4)]
    if sides[0] + sides[2] > sides[1] + sides[3]:
        quad = np.roll(quad, -1, axis=0)
    if quad[2][1] + quad[3][1] < quad[0][1] + quad[1][1]:
        quad = np.roll(quad, 2, axis=0)
    return quad.astype(np.float32)


def _portrait(quad: np.ndarray) -> np.ndarray:
    """Keep a short side as the top. If the top and bottom have become the
    long sides (the phone was first seen partly dark, say), renumber the
    corners a quarter turn, towards whichever side is higher up."""
    sides = [np.linalg.norm(quad[(i + 1) % 4] - quad[i]) for i in range(4)]
    if sides[0] + sides[2] <= sides[1] + sides[3]:
        return quad
    left_up, right_up = np.roll(quad, 1, axis=0), np.roll(quad, -1, axis=0)
    return min((left_up, right_up), key=lambda option: option[0][1] + option[1][1])


def _align(found: np.ndarray, current: np.ndarray) -> np.ndarray:
    """The found corners renumbered to match the current ones, so the phone's
    top doesn't flip between frames when it's held sideways or upside down."""
    shifts = [np.roll(found, k, axis=0) for k in range(4)]
    return min(shifts, key=lambda candidate: float(np.linalg.norm(candidate - current, axis=1).sum()))


def _aspect(quad: np.ndarray) -> float:
    """Long sides over short sides, each pair averaged."""
    sides = [np.linalg.norm(quad[(i + 1) % 4] - quad[i]) for i in range(4)]
    pairs = sorted([sides[0] + sides[2], sides[1] + sides[3]])
    return pairs[1] / max(pairs[0], 1.0)


def _close(tracked: np.ndarray, previous: np.ndarray) -> bool:
    """A believable step from one frame to the next: no corner jumping more
    than a quarter of the screen's height, and the size changing by under a third."""
    height = np.linalg.norm(previous[3] - previous[0])
    size = cv2.contourArea(tracked) / max(cv2.contourArea(previous), 1.0)
    return bool(np.linalg.norm(tracked - previous, axis=1).max() < 0.25 * height and 0.7 <= size <= 1.4)


