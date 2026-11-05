# The Reel Life: Reel-Face

A live, reflexive exhibit about the dopamine loop of watching reels, exaggerated to the nth degree:
pleasure that never satisfies, craving that only grows. A participant puts their phone on a platform and
watches reels. On the screen in front of them, their own face forms, reel by reel, out of what they watch.
It moves as they move, because it is tracked live. As it forms it wants more, and it says so, in the first
person, with words they are not saying. There is no ending; only a reset stops it.

The previous version of the exhibit, a casino game about scrolling, is kept in
`archive/the-reel-life-game-version-2026-11-03.zip`.

## How it fits together

```
phone camera ─▶ the phone on the platform          face camera ─▶ the participant's face
(camcorder or webcam, looking down)                (at the platform, looking up)
        │                                                  │
  eye/  Python + OpenCV                                    │
        detector.py     finds the phone screen, turns its movement into swipes
        watcher.py      runs the detector on the phone camera
        reel_sampler.py stills of each reel as it plays (its own thread)
        journey.py      the visit: a face seen, the oracle, the phone placed, the face forming
        reel_face.py    the reels counted, their tiles released one by one, desire, the words
        formation.py    each reel torn into fragments of the face, and how damaged
        look.py         every setting of the face's look (tuned in /look)
        distortion.py   how far the face has formed (its progress)
        server.py       sends all of it to the pages; saves the setup
        │                                                  │  one WebSocket per page
  web/  /editor          lay out the screens; run the exhibit by hand
        /look            the look editor: how the face forms, melts and breaks
        /screen/<id>     one fullscreen screen
        reelface.js      the face, tracked live (MediaPipe, tracker.js), formed from fragments, moshed
        segmenter.js     finds each person's hair and ears (MediaPipe's selfie model), for the 3D head round the face
        oracle.js        the faceless oracle's words     speech.js  the face's words and mouth
```

- `config.yaml`: everything you'd tune by hand: the oracle's words, the face's words, timings, how fast it
  forms, the phone tracker.
- `setup.json`: written by the editors: screens and their sources, which camera is which, the locked phone
  position, which monitor each screen opens on, and the face's look and its presets.
- Nothing about a visit is ever written to disk (see Privacy).

## First-time setup

The Python environment lives outside OneDrive, so OneDrive doesn't sync thousands of files. In PowerShell:

```powershell
uv venv --python 3.14 $env:USERPROFILE\.venvs\reel-life
uv pip install --python $env:USERPROFILE\.venvs\reel-life\Scripts\python.exe -r requirements.txt
```

ffmpeg must be on PATH: the eye uses it to read the cameras' names. MediaPipe (face tracking) is saved in
`web/vendor/mediapipe`, so the exhibit runs offline.

## Run it

```powershell
.\run.ps1
```

This starts the eye and opens the editor at http://localhost:8765/editor. Press Ctrl+C to stop.
`.\run.ps1 -OpenScreens` also opens every screen that has a monitor, fullscreen, with sound allowed. Use this for
the show.

https://doost44.github.io/the-reel-life/ has links to the prototype. GitHub Pages can't run it (it needs the eye,
the cameras and the phone detection), so those links only work on the computer running the eye. A screen opened
from a link stays silent until it's clicked once.

## The journey

What a visitor does, and gets. Every line the oracle says is in `config.yaml` under `journey.oracle`, with the
timings.

1. **They walk in.** Any movement in front of the face camera wakes it; no face is needed. A cloud of torn JPEG
   shards, the same shape as the face's fragments, bursts to life on the screen, follows them, and brightens as
   they come closer. There's no sign of any tracking.
2. **It speaks.** "Place your phone on the platform to begin." The energy pulses with each word.
3. **They sit and put the phone down.** The oracle says it has never seen an Instagram reel and asks to watch
   some with them. Nothing says a face will form.
4. **They open reels, or don't.** The first reel watched for at least 1.2 s starts the visit proper. It can't
   hear anyone, so it goes by what they do: after 25 s with no reels it says "You do not have it? Download it.
   I will wait.", and if there are still none after 90 s, "Then leave.", and the visit ends.
5. **The face forms, slowly, out of what they watch, and out of the energy.** Every reel is torn into fragments.
   Each one starts as a seed on the face, bends the cloud towards it like a drain, and pulls the nearest shards
   out; they streak in, taking on its reel's colours, and it grows as it absorbs them. The two aren't layers:
   shards weave through the head in depth, some in front of the face and some behind; one crossing the face
   takes on the face's own picture; the fragments' edges crumble into the same blocks; and the face sheds
   shards back all the time, so they're always passing through each other. Its hunger rises and it says so,
   faster and more insistently:
   "more", "again", "don't stop". Its mouth moves with the words; its eyes and head stay theirs. This is
   compulsion, not arousal: no nudity, nothing sexual, on anyone's face.
