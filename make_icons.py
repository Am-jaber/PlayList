"""Generate icon16/48/128 PNGs with no external dependencies.

Draws a red rounded square with three white horizontal "queue" bars and a small
play triangle -- matching the popup logo. Pure-Python PNG writer (zlib only).
"""
import struct, zlib, os

def png(width, height, pixels):
    """pixels: list of rows, each row a list of (r,g,b,a) tuples."""
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type 0
        for (r, g, b, a) in row:
            raw += bytes((r, g, b, a))
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(bytes(raw), 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")

RED = (255, 0, 0, 255)
WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)

def make(size):
    s = size
    radius = max(2, s // 6)
    px = [[CLEAR for _ in range(s)] for _ in range(s)]

    def in_rounded(x, y):
        # rounded-rectangle test
        if radius <= 0:
            return True
        for (cx, cy) in [(radius, radius), (s-1-radius, radius),
                         (radius, s-1-radius), (s-1-radius, s-1-radius)]:
            if ((x < radius and y < radius) or (x > s-1-radius and y < radius) or
                (x < radius and y > s-1-radius) or (x > s-1-radius and y > s-1-radius)):
                pass
        # simpler: distance from nearest corner center
        nx = min(max(x, radius), s-1-radius)
        ny = min(max(y, radius), s-1-radius)
        dx, dy = x - nx, y - ny
        return dx*dx + dy*dy <= radius*radius

    # fill red rounded square
    for y in range(s):
        for x in range(s):
            if in_rounded(x, y):
                px[y][x] = RED

    # white queue bars + play triangle
    bar_h = max(1, s // 14)
    left = s // 4
    right = s * 3 // 4
    ys = [s * 30 // 100, s * 48 // 100, s * 66 // 100]
    for i, by in enumerate(ys):
        # third bar is shorter to leave room for the play triangle
        r = (s * 58 // 100) if i == 2 else right
        for y in range(by, min(s, by + bar_h)):
            for x in range(left, r):
                if in_rounded(x, y):
                    px[y][x] = WHITE

    # play triangle at bottom-right area of third bar
    tri_x = s * 64 // 100
    tri_top = ys[2] - bar_h
    tri_h = bar_h * 3
    for row in range(tri_h):
        y = tri_top + row
        if 0 <= y < s:
            w = int((1 - abs(row - tri_h/2) / (tri_h/2)) * (s * 12 // 100))
            for x in range(tri_x, tri_x + w):
                if 0 <= x < s and in_rounded(x, y):
                    px[y][x] = WHITE

    return png(s, s, px)

os.makedirs("icons", exist_ok=True)
for size in (16, 48, 128):
    with open(f"icons/icon{size}.png", "wb") as f:
        f.write(make(size))
    print(f"wrote icons/icon{size}.png")
