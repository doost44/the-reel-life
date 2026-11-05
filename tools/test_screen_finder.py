"""Benchmark the phone-screen finder on synthetic pictures: phones at random
rotations and tilts, on dark, wall, desk and cluttered backgrounds, with
rounded screen corners, thumbs and glare. Scores how often the outline is
found, and how often its top is the phone's top.

    python tools/test_screen_finder.py [--count 400] [--seed 7] [--save-failures]

A find counts when the outline overlaps the true screen by 85% or more
(intersection over union).
"""

import argparse
import math
import sys
import time
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from eye import settings  # noqa: E402
from eye.detector import find_screen  # noqa: E402
from make_test_clip import Reel  # noqa: E402

FRAME = (720, 480)
BACKGROUNDS = ["dark mat", "bright wall", "desk", "clutter"]
OUT = settings.ROOT / "tests" / "finder-failures"


def background(rng: np.random.Generator, kind: str) -> np.ndarray:
    width, height = FRAME
    low = cv2.resize(rng.normal(0, 1, (12, 18)).astype(np.float32), FRAME, interpolation=cv2.INTER_CUBIC)
    if kind == "dark mat":
        gray = 25 + 7 * low
        image = np.dstack([gray * 0.95, gray, gray * 1.05])
    elif kind == "bright wall":
        ramp = np.linspace(rng.uniform(150, 190), rng.uniform(190, 230), width)[None, :]
        gray = ramp + 10 * low
        image = np.dstack([gray * 0.85, gray * 0.97, gray])  # warm wall
    else:
        base = rng.uniform(90, 140)
        stripes = 12 * np.sin(np.arange(height)[:, None] / rng.uniform(3, 9) + 3 * low)
        gray = base + stripes + 8 * low
        image = np.dstack([gray * 0.7, gray * 0.85, gray])  # wood-ish
        if kind == "clutter":
            for _ in range(int(rng.integers(3, 7))):
                x, y = int(rng.integers(-100, width)), int(rng.integers(-100, height))
                w, h = int(rng.integers(60, 300)), int(rng.integers(40, 220))
                shade = float(rng.choice([rng.uniform(200, 245), rng.uniform(10, 50), rng.uniform(80, 180)]))
                cv2.rectangle(image, (x, y), (x + w, y + h), (shade, shade, shade * 1.02), -1)
    return image.astype(np.float32)


def rounded_mask(size: tuple[int, int], radius: int) -> np.ndarray:
    width, height = size
    mask = np.zeros((height, width), np.float32)
    cv2.rectangle(mask, (radius, 0), (width - radius, height), 1, -1)
    cv2.rectangle(mask, (0, radius), (width, height - radius), 1, -1)
    for cx, cy in [(radius, radius), (width - radius, radius), (radius, height - radius), (width - radius, height - radius)]:
        cv2.circle(mask, (cx, cy), radius, 1, -1, cv2.LINE_AA)
    return mask


def project(points: np.ndarray, roll: float, tilt_x: float, tilt_y: float, center: tuple[float, float], distance: float = 900) -> np.ndarray:
    """Phone-plane points (pixels, origin at the phone's centre) to the camera picture."""
    def rotation(axis: str, angle: float) -> np.ndarray:
        c, s = math.cos(angle), math.sin(angle)
        return {"x": np.array([[1, 0, 0], [0, c, -s], [0, s, c]]),
                "y": np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]]),
                "z": np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])}[axis]
    turn = rotation("x", tilt_x) @ rotation("y", tilt_y) @ rotation("z", roll)
    world = np.c_[points, np.zeros(len(points))] @ turn.T
    z = distance + world[:, 2]
    return np.c_[distance * world[:, 0] / z + center[0], distance * world[:, 1] / z + center[1]].astype(np.float32)


