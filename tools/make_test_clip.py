"""Make a synthetic test clip: a phone on a dark mat scrolling through reels,
seen by a soft, noisy camera, with a thumb doing the swipes. Also writes the
true swipe times, so tools/detect_clip.py can score the detector without a
phone. It's a stand-in until there are real recordings, not a replacement.

    python tools/make_test_clip.py [--seconds 90] [--seed 1]

The clip includes fast, normal and slow reels, dark-mode reels, scene cuts
inside reels, swipes back, and half-swipes that spring back (which must not
count).
"""

import argparse
import csv
import math
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from eye import settings  # noqa: E402

OUT = settings.ROOT / "tests" / "clips"
FRAME_SIZE = (720, 480)
FPS = 30
SCREEN = (180, 390)  # phone screen content, width × height


class Reel:
    def __init__(self, rng: np.random.Generator) -> None:
        self.rng = rng
        self.dark = rng.random() < 0.2
        self.cut_every = rng.uniform(1.5, 4) if rng.random() < 0.4 else None  # scene cuts inside the video
        self.scenes = [self._scene(), self._scene()]
        self.blobs = [(rng.uniform(0, SCREEN[0]), rng.uniform(0, SCREEN[1]), rng.uniform(-40, 40), rng.uniform(-40, 40),
                       rng.uniform(12, 40), tuple(int(c) for c in rng.integers(0, 255, 3))) for _ in range(3)]

    def _scene(self) -> np.ndarray:
        rng = self.rng
        width, height = SCREEN
        low, high = (20, 70) if self.dark else (90, 230)
        top, bottom = rng.uniform(low, high, 3), rng.uniform(low, high, 3)
        ramp = np.linspace(0, 1, height)[:, None, None]
        scene = (top * (1 - ramp) + bottom * ramp) * np.ones((height, width, 3))
        scene = scene.astype(np.uint8)
        for _ in range(int(rng.integers(3, 8))):
            color = tuple(int(c) for c in rng.integers(0, 255, 3))
            x, y = int(rng.integers(0, width)), int(rng.integers(0, height))
            if rng.random() < 0.5:
                cv2.circle(scene, (x, y), int(rng.integers(10, 60)), color, -1)
            else:
                cv2.rectangle(scene, (x, y), (x + int(rng.integers(20, 120)), y + int(rng.integers(10, 80))), color, -1)
        return scene

    def render(self, t: float) -> np.ndarray:
        scene = self.scenes[int(t / self.cut_every) % 2 if self.cut_every else 0].copy()
        for x, y, vx, vy, radius, color in self.blobs:
            px = int((x + vx * t) % SCREEN[0])
            py = int((y + vy * t) % SCREEN[1])
            cv2.circle(scene, (px, py), int(radius), color, -1)
        return scene


def plan_swipes(rng: np.random.Generator, seconds: float) -> list[dict]:
    """Swipe times: some too fast, most normal, some slow; a few back swipes and half-swipes."""
    swipes, t = [], 3.0
    while True:
        roll = rng.random()
        dwell = rng.uniform(0.4, 1.2) if roll < 0.25 else rng.uniform(1.5, 6) if roll < 0.8 else rng.uniform(6, 11)
        kind_roll = rng.random()
        kind = "back" if kind_roll < 0.05 else "partial" if kind_roll < 0.12 else "next"
        duration = rng.uniform(0.18, 0.45)
        t += dwell
        if t + duration > seconds - 4:
            return swipes
        swipes.append({"kind": kind, "start": t, "end": t + duration, "dwell_before": dwell})
        t += duration


