"""Build the Chrome Web Store package with manifest.json at the archive root."""

import json
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "manifest.json").read_text(encoding="utf-8"))["version"]
default_destination = root / "dist" / f"linux-do-reader-{version}.zip"
destination = Path(sys.argv[1]).expanduser().resolve() if len(sys.argv) == 2 else default_destination

assets = (
    "LICENSE",
    "NOTICE",
    "README.md",
    "PRIVACY.md",
    "manifest.json",
    "background.js",
    "forum.js",
    "navigation.js",
    "discussions.js",
    "scrolling.js",
    "live.js",
    "native.js",
    "reader.js",
    "reader.css",
    "image-preview.js",
    "image-preview.css",
    "polls.js",
    "polls.css",
    "launcher.css",
    "icon.png",
    "symbols.png",
)
destination.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
    for name in assets:
        archive.write(root / name, name)
print(destination)