6. **The climax.** When the face is complete (`reel_face.distortion`: 30 reels and 180 s watched, so about three
   minutes) all the damage clears and it becomes the person, for three seconds. Then it fractures, fast, bursting
   back into the shards it was made of, with a digital scream.
7. **Dark**, for three seconds.
8. **Their face comes back**, a still from that moment, with a QR code underneath to take it away. It stays for
   45 s or until they've gone, then the screen goes dark and everything is wiped.

**Leaving early:** if nobody's there and the phone's gone for 10 s, the visit is over and everything made of it
is wiped. **Reset** (editor, or R on a screen) does the same at once. Someone told to leave who stays only
starts again after 30 s.

**Their scream:** made on the spot; put a recording at `voice/scream.wav` and that plays instead.

**The QR code** needs the visitor's phone on the same network as this computer. The simplest way is to turn on
Windows' **Mobile hotspot** and put the network's name on the wall label, or use venue Wi-Fi if it lets devices
reach each other. Windows may ask to allow Python through its firewall the first time: allow it. With no
network there's no code, and their face shows on its own.

## The face

- **Live, never a model.** MediaPipe's Face Landmarker tracks the participant on the face camera, on a thread
  of its own, and the face is drawn from their 478 live points each frame: turns, tilts, blinks, where
  they look. Its skin always comes from the very camera picture the points were found in. It is centred
  and fills the frame (**Face fills % of height** on the source).
- **Two feeds in one.** The reels give the skin its colour and texture; the live face gives it its light and
  dark, more as it forms. The eyes and mouth come through live, so they're findable at every intensity.
- **Hair and ears.** No model gives points for hair or ears, so round the face there's a shape in 3D moved
  by the face's own tracked points, on every new picture: a shallow dome the size of a head, flat beyond it,
  with a patch for each ear. It turns and tilts with the face, and fragments stay on it. It's the same for
  everyone and only gives the fragments something to turn on. A second model (MediaPipe's multi-class selfie
  model, also saved in `web/vendor/mediapipe`) finds this person's hair and skin on the live picture, on its
  own thread, about once a second, and only what falls on them shows, so the outline is always theirs.
  Between looks the outline moves and tilts with the head, but doesn't turn. Dark hair is evened out by its
  own brightness, so its light and dark still show. It only starts once the face is forming. From a camera
  looking up you'll mostly get hair at the sides and fringe, not the top of the head.
- **Tracking lost:** it holds the last pose and skin, and says "TRACKING LOST". It never animates by itself.
- **No face camera chosen:** a recorded clip plays instead (`reel_face.test_face_clip`, your own face clip),
  labelled on screen "TEST TRACKING · RECORDED CLIP, NOT A LIVE CAMERA". Never a still presented as live.

## The look editor (/look)

Open http://localhost:8765/look (or **Look** at the top of the setup editor). The face fills the middle,
live, exactly as the Reel face screen shows it, with the participant blurred behind the glass cards round
it. Every setting of its look has two values, one for the first reels and one for the full face, and the
face slides from one to the other as it forms, so the look itself tells the story.

- **The face is the control.** Drag across it to move through its formation, from the first reel (left)
  to the full face (right); scroll over it to nudge; double-click it to go back to the visit's own
  progress. Every screen follows. The **Formation** chart along the bottom does the same, and shows the
  open group's settings across the formation, a tick where each reel took the face, and where it is now.
- **Settings** (right), one group at a time: each is a ramp. Drag its left dot (first reels) or right dot
  (full face) up or down; double-click a number to type it. The big number is its value now. Click a name
  to put its dots on the chart too, where they're bigger. **Hold a name** to see that effect alone (only on
  this page: nothing is saved).
- **Visit** (left): the stage, the face camera's picture, live (only on this page, never on the exhibit's
  screens), a choice of face camera and how it's doing, whether a face and the phone are there, and **Phone
  placed**, **+5 reels**, **Clear face** and **Reset**, so you can tune it with no other page open (the
  preview tracks the face camera like a screen). The face only appears once the phone is placed and reels
  arrive, so the next button to press is lit. **Desire** with the reels, fragments, how much of the face is covered, a box per
  reel, and the word it just said.