def phone_corners(t: float = 0, hand: np.ndarray | None = None) -> np.ndarray:
    """Where the screen lands in the camera picture: slightly turned and in
    perspective. Held in a hand (hand = random phases), it drifts, turns,
    tilts and comes closer and further, the way a held phone does."""
    cx, cy, height, width, angle, keystone = 350, 245, 330, 150, 7.0, 1.06
    if hand is not None:
        a = hand
        height, width = 300, 138  # a little smaller, so it stays in the picture as it moves
        cx += 45 * math.sin(0.7 * t + a[0]) + 12 * math.sin(2.3 * t + a[1])
        cy += 30 * math.sin(0.5 * t + a[2]) + 8 * math.sin(1.9 * t + a[3])
        angle += 14 * math.sin(0.4 * t + a[4]) + 4 * math.sin(1.7 * t + a[5])
        scale = 1 + 0.08 * math.sin(0.3 * t + a[6])
        height, width = height * scale, width * scale
        keystone += 0.06 * math.sin(0.6 * t + a[7])  # tilting towards and away
    corners = np.array([[-width / 2, -height / 2], [width / 2, -height / 2], [width / 2 * keystone, height / 2], [-width / 2 * keystone, height / 2]])
    turn = np.array([[math.cos(math.radians(angle)), -math.sin(math.radians(angle))],
                     [math.sin(math.radians(angle)), math.cos(math.radians(angle))]])
    return (corners @ turn.T + [cx, cy]).astype(np.float32)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seconds", type=float, default=90)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--handheld", action="store_true", help="the phone moves around as if held in a hand")
    args = parser.parse_args()
    rng = np.random.default_rng(args.seed)
    OUT.mkdir(parents=True, exist_ok=True)
    stem = f"synthetic-{'handheld-' if args.handheld else ''}seed{args.seed}"

    swipes = plan_swipes(rng, args.seconds)
    reels = [Reel(rng) for _ in range(len(swipes) + 2)]
    mat = cv2.GaussianBlur(rng.normal(26, 6, FRAME_SIZE[::-1]).astype(np.float32), (0, 0), 12)
    mat = np.dstack([mat * 0.95, mat, mat * 1.05])
    hand = rng.uniform(0, 2 * math.pi, 8) if args.handheld else None
    screen_corners = np.array([[0, 0], [SCREEN[0], 0], [SCREEN[0], SCREEN[1]], [0, SCREEN[1]]], dtype=np.float32)
    phone_from, phone_until = 1.0, args.seconds - 2.0

    noise = [rng.normal(0, 5, (*FRAME_SIZE[::-1], 3)).astype(np.float32) for _ in range(16)]
    rows = np.arange(FRAME_SIZE[1], dtype=np.float32)[:, None, None] / FRAME_SIZE[1]

    writer = cv2.VideoWriter(str(OUT / f"{stem}.avi"), cv2.VideoWriter_fourcc(*"MJPG"), FPS, FRAME_SIZE)
    writer.set(cv2.VIDEOWRITER_PROP_QUALITY, 90)
    for index in range(int(args.seconds * FPS)):
        t = index / FPS
        position, swiping = scroll_position(swipes, t)
        frame = mat.copy()
        if phone_from <= t < phone_until:
            corners = phone_corners(t, hand)
            to_frame = cv2.getPerspectiveTransform(screen_corners, corners)
            bezel = (corners - corners.mean(axis=0)) * 1.08 + corners.mean(axis=0)
            mask = cv2.warpPerspective(np.ones(SCREEN[::-1], np.float32), to_frame, FRAME_SIZE)[..., None]
            screen = render_screen(reels, position, t)
            cv2.fillPoly(frame, [bezel.astype(np.int32)], (12, 12, 14))
            warped = cv2.warpPerspective(screen, to_frame, FRAME_SIZE).astype(np.float32)
            frame = frame * (1 - mask) + warped * mask
            draw_thumb(frame, corners, swiping, t)
        frame *= 1 + 0.05 * np.sin(2 * np.pi * (rows * 1.5 - t * 0.7))  # slow rolling bars
        frame = cv2.GaussianBlur(frame, (3, 3), 0.8) + noise[index % len(noise)]
        writer.write(np.clip(frame, 0, 255).astype(np.uint8))
    writer.release()

    with open(OUT / f"{stem}.truth.csv", "w", newline="", encoding="utf-8") as file:
        out = csv.DictWriter(file, ["kind", "start", "end", "dwell_before"])
        out.writeheader()
        for swipe in swipes:
            out.writerow({key: round(value, 3) if isinstance(value, float) else value for key, value in swipe.items()})
    counts = {kind: sum(s["kind"] == kind for s in swipes) for kind in ("next", "back", "partial")}
    print(f"Wrote {OUT / stem}.avi ({args.seconds:.0f} s): {counts}")


def scroll_position(swipes: list[dict], t: float) -> tuple[float, float | None]:
    """Which reel is on screen at time t (2.5 is halfway from reel 2 to reel 3), and how far through a swipe we are."""
    position = 0.0
    for swipe in swipes:
        if t < swipe["start"]:
            break
        step = {"next": 1, "back": -1, "partial": 0}[swipe["kind"]]
        if t >= swipe["end"]:
            position += step
            continue
        progress = (t - swipe["start"]) / (swipe["end"] - swipe["start"])
        if swipe["kind"] == "partial":
            return position + 0.22 * math.sin(math.pi * progress), progress
        return position + step * (1 - (1 - progress) ** 3), progress
    return position, None


def render_screen(reels: list[Reel], position: float, t: float) -> np.ndarray:
    first = math.floor(position)
    offset = position - first
    strip = np.vstack([reels[first % len(reels)].render(t), reels[(first + 1) % len(reels)].render(t)])
    top = int(offset * SCREEN[1])
    screen = strip[top:top + SCREEN[1]].copy()
    # The app's buttons and caption stay put while the reels move under them.
    for row in range(4):
        cv2.circle(screen, (SCREEN[0] - 18, 170 + row * 42), 11, (245, 245, 245), -1)
    cv2.rectangle(screen, (8, SCREEN[1] - 52), (SCREEN[0] - 46, SCREEN[1] - 44), (235, 235, 235), -1)
    cv2.rectangle(screen, (8, SCREEN[1] - 36), (SCREEN[0] - 80, SCREEN[1] - 30), (200, 200, 200), -1)
    cv2.putText(screen, "Reels", (10, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (250, 250, 250), 2)
    return screen


def draw_thumb(frame: np.ndarray, corners: np.ndarray, swiping: float | None, t: float) -> None:
    bottom = (corners[2] + corners[3]) / 2
    up = (corners[0] + corners[3]) / 2 - corners[3]
    if swiping is not None:
        tip = bottom + up * (0.25 + 0.45 * swiping)
    elif math.sin(t * 0.9) > 0.3:
        tip = bottom + up * 0.15  # resting on the screen between swipes
    else:
        return
    end = bottom + np.array([60, 140])
    cv2.line(frame, tuple(int(v) for v in end), tuple(int(v) for v in tip), (110, 140, 190), 34, cv2.LINE_AA)
    cv2.circle(frame, tuple(int(v) for v in tip), 17, (120, 150, 200), -1, cv2.LINE_AA)


if __name__ == "__main__":
    main()
