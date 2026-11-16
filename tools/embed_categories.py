"""Turn the classifier's category sentences (config.yaml, classifier.categories)
into what both eyes compare pictures against: one CLIP text embedding per
category, the average of its sentences'. Writes classifier.embeddings
(web/vendor/clip/categories.json). Run it after changing any category or
sentence; the editor's Health panel says when it's needed.

    python tools/embed_categories.py

It needs the tokenizers package (pip install tokenizers) and, the first time,
the internet: it downloads CLIP's text model and tokenizer (about 65 MB) from
Hugging Face into a cache outside the repository. The exhibit itself never
needs them, or the internet: only this file, which holds no visitor data.
"""

import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from eye import settings  # noqa: E402
from eye.classifier import MODEL_NAME, prompts_hash  # noqa: E402

SOURCE = "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/"
FILES = {"tokenizer.json": "tokenizer.json", "text_model_quantized.onnx": "onnx/text_model_quantized.onnx"}
CACHE = Path.home() / ".cache" / "the-reel-life" / "clip"
END_OF_TEXT = 49407


def fetch() -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    for name, remote in FILES.items():
        target = CACHE / name
        if not target.exists():
            print(f"Downloading {name}…")
            urllib.request.urlretrieve(SOURCE + remote, target)
    return CACHE


def main() -> None:
    from tokenizers import Tokenizer

    config = settings.load_config()["classifier"]
    folder = fetch()
    tokenizer = Tokenizer.from_file(str(folder / "tokenizer.json"))
    model = ort.InferenceSession(str(folder / "text_model_quantized.onnx"), providers=["CPUExecutionProvider"])
    categories = []
    for category in config["categories"]:
        ids = [tokenizer.encode(prompt).ids[:77] for prompt in category["prompts"]]
        longest = max(len(row) for row in ids)
        batch = np.array([row + [END_OF_TEXT] * (longest - len(row)) for row in ids], dtype=np.int64)
        embeds = model.run(None, {"input_ids": batch})[0]
        embeds /= np.linalg.norm(embeds, axis=1, keepdims=True)
        mean = embeds.mean(axis=0)
        mean /= np.linalg.norm(mean)
        categories.append({"name": category["name"], "embedding": [round(float(v), 6) for v in mean]})
        print(f"  {category['name']}: {len(ids)} sentences")
    out = settings.ROOT / config["embeddings"]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"model": MODEL_NAME, "prompts_hash": prompts_hash(config["categories"]),
                               "categories": categories}, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {out.relative_to(settings.ROOT)} ({len(categories)} categories).")


if __name__ == "__main__":
    main()
