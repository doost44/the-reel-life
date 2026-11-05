# Footage

Recordings for presenting the project: development evidence for the A2 submission and the exhibition
station.

| Folder | What's in it |
| --- | --- |
| `live-tests/` | Real test sessions, recorded from the editor (Detection panel → **Record footage**). Each session gets its own folder, named by date and time. |
| `demos/` | Demonstration clips made from synthetic test footage (`tools/make_footage_demos.py`). |

Each live-test session holds:

| File | What it is |
| --- | --- |
| `camera.mp4` | What the detection camera saw |
| `detection.mp4` | The same, with the tracked screen outline, live numbers and SWIPE markers |
| `swipes.csv` | Every swipe detected, with its time, dwell and speed |

Recording switches itself off after 10 minutes.

## Privacy

Record **your own test sessions only**, or people who have agreed to it. The exhibit never records
visitors, and the A2 privacy plan says so. If you film anyone else for documentation, ask first, put up
a sign, and keep their notifications and private content out of what you show.

For the game screen itself, with sound, a screen recording (OBS) works best. Record the screen page
fullscreen.
