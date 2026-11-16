"""The look's categories in both eyes, side by side: eye/look.py and its
Chrome copy web/js/eye/look-settings.js (in Node) should make the same default
look, describe the same settings, give the same shares of a visit and push the
same values. Run it after changing either, or category_looks in config.yaml.

    python tools/check_look.py
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from eye import look, settings  # noqa: E402

NODE_SIDE = Path(__file__).with_name("look_settings.mjs")
WEIGHTS = {"Food": 6.4, "Unreadable": 1, "Money / luxury": 2.2}
SHARES = {"Food": 0.7, "Comedy / memes": 0.3}
NAMES = ["gloss", "jpeg", "melt", "bleed", "flush", "fracture", "fragment_size"]


def main() -> None:
    node = shutil.which("node")
    if not node:
        sys.exit("Node.js isn't on PATH.")
    config = settings.load_config()
    default = look.default_look()
    python = {"look": default, "described": look.described(), "shares": look.shares(WEIGHTS),
              "values": [look.value(default, name, 0.4, SHARES) for name in NAMES]}
    given = {"categories": config["category_looks"]["categories"], "weights": WEIGHTS, "shares": SHARES, "names": NAMES}
    chrome = json.loads(subprocess.run([node, str(NODE_SIDE)], input=json.dumps(given), capture_output=True, text=True,
                                       check=True).stdout)
    problems = [key for key in ("look", "described", "shares") if python[key] != chrome[key]]
    for key in ("values", "pushed"):
        if any(abs(a - b) > 1e-9 for a, b in zip(python["values"], chrome[key])):
            problems.append(key)
    print(f"{len(default['categories'])} categories, {len(default['values'])} values.")
    print("Both eyes agree." if not problems else f"They differ: {', '.join(problems)}.")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
