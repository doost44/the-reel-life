# OpenCV.js

OpenCV 4.10 for the browser (npm `@techstark/opencv-js@4.10.0-release.1`,
`dist/opencv.js`, Apache 2.0: see LICENSE). The Chrome version of the eye
(web/js/eye/) runs the phone tracker with it, as the Python eye does with
opencv-python. Saved here so the exhibit runs offline.

Its `cv` object has a `then` that resolves to itself: wait for
`cv.onRuntimeInitialized` instead of `await cv`, which never ends.
