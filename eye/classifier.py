"""Sorting a reel into a category: CLIP, on this computer, never online.

The picture (always through privacy.private() first) goes through CLIP's
image model (ViT-B/32, 4-bit, web/vendor/clip, run with ONNX Runtime) and
comes out as a point in the same space as sentences. Each category in
config.yaml is described by a few sentences, already turned into one point
by tools/embed_categories.py. The picture belongs to the category it's
closest to; the confidence is how far it stands out (a softmax at CLIP's own
sharpness), with the runner-up kept too. Below the floor it's Unreadable.

The confidence and the runner-up are kept and shown on the HUD; the voice
never admits them. That gap is the point.

The model loads the first time it's needed, on a worker thread, and if it
can't (onnxruntime not installed, the file missing), every reel is Unreadable
and the visit goes on. The Chrome version's copy is web/js/eye/classifier.js
(with the same model, through onnxruntime-web): change both together.
"""

from __future__ import annotations

import json
import threading

import cv2
import numpy as np

from .settings import ROOT

MODEL_NAME = "Xenova/clip-vit-base-patch32 vision_model_bnb4"
SIZE = 224
MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32)
STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32)


def prompts_hash(categories: list[dict]) -> str:
    """A fingerprint of the categories and their sentences, so a stale embeddings file shows (FNV-1a, 32 bits)."""
    text = "\x1d".join(category["name"] + "\x1f" + "\x1e".join(category["prompts"]) for category in categories)
    value = 0x811C9DC5
    for byte in text.encode("utf-8"):
        value = ((value ^ byte) * 0x01000193) & 0xFFFFFFFF
    return f"{value:08x}"


def preprocess(image: np.ndarray) -> np.ndarray:
    """A BGR picture as CLIP wants it: its short side to 224, the middle 224 × 224, RGB, normalised, 1×3×224×224."""
    height, width = image.shape[:2]
    scale = SIZE / min(height, width)
    resized = cv2.resize(image, (max(SIZE, round(width * scale)), max(SIZE, round(height * scale))), interpolation=cv2.INTER_AREA)
    y, x = (resized.shape[0] - SIZE) // 2, (resized.shape[1] - SIZE) // 2
    square = cv2.cvtColor(resized[y:y + SIZE, x:x + SIZE], cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    return ((square - MEAN) / STD).transpose(2, 0, 1)[None].astype(np.float32)


def verdict(image_embedding: np.ndarray, names: list[str], text: np.ndarray, settings: dict) -> dict:
    """The closest category, its confidence and the runner-up, from an image embedding."""
    image_embedding = image_embedding / (np.linalg.norm(image_embedding) + 1e-9)
    logits = settings["logit_scale"] * (text @ image_embedding)
    odds = np.exp(logits - logits.max())
    odds /= odds.sum()
    order = np.argsort(-odds, kind="stable")
    best, second = int(order[0]), int(order[1]) if len(order) > 1 else None
    confidence = float(odds[best])
    return {
        "category": names[best] if confidence >= settings["floor"] else settings["unreadable"],
        "guess": names[best],  # what it would have said, even when it's below the floor
        "confidence": round(confidence, 3),
        "runner_up": names[second] if second is not None else None,
        "runner_up_confidence": round(float(odds[second]), 3) if second is not None else None,
    }


class Classifier:
    def __init__(self, settings: dict) -> None:
        self.settings = settings
        self.state = "off"      # off (not needed yet), loading, ready, failed
        self.detail = "loads the first time a reel needs it"
        self.stale = False      # the categories changed since tools/embed_categories.py last ran
        self.seconds = 0.0      # how long the last picture took
        self._session = None
        self._names: list[str] = []
        self._text: np.ndarray | None = None
        self._lock = threading.Lock()

    def _load(self) -> None:
        self.state, self.detail = "loading", "loading the model"
        try:
            import onnxruntime as ort

            data = json.loads((ROOT / self.settings["embeddings"]).read_text(encoding="utf-8"))
            self._names = [category["name"] for category in data["categories"]]
            self._text = np.array([category["embedding"] for category in data["categories"]], dtype=np.float32)
            self.stale = data.get("prompts_hash") != prompts_hash(self.settings["categories"])
            options = ort.SessionOptions()
            options.log_severity_level = 3
            self._session = ort.InferenceSession(str(ROOT / self.settings["model"]), options, providers=["CPUExecutionProvider"])
            self.state = "ready"
            self.detail = f"{len(self._names)} categories" + (" (categories changed: run tools/embed_categories.py)" if self.stale else "")
        except Exception as error:  # no onnxruntime, no model, a bad file: every reel is Unreadable
            self.state, self.detail = "failed", f"couldn't load: {error}"[:160]
            print(f"The classifier couldn't load, so every reel is {self.settings['unreadable']}: {error!r}")

    def classify(self, image: np.ndarray) -> dict:
        """A private picture's category (call from a worker thread: it takes a moment, and the model loads on first use)."""
        import time

        with self._lock:
            if self.state in ("off", "loading"):
                self._load()
            if self.state != "ready":
                return {"category": self.settings["unreadable"], "guess": None, "confidence": 0.0,
                        "runner_up": None, "runner_up_confidence": None}
            started = time.perf_counter()
            embedding = self._session.run(None, {"pixel_values": preprocess(image)})[0][0]
            self.seconds = time.perf_counter() - started
            return verdict(embedding, self._names, self._text, self.settings)

    def info(self) -> dict:
        return {"state": self.state, "detail": self.detail, "stale": self.stale, "ms": round(self.seconds * 1000)}
