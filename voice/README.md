# Recorded voice

The face's words and the scream, as recordings. Each one plays instead of the browser's generic voice when it's
here, named after the word (`reel_face.voice.clips` in `config.yaml`):

| Word (`reel_face.voice.words`) | File |
| --- | --- |
| more | `more.wav` |
| again | `again.wav` |
| one more | `one-more.wav` |
| don't stop | `dont-stop.wav` |
| more, more | `more-more.wav` |
| the scream at the climax | `scream.wav` |

`.mp3` and `.ogg` work too. A new word in `config.yaml` looks for a file named the same way: lower case, the
apostrophes dropped, anything else that isn't a letter or digit turned into `-`.

Both eyes find them here: the Python eye serves this folder at `/voice`, and the Chrome version (GitHub Pages)
asks for each file. The editor's **Health** panel says how many of them it found.

These are fixed lines with no visitor data in them, so they're committed. A3 phase 4 renders them with the new
British voice (Piper, `en_GB`) and its processing; until then the folder has only this file, and every screen
uses the browser's voice.
