#!/usr/bin/env python3
"""Generate the tray mic icons (template + state variants) into src/icons.

Draws the mic glyph from the design proposal at 4x and downsamples for clean
antialiasing. Idle and working are template-style (black + alpha, macOS tints
them); recording is red on purpose; dev is blue so an unpackaged test build is
unmistakable next to the installed app.

Run from the repo root:  python3 scripts/make-tray-icons.py
"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "src", "icons")

BLACK = (0, 0, 0, 255)
RED = (255, 59, 48, 255)
BLUE = (0, 122, 255, 255)


def with_alpha(color, alpha):
    return (color[0], color[1], color[2], int(255 * alpha))


def draw_mic(size, color):
    """Mic glyph on a size x size canvas, drawn at 4x and downsampled.

    Geometry on the 16 grid (matches the SVG in the proposal):
    capsule x6 y1.8 w4 h7.4 r2 · cradle arc c(8,7.6) r4.4 lower half ·
    stem (8,12)-(8,14.2) · strokes 1.4.
    """
    s = size * 4 / 16.0  # 16-grid unit at 4x
    canvas = size * 4
    im = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)

    d.rounded_rectangle([6 * s, 1.8 * s, 10 * s, 9.2 * s], radius=2 * s, fill=color)

    stroke = int(round(1.4 * s))
    cx, cy, r = 8 * s, 7.6 * s, 4.4 * s
    d.arc([cx - r, cy - r, cx + r, cy + r], start=0, end=180, fill=color, width=stroke)
    d.line([8 * s, 12 * s, 8 * s, 14.2 * s], fill=color, width=stroke)
    # round caps for the stem
    cap = stroke / 2
    d.ellipse([8 * s - cap, 12 * s - cap, 8 * s + cap, 12 * s + cap], fill=color)
    d.ellipse([8 * s - cap, 14.2 * s - cap, 8 * s + cap, 14.2 * s + cap], fill=color)

    return im.resize((size, size), Image.LANCZOS)


def save(name, color):
    draw_mic(16, color).save(os.path.join(OUT, f"{name}.png"))
    draw_mic(32, color).save(os.path.join(OUT, f"{name}@2x.png"))


def main():
    os.makedirs(OUT, exist_ok=True)
    save("tray-mic-idle", BLACK)                     # template, macOS tints it
    save("tray-mic-dev", BLUE)                       # unpackaged marker
    save("tray-mic-rec-a", RED)                      # recording pulse frames
    save("tray-mic-rec-b", with_alpha(RED, 0.45))
    save("tray-mic-tx-a", BLACK)                     # working pulse frames (template)
    save("tray-mic-tx-b", with_alpha(BLACK, 0.45))
    print("wrote 12 icons to", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
