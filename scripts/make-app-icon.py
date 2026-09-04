#!/usr/bin/env python3
"""Compose build/icon.png (1024, for electron-builder) from the Figma tile.

The tile is the source artwork, exported from the Leise Figma file at 1024
and kept in assets/icon/. This script does not redraw it: reinterpreting the two
washes and their gradient transforms in code would drift from the source. It
only places the tile on the macOS icon grid.

Apple's grid puts the rounded-square content at 824pt inside a 1024pt canvas
with a transparent margin, so a full-bleed tile would sit visibly larger than
every neighbour in the Dock. The tile's own 20/66 corner ratio is preserved
by scaling, not redrawn.

Run from the repo root:  python3 scripts/make-app-icon.py
"""
import os
import sys
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), "..")
SRC = os.path.join(ROOT, "assets", "icon", "leise-light-1024.png")
OUT = os.path.join(ROOT, "build", "icon.png")

CANVAS = 1024
CONTENT = 824  # Apple icon grid: content square inside the 1024 canvas


def main():
    if not os.path.exists(SRC):
        sys.exit("missing source tile: %s\nExport it from the Leise Figma file first." % SRC)

    tile = Image.open(SRC).convert("RGBA")
    if tile.size != (CANVAS, CANVAS):
        sys.exit("expected a %dx%d source, got %s" % (CANVAS, CANVAS, tile.size))

    tile = tile.resize((CONTENT, CONTENT), Image.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    off = (CANVAS - CONTENT) // 2
    canvas.alpha_composite(tile, (off, off))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    canvas.save(OUT)
    print("wrote", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
