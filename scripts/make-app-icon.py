#!/usr/bin/env python3
"""Generate the Leise app icon into build/icon.png (1024, for electron-builder).

The Dot + Arc mark: the mic reduced to two shapes, the red dot as the voice.
Ink squircle with a restrained vertical gradient per macOS icon convention;
margins follow the Apple icon grid (content squircle 824pt inside 1024).

Run from the repo root:  python3 scripts/make-app-icon.py
"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "build", "icon.png")

S = 4  # supersample factor
CANVAS = 1024
SQ = 824          # squircle size on the Apple grid
RADIUS = 185      # ~22.5% of the squircle side
GRAD_TOP = (39, 39, 43)
GRAD_BOTTOM = (21, 21, 24)
INK = (242, 242, 244, 255)
RED = (255, 59, 48, 255)


def squircle_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def main():
    c = CANVAS * S
    sq = SQ * S
    im = Image.new("RGBA", (c, c), (0, 0, 0, 0))

    # gradient plate
    plate = Image.new("RGBA", (sq, sq))
    for y in range(sq):
        t = y / sq
        r = int(GRAD_TOP[0] + (GRAD_BOTTOM[0] - GRAD_TOP[0]) * t)
        g = int(GRAD_TOP[1] + (GRAD_BOTTOM[1] - GRAD_TOP[1]) * t)
        b = int(GRAD_TOP[2] + (GRAD_BOTTOM[2] - GRAD_TOP[2]) * t)
        ImageDraw.Draw(plate).line([(0, y), (sq, y)], fill=(r, g, b, 255))
    plate.putalpha(squircle_mask(sq, RADIUS * S))
    off = (c - sq) // 2
    im.alpha_composite(plate, (off, off))

    # the mark, drawn on the full canvas grid (values are 1024-grid * S)
    d = ImageDraw.Draw(im)
    # The shipped tray glyph's exact geometry (16 grid), scaled by F onto the
    # icon: capsule x6-10 y1.8-9.2 r2, cradle c(8,7.6) r4.4 w1.4, stem 12-14.2.
    # The capsule carries the red: the voice inside the mic.
    F = 52 * S
    def gx(u): return int((u - 8) * F + 512 * S)
    def gy(u): return int((u - 8) * F + 512 * S)
    d.rounded_rectangle([gx(6), gy(1.8), gx(10), gy(9.2)], radius=2 * F, fill=RED)
    stroke = int(1.4 * F)
    r = 4.4 * F
    cx, cy = gx(8), gy(7.6)
    d.arc([cx - r, cy - r, cx + r, cy + r], start=0, end=180, fill=INK, width=stroke)
    cap = stroke // 2
    for x in (cx + r, cx - r):
        d.ellipse([x - cap, cy - cap, x + cap, cy + cap], fill=INK)
    d.line([cx, gy(12), cx, gy(14.2)], fill=INK, width=stroke)
    for y in (gy(12), gy(14.2)):
        d.ellipse([cx - cap, y - cap, cx + cap, y + cap], fill=INK)

    final = im.resize((CANVAS, CANVAS), Image.LANCZOS)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    final.save(OUT)
    print("wrote", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
