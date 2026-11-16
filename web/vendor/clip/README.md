# CLIP, for sorting reels into categories

- `vision_model_bnb4.onnx`: the image half of OpenAI's CLIP ViT-B/32, converted to ONNX and quantised to 4 bits
  by Xenova (https://huggingface.co/Xenova/clip-vit-base-patch32, `onnx/vision_model_bnb4.onnx`), unchanged.
  58 MB. Both eyes run this same file (ONNX Runtime in Python, ONNX Runtime Web in Chrome), so they give the same
  answers: on test pictures the two agree to four decimal places.
- `categories.json`: one point per category, from `config.yaml`'s sentences, made by `tools/embed_categories.py`
  with CLIP's text model (which the exhibit doesn't need). No visitor data.

Licence: MIT, © OpenAI (https://github.com/openai/CLIP/blob/main/LICENSE).

The 4-bit model is as close to the full-size one as the 8-bit one (cosine 0.966 against 0.964 on test crops) at
two thirds the size, and unlike the 8-bit one its answers are identical in both eyes.
