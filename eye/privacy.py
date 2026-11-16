"""What anything sees of a capture: the reel, never the phone's own words.

Every capture (the reel at the moment of a like) and every still sent to the
classifier passes through private() first. It cuts away the edges of the
upright phone screen where a reel's interface puts writing (the status bar
with notifications at the top; the caption, username and comments at the
bottom; the rail of buttons and counts down the right), then blurs anything
left that looks like a line of text (writing burnt into the video, a
notification sliding in). It's deliberately heavy-handed: losing a little of
the picture is fine, showing a username isn't.

Also sharpness(), to pick the clearest still from just before a tap, and
thumbnail(), the tiny degraded picture the screens may show.

The Chrome version's copy is web/js/eye/privacy.js: change both together.
"""

from __future__ import annotations

import cv2
import numpy as np

TEXT_PAD = 4  # pixels round each blurred line of text


def crop(still: np.ndarray, edges: dict) -> np.ndarray:
    """The upright screen with its edges cut away (each a fraction of the screen)."""
    height, width = still.shape[:2]
    top, bottom = round(height * edges["top"]), round(height * (1 - edges["bottom"]))
    left, right = round(width * edges["left"]), round(width * (1 - edges["right"]))
    return still[top:max(top + 1, bottom), left:max(left + 1, right)].copy()


def text_boxes(image: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Boxes (x, y, w, h) round what looks like lines of text: small, high-contrast
    strokes packed into a wide, short band."""
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gradient = cv2.morphologyEx(gray, cv2.MORPH_GRADIENT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    _, strokes = cv2.threshold(gradient, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    if cv2.countNonZero(strokes) > 0.5 * strokes.size:
        return []  # all texture, no strokes to speak of
    lines = cv2.morphologyEx(strokes, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (9, 1)))
    contours, _ = cv2.findContours(lines, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if not (4 <= h <= 0.12 * height and w >= 2 * h and w >= 12):
            continue
        filled = cv2.countNonZero(strokes[y:y + h, x:x + w]) / float(w * h)
        if filled >= 0.25:
            boxes.append((x, y, w, h))
    return boxes


def private(still: np.ndarray, settings: dict) -> np.ndarray:
    """A still made safe to look at: the edges cut away and text blurred (capture settings)."""
    image = crop(still, settings["crop"])
    if settings.get("blur_text", True):
        height, width = image.shape[:2]
        for x, y, w, h in text_boxes(image):
            x0, y0 = max(0, x - TEXT_PAD), max(0, y - TEXT_PAD)
            x1, y1 = min(width, x + w + TEXT_PAD), min(height, y + h + TEXT_PAD)
            image[y0:y1, x0:x1] = cv2.GaussianBlur(image[y0:y1, x0:x1], (0, 0), 6)
    return image


def sharpness(still: np.ndarray) -> float:
    """How sharp a still is: the variance of its Laplacian (a blurred or mid-tap picture scores low)."""
    gray = cv2.cvtColor(still, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def thumbnail(image: np.ndarray, width: int) -> bytes:
    """A tiny, degraded JPEG: enough to recognise what kind of picture it was, no more."""
    height = max(1, round(image.shape[0] * width / image.shape[1]))
    small = cv2.resize(image, (width, height), interpolation=cv2.INTER_AREA)
    return cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 35])[1].tobytes()
