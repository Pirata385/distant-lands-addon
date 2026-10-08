#!/usr/bin/env python3
"""Generates the pack images (deterministic): LOD particle textures, the Horizon Lens item icon and pack icons.

Usage: python3 -I scripts/gen-images.py <repo root>
"""
import math
import os
import random
import sys

from PIL import Image, ImageDraw


def save(img, *parts):
    path = os.path.join(*parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)


def lod_textures(root):
    rng = random.Random(42)
    noise = Image.new("RGBA", (16, 16))
    for y in range(16):
        for x in range(16):
            v = 255 - int(rng.random() * 16) - (6 if (x + y) % 5 == 0 else 0)
            noise.putpixel((x, y), (v, v, v, 255))
    flat = Image.new("RGBA", (16, 16), (255, 255, 255, 255))
    rp = os.path.join(root, "packs", "resource_pack")
    save(noise, rp, "textures", "particle", "dl_lod.png")
    save(noise, rp, "subpacks", "standard", "textures", "particle", "dl_lod.png")
    save(flat, rp, "subpacks", "smooth", "textures", "particle", "dl_lod.png")


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def lens_icon(root):
    img = Image.new("RGBA", (16, 16), (0, 0, 0, 0))
    cx, cy, r = 7.5, 7.0, 6.2
    for y in range(16):
        for x in range(16):
            d = math.hypot(x - cx, y - cy)
            if d <= r - 1.2:
                # Sky gradient with layered distant hills (darker = nearer).
                sky = lerp((120, 175, 255, 255), (200, 225, 255, 255), y / 14)
                hill1 = 8.5 + 1.2 * math.sin(x * 0.9)
                hill2 = 10.0 + 1.0 * math.sin(x * 0.6 + 1.5)
                col = sky
                if y > hill1:
                    col = (140, 170, 150, 255)
                if y > hill2:
                    col = (76, 140, 70, 255)
                img.putpixel((x, y), col)
            elif d <= r:
                img.putpixel((x, y), (222, 170, 60, 255) if (x + y) % 3 else (176, 120, 40, 255))
    # Handle.
    for i in range(3):
        img.putpixel((12 + i, 12 + i) if 12 + i < 16 else (15, 15), (110, 80, 45, 255))
        if 13 + i < 16:
            img.putpixel((12 + i, 13 + i), (80, 55, 30, 255))
    save(img, root, "packs", "resource_pack", "textures", "items", "dl_horizon_lens.png")


def pack_icon(root):
    size = 256
    img = Image.new("RGBA", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        d.line([(0, y), (size, y)], fill=lerp((96, 150, 235, 255), (205, 228, 255, 255), y / size))
    # Far-to-near ridges drawn as LOD steps: farther = bigger steps and paler colour.
    layers = [
        (32, 112, (176, 200, 214), 9),
        (16, 140, (130, 170, 150), 21),
        (8, 170, (92, 150, 84), 33),
        (4, 202, (70, 128, 58), 47),
    ]
    rng = random.Random(7)
    for step, base, col, seed in layers:
        phase = rng.random() * 6
        for x0 in range(0, size, step):
            xm = x0 + step / 2
            h = base + 18 * math.sin(xm / 37 + phase + seed) + 10 * math.sin(xm / 13 + seed)
            h = int(round(h / 4) * 4)
            d.rectangle([x0, h, x0 + step - 1, size], fill=col + (255,))
            d.rectangle([x0, h, x0 + step - 1, h + max(1, step // 8)], fill=lerp(col, (255, 255, 255), 0.18) + (255,))
    # Water band.
    d.rectangle([0, 232, size, size], fill=(52, 104, 196, 255))
    for root_pack in ("resource_pack", "behavior_pack"):
        save(img, root, "packs", root_pack, "pack_icon.png")


def main(argv):
    root = argv[1] if len(argv) > 1 else "."
    lod_textures(root)
    lens_icon(root)
    pack_icon(root)
    print("images generated")


if __name__ == "__main__":
    main(sys.argv)
