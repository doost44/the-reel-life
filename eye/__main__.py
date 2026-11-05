"""Start the eye: python -m eye [--open-editor] [--open-screens]"""

import argparse

from .server import run

parser = argparse.ArgumentParser(prog="python -m eye", description="The Reel Life's camera and screen server.")
parser.add_argument("--port", type=int, help="override server.port in config.yaml")
parser.add_argument("--open-editor", action="store_true", help="open the setup editor in your browser")
parser.add_argument("--open-screens", action="store_true", help="open every screen that has a monitor, fullscreen")
args = parser.parse_args()

run(port=args.port, open_editor=args.open_editor, open_screens=args.open_screens)