- Changes save as you drag and reach every screen at once. **Looks:** **Save as…** keeps the look under a
  name; click a saved look to load it (the one in use is lit); **Defaults** returns to the starting look.
- **Background:** the colour behind the face: **Layout's** (the Reel face source's own), black, white or
  any colour. The words switch to a readable colour if the background would swallow them.

| Group | Settings |
| --- | --- |
| Energy | **Shard size** (they also follow Fragment size, and their raggedness follows Torn edges), **Pull** (how much of the cloud each fragment pulls in), **Mixing** (how far a shard crossing the face takes on its picture), **Crumbling** (how much the face's edges break into blocks), **Shedding** (how fast the face gives shards back), **Flow**, **Spread**, **Colour**, **Brightness** |
| Formation | **Fragments per reel**, **Fragment size**, **Torn edges** (these cut the pieces as each reel arrives: Clear face and add test reels to see a change), **Faintness**, **Likeness** (how much of the live face's light and dark the reels take) |
| Liquid | **Melt** (the face's shape flowing), **Flow** (the picture dragged along a slow swirl, block by block: the datamosh), **Flow speed**, **Swirl size**, **Block size**, **Trails** (how long the old picture hangs on and smears) |
| Pixels | **Pixel size**, **JPEG damage** (on screen, and each new piece saved as a worse JPEG), **Stretched rows**, **Colour bleed** |
| Light and colour | **Gloss lines** (wet, waxy highlights where the surface ripples), **Heat colour** (a heat camera's orange, yellow and green), **Flush** (the fever of wanting, more with desire) |
| Breaking | **Fracture** (pieces pulled apart and sliding), **Holes** (pieces missing), **Dripping edges** |
| Hair and ears | **Show hair and ears** (0 at both ends switches them off, and the second model with them), **Fragments per reel**, **Fragment size**, **Likeness** (how much of the real hair's light and dark the reels take) |

**Changing the words:** `config.yaml`, `reel_face.voice.words`: one list per stage of desire. How often:
`gap_seconds`. **Recorded words:** put `more.wav`, `again.wav`, `one-more.wav`, `dont-stop.wav`... in
`voice/` and those play instead of the computer's voice (the mouth then follows the recording's
loudness). The oracle's lines are in `journey.oracle`.

## Setting it up

- **Phone camera:** the camcorder or a webcam looking down at the platform: the editor's Detection panel.
  Lock the phone's position once the platform is set (below).
- **Face camera:** a second camera at the platform, looking up: people look down at their phones, so from
  there it sees them square on. Choose it in the editor's **Face camera** panel. It can't be the phone
  camera.
- **Screens:** **Reel face** (the face, full screen on a plain background, with the oracle's words along
  the bottom, sound on for the voices) is the main screen. **Operator** shows what the phone tracker sees.
  **CRT** shows a camera. The fullscreen windows are opened with autoplay allowed, so the voices play
  without anyone clicking.

## The editor

The setup editor (http://localhost:8765/editor, or **Setup** at the top of the look editor): the preview in
the middle, sources on the right, and three tabs on the left: **Screens**, **Visit** (the journey and the
reel face, run by hand) and **Cameras** (the phone tracker, the face camera, every camera's settings).
**Preview** at the top shows the screen live or at any stage.

- **Screens:** one per output. Each has a size, background, **Sound**, a monitor, and **Open fullscreen**.
- **Sources:**

  | Source | What it shows |
  | --- | --- |
  | Reel face | The participant's face, live, forming, speaking |
  | Oracle | The oracle's words, typed out, and spoken on screens with sound |
  | Camera | A camera, with an optional VHS overlay |
  | Text, Colour | Plain text or a block of colour |
  | Detection view | What the phone tracker sees |

  Each source has **Show during** (the journey's stages, like OBS scenes) and **Opacity**.
- **Preview:** the screen live, or as it looks at any stage.
- **Journey:** the stage, whether a face and the phone are there, what the oracle is saying. **Phone placed**
  stands in for the phone (press again to leave it to the tracker). **Reset** wipes everything.
- **Face camera:** which camera faces the participant.
- **Reel face:**
  - Reels formed and waiting, tiles, seconds watched, progress and desire.
  - **+1 test reel** and **+5 test reels** (once the phone is placed) feed in reels as if they'd been
    watched: stills from pictures or videos you put in `tests/reels/`, or made-up "TEST REEL" cards.
  - **Clear face** empties the face; the visit goes on.
  - **Pause speech** and **Mute** (mute keeps the mouth moving and the words showing).
  - **Save a still** saves the face as it is now as a PNG, with this browser (editor only: for documenting
    yourself, or people who've agreed).
  - **History** shows the face as it was after any reel; **Live** returns.
  - **Formed** sets how far formed it looks (its look and desire) by hand; **Auto** follows the session.
    The look itself is tuned in the look editor.
- **Detection** and **Cameras:** as before (below).

Moving and resizing: drag a source to move it, or drag its handles to resize it. Edges snap; hold Alt to
stop snapping and Shift to keep the shape. Arrows nudge, Delete removes, Ctrl+Z undoes.

**Keys on a screen:**

| Key | What it does |
| --- | --- |
| D | Debug readout (stage, reels, desire, the face's mouth, cameras) |
| P | Phone placed / back to the tracker |
| R | Reset |
| T | One test reel |

## The phone tracker (swipe detection)

**Finding the screen** works at any angle. The finder looks for a lit area with four straight edges and a
dark bezel just outside them. Lines are fitted to the edges, so tilt, rotation, rounded screen corners and
a thumb across an edge don't throw it. **Tracking** then follows the screen from frame to frame cheaply.

**Swipes:** the screen is straightened into a small upright picture, and the detector measures how far the
whole picture moved between frames (phase correlation). A swipe moves the whole screen; a video playing on
it doesn't. It handles scene cuts, half-swipes that spring back, fast swipes, dark reels and a thumb joining
the outline. On the synthetic clips it catches 17/17 and 21/25 swipes (`tools/detect_clip.py`).

**Reel stills:** while a reel plays, a still of the phone screen is taken every 0.3 s, straightened, on a
thread of its own, so tracking never waits. Blurry is fine.

**Exposure matters.** Set each camera's exposure in the editor's Cameras panel. On the Logi webcam, a manual
1/64 s doubled the frame rate and stopped the screen washing out.

**Lock the phone position** in the Detection panel once the phone sits on the platform, or **Click the
phone's corners** on a Detection view. Frame the whole phone, with a margin.

## Tools

```powershell
$python = "$env:USERPROFILE\.venvs\reel-life\Scripts\python.exe"
& $python tools\record.py                    # record clips: R starts and stops a clip, Q quits (stop the eye first)
& $python tools\detect_clip.py <clip.avi>    # run the detector on a clip and list every swipe
& $python tools\make_test_clip.py --seed 6   # a synthetic phone-scrolling clip with known swipe times (--handheld: the phone moves)
& $python tools\test_screen_finder.py        # score the screen finder on 400 synthetic phones at random angles
& $python tools\make_footage_demos.py        # demo videos and an angle sheet for presenting, into footage/demos
& $python tools\list_cameras.py              # every camera and monitor the eye can see
```

## Footage for presenting

`footage/` holds recordings for the submission (see `footage/README.md`): demos made from the synthetic
clips, and your own test sessions recorded with **● Record footage** in the Detection panel (the phone
camera only).

## Privacy

- **Local only.** The eye only serves its pages on this computer (127.0.0.1), and MediaPipe runs inside the
  page. Nothing goes online. The one exception is on the local network: a tiny second site (`still.port`)
  that serves nothing but a visitor's still, at a link nobody could guess.
- **Nothing about a visit is saved.** The face camera's pictures go to the screens live and are dropped.
  The reels' stills, the tiles, the history and the face exist only in memory, for one visit, and are wiped
  when it ends, when a new one starts (visits are counted, so even one that starts the instant the last
  ends gets a clean slate), or on reset.
- **The visitor's still** is held in memory only, for up to five minutes, and deleted as soon as a new visit
  starts. The QR code is on a public screen, so anyone standing there could scan it while it shows.
- **Saved only when you ask:** **Save a still** and **Record footage** (the phone camera) in the editor,
  and `tools/record.py`, for your own documentation.
- **Consent:** visitors aren't told the face will form, by design, and the camera reads their phone's screen,
  notifications included. A sign at the entrance keeps the surprise while being honest: that a camera sees them
  and their phone's screen, shown on screen and kept for nobody unless they scan the code.

## Hardware notes

- The capture card is a MacroSilicon MS2130 ("USB3 Video", HDMI in): 720×480 at up to 60 fps.
- Set the converter in front of it to **AV**. It shows a blue screen with "SV" or "AV" when it has no input.
- **Turn off the camcorder's power save** and its date and time display.
- The camcorder's menus show on the AV output, so focus and exposure can be set with the LCD broken.
