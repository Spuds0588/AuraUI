#!/usr/bin/env python3
"""Decode an `xwd` dump of a 32-bit ARGB window and report where the bright (card) pixels are
and how opaque the window is overall.

The AuraUI window is transparent, so the alpha channel is the scrim: window alpha / 0.72 is
the scrim's opacity, which is what the fade-out is made of.

    xwd.py <file.xwd> [--label text]
"""

import struct
import sys

SCRIM_ALPHA = 0.72


def read_xwd(path):
    with open(path, "rb") as handle:
        raw = handle.read()
    header = struct.unpack(">25I", raw[:100])
    (
        header_size,
        _version,
        pixmap_format,
        _depth,
        width,
        height,
        _xoffset,
        byte_order,
        _bitmap_unit,
        _bitmap_bit_order,
        _bitmap_pad,
        bits_per_pixel,
        bytes_per_line,
        _visual_class,
        _red_mask,
        _green_mask,
        _blue_mask,
        _bits_per_rgb,
        _colormap_entries,
        ncolors,
        _window_width,
        _window_height,
        _window_x,
        _window_y,
        _bdrwidth,
    ) = header
    if pixmap_format != 2:
        raise SystemExit(f"expected ZPixmap (2), got {pixmap_format}")
    offset = header_size + ncolors * 12
    pixels = raw[offset : offset + bytes_per_line * height]
    return width, height, bits_per_pixel, bytes_per_line, byte_order, pixels


def sample(width, height, bytes_per_line, bytes_per_pixel, pixels, x, y):
    start = y * bytes_per_line + x * bytes_per_pixel
    chunk = pixels[start : start + bytes_per_pixel]
    # PIL/ffmpeg style BGRA when the byte order is LSB-first, which is what X11 gives us.
    blue, green, red, alpha = chunk[0], chunk[1], chunk[2], chunk[3]
    return red, green, blue, alpha


def main():
    path = sys.argv[1]
    label = ""
    if "--label" in sys.argv:
        label = sys.argv[sys.argv.index("--label") + 1]

    width, height, bpp, stride, _byte_order, pixels = read_xwd(path)
    if bpp != 32:
        raise SystemExit(f"expected 32 bpp, got {bpp}")
    bytes_per_pixel = bpp // 8

    bright = []  # (y, x) of near-white pixels = the card's text
    opaque = []  # (y, x) of fully opaque pixels = the card's own panel
    corner_alpha = 0
    corner_n = 0
    for y in range(0, height, 2):
        for x in range(0, width, 2):
            red, green, blue, alpha = sample(
                width, height, stride, bytes_per_pixel, pixels, x, y
            )
            if alpha == 255:
                opaque.append((y, x))
            if red > 200 and green > 200 and blue > 200 and alpha > 200:
                bright.append((y, x))
            # A corner is nowhere near the card, so its alpha is the scrim and nothing else.
            if x < 60 and y < 60:
                corner_alpha += alpha
                corner_n += 1

    scrim = corner_alpha / corner_n if corner_n else 0.0
    print(
        f"{label or path}: scrim_alpha={scrim:.0f} "
        f"scrim_opacity={scrim / 255 / SCRIM_ALPHA:.3f} opaque_px={len(opaque)}"
    )

    def describe(name, points):
        if not points:
            print(f"    {name}: none")
            return
        ys = [y for y, _ in points]
        xs = [x for _, x in points]
        centre_y = (min(ys) + max(ys)) / 2
        print(
            f"    {name}: y {min(ys)}..{max(ys)} (box centre {centre_y:.0f})  "
            f"x {min(xs)}..{max(xs)}  "
            f"offset from screen centre = {centre_y - height / 2:+.0f}px"
        )

    describe("panel", opaque)
    describe("text ", bright)


if __name__ == "__main__":
    main()