def scene(rng: np.random.Generator, kind: str) -> tuple[np.ndarray, np.ndarray, dict]:
    width, height = FRAME
    screen_h = rng.uniform(150, 330)
    aspect = rng.uniform(1.78, 2.2)
    screen_w = screen_h / aspect
    bezel = rng.uniform(5, 12)
    roll = rng.uniform(0, 2 * math.pi)
    tilt_x, tilt_y = (math.radians(a) for a in rng.uniform(-40, 40, 2))
    sw, sh, bw, bh = screen_w / 2, screen_h / 2, screen_w / 2 + bezel, screen_h / 2 + bezel
    screen_corners = np.array([[-sw, -sh], [sw, -sh], [sw, sh], [-sw, sh]])
    body_corners = np.array([[-bw, -bh], [bw, -bh], [bw, bh], [-bw, bh]])

    for _ in range(50):
        center = (rng.uniform(0, width), rng.uniform(0, height))
        body = project(body_corners, roll, tilt_x, tilt_y, center)
        if body[:, 0].min() > 6 and body[:, 0].max() < width - 6 and body[:, 1].min() > 6 and body[:, 1].max() < height - 6:
            break
    else:
        return scene(rng, kind)  # too big for the frame at this angle; try another phone
    screen = project(screen_corners, roll, tilt_x, tilt_y, center)

    image = background(rng, kind)
    content_size = (int(screen_w * 2), int(screen_h * 2))
    body_size = (int(bw * 4), int(bh * 4))
    radius = int(rng.uniform(6, 18) * 2)

    def paste(picture: np.ndarray, mask: np.ndarray, corners: np.ndarray) -> None:
        nonlocal image
        h, w = mask.shape
        source = np.array([[0, 0], [w, 0], [w, h], [0, h]], np.float32)
        transform = cv2.getPerspectiveTransform(source, corners)
        warped = cv2.warpPerspective(picture.astype(np.float32), transform, FRAME)
        alpha = cv2.warpPerspective(mask, transform, FRAME)[..., None]
        image = image * (1 - alpha) + warped * alpha

    shade = rng.uniform(12, 35)
    paste(np.full((*body_size[::-1], 3), shade, np.float32), rounded_mask(body_size, radius + 2 * int(bezel)), body)
    content = cv2.resize(Reel(rng).render(rng.uniform(0, 5)), content_size)
    paste(content, rounded_mask(content_size, radius), screen)

    extras = {"thumb": rng.random() < 0.5, "glare": rng.random() < 0.3}
    if extras["thumb"]:
        bottom = (screen[2] + screen[3]) / 2
        up = (screen[0] + screen[3]) / 2 - screen[3]
        tip = bottom + up * rng.uniform(0.1, 0.4)
        end = bottom - up * 0.6 + rng.normal(0, 30, 2)
        skin = (rng.uniform(90, 140), rng.uniform(120, 170), rng.uniform(170, 220))
        cv2.line(image, tuple(int(v) for v in end), tuple(int(v) for v in tip), skin, int(rng.uniform(26, 40)), cv2.LINE_AA)
    if extras["glare"]:
        glare = np.zeros(FRAME[::-1], np.float32)
        a, b = screen[0] + (screen[1] - screen[0]) * rng.uniform(0, 1), screen[3] + (screen[2] - screen[3]) * rng.uniform(0, 1)
        cv2.line(glare, tuple(int(v) for v in a), tuple(int(v) for v in b), 1, int(rng.uniform(15, 40)))
        image += cv2.GaussianBlur(glare, (0, 0), 12)[..., None] * rng.uniform(60, 120)

    image = cv2.GaussianBlur(image, (3, 3), 0.8) + rng.normal(0, 4, image.shape)
    angles = {"roll": math.degrees(roll) % 360, "tilt": max(abs(math.degrees(tilt_x)), abs(math.degrees(tilt_y)))}
    return np.clip(image, 0, 255).astype(np.uint8), screen, {**extras, **angles}


def overlap(a: np.ndarray, b: np.ndarray) -> float:
    a, b = a.astype(np.float32), b.astype(np.float32)
    if cv2.contourArea(cv2.convexHull(a)) == 0:
        return 0.0
    inter, _ = cv2.intersectConvexConvex(cv2.convexHull(a), cv2.convexHull(b))
    return inter / (cv2.contourArea(a) + cv2.contourArea(b) - inter)


def roll_bucket(roll: float) -> str:
    off_upright = min(roll % 180, 180 - roll % 180)
    return "upright ±30°" if off_upright <= 30 else "diagonal" if off_upright <= 60 else "sideways"


def tilt_bucket(tilt: float) -> str:
    return "tilt <15°" if tilt < 15 else "tilt 15-30°" if tilt < 30 else "tilt 30-40°"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--count", type=int, default=400)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--save-failures", action="store_true", help=f"save failed pictures to {OUT}")
    args = parser.parse_args()
    rng = np.random.default_rng(args.seed)
    detection = settings.load_config()["detection"]
    if args.save_failures:
        OUT.mkdir(parents=True, exist_ok=True)
        for old in OUT.glob("*.jpg"):
            old.unlink()

    groups = defaultdict(lambda: [0, 0])
    found_count = upright_tops = 0
    finder_seconds = 0.0
    for index in range(args.count):
        kind = BACKGROUNDS[index % len(BACKGROUNDS)]
        image, truth, info = scene(rng, kind)
        started = time.perf_counter()
        found = find_screen(image, detection)
        finder_seconds += time.perf_counter() - started
        ok = found is not None and overlap(found, truth) >= 0.85
        for group in (kind, roll_bucket(info["roll"]), tilt_bucket(info["tilt"]),
                      "with thumb" if info["thumb"] else "no thumb", "with glare" if info["glare"] else "no glare"):
            groups[group][0] += ok
            groups[group][1] += 1
        if ok:
            found_count += 1
            height = np.linalg.norm(truth[3] - truth[0])
            upright_tops += np.linalg.norm(found - truth, axis=1).mean() < 0.15 * height
        elif args.save_failures:
            view = image.copy()
            cv2.polylines(view, [truth.astype(np.int32)], True, (0, 255, 0), 1)
            if found is not None:
                cv2.polylines(view, [found.astype(np.int32)], True, (0, 0, 255), 2)
            cv2.imwrite(str(OUT / f"{index:03d}-{kind.replace(' ', '-')}.jpg"), view)

    print(f"Found {found_count}/{args.count} ({100 * found_count / args.count:.0f}%); "
          f"top of the phone right in {upright_tops}/{found_count} of those; "
          f"{1000 * finder_seconds / args.count:.1f} ms per picture")
    for group in BACKGROUNDS + ["upright ±30°", "diagonal", "sideways", "tilt <15°", "tilt 15-30°", "tilt 30-40°",
                                "no thumb", "with thumb", "no glare", "with glare"]:
        ok, total = groups[group]
        print(f"  {group:14} {ok:4}/{total:<4} {100 * ok / max(total, 1):4.0f}%")


if __name__ == "__main__":
    main()
