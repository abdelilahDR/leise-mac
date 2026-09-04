#!/usr/bin/env python3
"""Generate the tray glyph (template + state variants) into src/icons.

The glyph is the middle three lenses of the app mark. The full five-lens mark is
much wider than tall, which does not fit a 16pt square; the middle three are
almost exactly square (27.7 x 27.7 in the tile's 66pt space) and keep the
off-centre peak, so the menu bar and the Dock read as the same mark.

Two optical corrections for the size. The lenses are spread apart by SPREAD:
at 16px their real gap works out under one pixel and they fuse into a blob.
And the glyph fills COVER of the box rather than all of it, to sit correctly
against the other menu bar items.

Idle and transcribing are template images: black plus alpha, which macOS
recolours for light and dark menu bars and inverts on highlight. Recording is
red on purpose, and dev is blue so an unpackaged build is unmistakable next to
the installed app.

Recording and transcribing alternate two frames. The frames differ in lens
heights rather than in opacity, so the mark looks like it is moving rather than
blinking.

Run from the repo root:  python3 scripts/make-tray-icons.py
"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "src", "icons")

# The five lenses of the app mark, in the tile's 66pt space. Source of truth:
# assets/icon/svg/leise-light.svg. Only the middle three are used here.
LENSES = [
    (13.9815, 32.9999, 2.98148, 6.22596),
    (22.7913, 33.0002, 3.63317, 11.3464),
    (32.9069, 32.9998, 4.28718, 13.8368),
    (43.1155, 33.0000, 3.72626, 9.68456),
    (52.0185, 32.9999, 2.98148, 6.22596),
]
MID = LENSES[1:4]
CENTRE = 32.9069

COVER = 0.78   # fraction of the icon box the glyph spans
SPREAD = 1.14  # gap widening, so the lenses stay separate at 1x
SS = 8         # supersample factor

BLACK = (0, 0, 0, 255)
RED = (255, 59, 48, 255)
BLUE = (0, 122, 255, 255)

# Frame b squashes the tall centre and lifts the flanks: the wave moves.
FRAME_B_SCALE = (1.34, 0.62, 1.18)


def with_alpha(color, alpha):
    return (color[0], color[1], color[2], int(255 * alpha))


def lenses_for(frame):
    out = []
    for i, (cx, cy, rx, ry) in enumerate(MID):
        k = FRAME_B_SCALE[i] if frame == "b" else 1.0
        out.append((CENTRE + (cx - CENTRE) * SPREAD, cy, rx, ry * k))
    return out


def draw_mark(size, color, frame="a"):
    """The glyph on a size x size canvas, drawn at SSx and downsampled."""
    lenses = lenses_for(frame)
    x0 = min(cx - rx for cx, _, rx, _ in lenses)
    x1 = max(cx + rx for cx, _, rx, _ in lenses)
    # Both frames share the frame-a extent, so the glyph does not jump between
    # frames — only the individual lenses move.
    base = lenses_for("a")
    y0 = min(cy - ry for _, cy, _, ry in base)
    y1 = max(cy + ry for _, cy, _, ry in base)
    w, h = x1 - x0, y1 - y0
    k = (size * COVER) / max(w, h)

    canvas = size * SS
    im = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    offx = (size - w * k) / 2 - x0 * k
    offy = (size - h * k) / 2 - y0 * k
    for cx, cy, rx, ry in lenses:
        d.ellipse(
            [((cx - rx) * k + offx) * SS, ((cy - ry) * k + offy) * SS,
             ((cx + rx) * k + offx) * SS, ((cy + ry) * k + offy) * SS],
            fill=color,
        )
    return im.resize((size, size), Image.LANCZOS)


def save(name, color, frame="a"):
    draw_mark(16, color, frame).save(os.path.join(OUT, f"{name}.png"))
    draw_mark(32, color, frame).save(os.path.join(OUT, f"{name}@2x.png"))


def main():
    os.makedirs(OUT, exist_ok=True)
    save("tray-mic-idle", BLACK)              # template, macOS tints it
    save("tray-mic-dev", BLUE)                # unpackaged marker
    save("tray-mic-rec-a", RED, "a")          # recording, wave moving
    save("tray-mic-rec-b", RED, "b")
    save("tray-mic-tx-a", BLACK, "a")         # working, template
    save("tray-mic-tx-b", BLACK, "b")
    print("wrote 12 icons to", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
