#!/usr/bin/env python3
"""Compose build/icon.png (1024, for electron-builder) from the Figma tile.

The tile is the source artwork, exported from the Leise Figma file at 1024 and
kept in assets/icon/. This script does not redraw it: reinterpreting the two
washes and their gradient transforms in code would drift from the source.

macOS 26 masks every app icon into its own container shape and draws it edge to
edge, so the source here is the full-bleed square export — no rounding, no
margin. The pre-Tahoe grid (824pt content inside a 1024pt canvas) is wrong on
26: the system plate is drawn anyway and the inset artwork floats inside it.
The rounded tile lives on in assets/icon/ for the UI, where we draw the corner
ourselves.

Run from the repo root:  python3 scripts/make-app-icon.py
"""
import os
import sys
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), "..")
SRC = os.path.join(ROOT, "assets", "icon", "leise-light-fullbleed-1024.png")
OUT = os.path.join(ROOT, "build", "icon.png")

CANVAS = 1024


def main():
    if not os.path.exists(SRC):
        sys.exit("missing source tile: %s\nExport it from the Leise Figma file first." % SRC)

    tile = Image.open(SRC).convert("RGBA")
    if tile.size != (CANVAS, CANVAS):
        sys.exit("expected a %dx%d source, got %s" % (CANVAS, CANVAS, tile.size))
    if tile.split()[-1].getbbox() != (0, 0, CANVAS, CANVAS):
        sys.exit("source is not full-bleed: it has transparent edges, so macOS 26 "
                 "would draw its container around it")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tile.save(OUT)
    print("wrote", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
