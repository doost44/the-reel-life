# The test face clip

`bored.mp4` goes here: a short recording of a face (Charlie's own), looking down as if at a phone. With no face
camera chosen, the reel face tracks this clip instead, labelled on screen "TEST TRACKING · RECORDED CLIP, NOT A
LIVE CAMERA" (`reel_face.test_face_clip` in `config.yaml`). It's also what the idle attract loop will form its
synthetic face from, never a previous visitor.

It lives here, tracked in git, so GitHub Pages serves it too (`faces/` is ignored, which is why the Pages version
never had a test face). Keep it small, and **don't use Git LFS**: Pages doesn't serve LFS files.

Re-encode a recording to H.264, no sound, at most about 8 MB:

```bash
ffmpeg -i my-face.mov -an -c:v libx264 -preset slow -crf 26 -vf "scale=-2:720,fps=30" -pix_fmt yuv420p -movflags +faststart web/assets/test-face/bored.mp4
```

Raise `-crf` (28, 30) if it's still over 8 MB. Only a face that has agreed to be here belongs in this folder.
