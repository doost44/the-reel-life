"""List the cameras and monitors the eye can see.

    python tools/list_cameras.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from eye import cameras, monitors  # noqa: E402

names = cameras.list_cameras()
print("Cameras (OpenCV number: name)")
for index, name in enumerate(names):
    print(f"  {index}: {name}")
if not names:
    print("  none found. Is the camera allowed? (Mac)" if sys.platform == "darwin" else "  none found. Is ffmpeg installed and on PATH?")

print("\nMonitors")
for monitor in monitors.list_monitors():
    main = "  (main)" if monitor["primary"] else ""
    print(f"  {monitor['label']}: {monitor['width']}x{monitor['height']} at ({monitor['x']}, {monitor['y']}){main}")
