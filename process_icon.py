"""Turn the source banner image into transparent-background extension icons.

Steps:
  1. Load the source, convert to RGBA.
  2. Find the mouse's bounding box = pixels that are NOT near-white.
  3. Crop to that box (with a small margin), padded to a square.
  4. Make near-white pixels transparent (with a soft alpha ramp so edges/anti-
     aliasing don't leave a white halo).
  5. Export icon16 / icon48 / icon128 (high-quality Lanczos resize).
"""
import sys
from PIL import Image

SRC = "icons/WhatsApp Image 2026-07-12 at 8.01.45 AM.jpeg"
OUT_SIZES = (16, 48, 128)

# A pixel counts as "background" when it's this close to white.
WHITE_CUTOFF = 238   # >= this on all channels -> fully transparent
SOFT_START = 205     # between SOFT_START..WHITE_CUTOFF -> partial alpha ramp

def near_white_min_channel(px):
    """Return the min RGB channel; high value == light pixel."""
    return min(px[0], px[1], px[2])

def main():
    img = Image.open(SRC).convert("RGBA")
    W, H = img.size
    print(f"source size: {W}x{H}")
    px = img.load()

    # --- 1. bounding box of non-white content ---
    minx, miny, maxx, maxy = W, H, 0, 0
    for y in range(H):
        for x in range(W):
            if near_white_min_channel(px[x, y]) < SOFT_START:
                if x < minx: minx = x
                if y < miny: miny = y
                if x > maxx: maxx = x
                if y > maxy: maxy = y
    if minx > maxx or miny > maxy:
        print("ERROR: no content found (image looks all-white)")
        sys.exit(1)
    print(f"content bbox: ({minx},{miny}) -> ({maxx},{maxy})")

    # --- 2. square crop with margin ---
    cw = maxx - minx + 1
    ch = maxy - miny + 1
    side = max(cw, ch)
    margin = int(side * 0.12)              # breathing room around the mouse
    side += margin * 2
    cx = (minx + maxx) // 2
    cy = (miny + maxy) // 2
    left = cx - side // 2
    top = cy - side // 2
    # Crop can extend past edges; Image.crop fills those with... nothing, so
    # clamp then paste onto a transparent square of the intended side length.
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    src_left = max(left, 0)
    src_top = max(top, 0)
    src_right = min(left + side, W)
    src_bottom = min(top + side, H)
    region = img.crop((src_left, src_top, src_right, src_bottom))
    square.paste(region, (src_left - left, src_top - top))
    print(f"square canvas: {side}x{side}")

    # --- 3. background -> transparent (soft ramp) ---
    sq = square.load()
    for y in range(side):
        for x in range(side):
            r, g, b, a = sq[x, y]
            if a == 0:
                continue
            m = min(r, g, b)
            if m >= WHITE_CUTOFF:
                sq[x, y] = (r, g, b, 0)
            elif m >= SOFT_START:
                # linear ramp: SOFT_START -> alpha 255, WHITE_CUTOFF -> alpha 0
                frac = (m - SOFT_START) / (WHITE_CUTOFF - SOFT_START)
                sq[x, y] = (r, g, b, int(255 * (1 - frac)))

    # --- 4. export sizes ---
    for s in OUT_SIZES:
        out = square.resize((s, s), Image.LANCZOS)
        path = f"icons/icon{s}.png"
        out.save(path)
        print(f"wrote {path}")

    # Also keep a full-res transparent master for future use.
    square.save("icons/icon-master.png")
    print("wrote icons/icon-master.png")

if __name__ == "__main__":
    main()
