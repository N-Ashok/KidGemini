#!/usr/bin/env python3
"""Re-paint the Kenney Blocky Characters atlas into sports kits (2026-07-26,
docs/2026-07-26_PRD_SportsAssets.md §2.2; cricket whites added 2026-07-29,
docs/2026-07-29_PRD_CricketAssets.md).

Input: the kit's texture-b.png (character-b, "man": red top + blue jeans).
Outputs (deterministic — the append-only asset host depends on stable bytes):
  footballer       — red jersey kept, jeans re-painted white (shorts/socks)
  footballer_blue  — jersey re-hued blue, jeans re-painted white
  cricketer        — BOTH jersey and jeans drained to white (cricket whites)

Color rules were measured off the actual atlas (probe session 2026-07-26):
  jersey red  hue ~355-360, sat ~0.67   → cleanly separable from
  skin        hue ~17-22,   sat ~0.53-0.55
  jeans blue  hue ~227,     sat ~0.54   → cleanly separable from
  hair        hue ~240,     sat ~0.13 (low sat ⇒ untouched)
Shading survives because only hue/sat move; value is preserved.

Usage: retexture-footballer.py <in.png> <out.png> red|blue|whites
"""
import colorsys
import sys

from PIL import Image

JERSEY_HUE_MIN, JERSEY_HUE_MAX = 330 / 360, 12 / 360  # wraps through 0
JERSEY_SAT_MIN = 0.40
JEANS_HUE_MIN, JEANS_HUE_MAX = 200 / 360, 250 / 360
JEANS_SAT_MIN = 0.30
BLUE_KIT_HUE = 222 / 360


def is_jersey(h: float, s: float) -> bool:
    return s >= JERSEY_SAT_MIN and (h >= JERSEY_HUE_MIN or h <= JERSEY_HUE_MAX)


def is_jeans(h: float, s: float) -> bool:
    return s >= JEANS_SAT_MIN and JEANS_HUE_MIN <= h <= JEANS_HUE_MAX


def main() -> None:
    src, dest, kit = sys.argv[1], sys.argv[2], sys.argv[3]
    if kit not in ("red", "blue", "whites"):
        raise SystemExit(f"kit must be red|blue|whites, got {kit!r}")
    im = Image.open(src).convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            hue, sat, val = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if is_jeans(hue, sat):
                # Jeans → white shorts and socks: drain the color, lift the
                # value a touch, keep the shading gradient.
                nr, ng, nb = colorsys.hsv_to_rgb(hue, sat * 0.06, min(val * 1.25, 0.96))
            elif kit == "whites" and is_jersey(hue, sat):
                # Cricket whites: same drain as the trousers above, so top and
                # bottom match. Value is preserved, so Kenney's baked shading
                # (and therefore the fold/crease detail) survives.
                nr, ng, nb = colorsys.hsv_to_rgb(hue, sat * 0.06, min(val * 1.25, 0.96))
            elif kit == "blue" and is_jersey(hue, sat):
                nr, ng, nb = colorsys.hsv_to_rgb(BLUE_KIT_HUE, sat, val)
            else:
                continue
            px[x, y] = (round(nr * 255), round(ng * 255), round(nb * 255), a)
    im.save(dest, format="PNG", optimize=False)


if __name__ == "__main__":
    main()
