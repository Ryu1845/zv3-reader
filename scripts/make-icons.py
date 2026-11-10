"""Draw the toolbar icons (rounded square with sound-wave bars) with the standard library only.

Usage: python3 scripts/make-icons.py   (writes icons/icon{16,32,48,128}.png)
"""
import os
import struct
import zlib

BG = (47, 95, 237)
FG = (255, 255, 255)
BARS = [0.30, 0.62, 0.92, 0.55, 0.36]   # bar heights relative to the icon
SS = 4                                   # supersampling factor


def inside(x, y, n):
    """Coverage test at continuous coordinates (0..n) for one sample."""
    r = n * 0.22
    # rounded square
    cx = min(max(x, r), n - r)
    cy = min(max(y, r), n - r)
    if (x - cx) ** 2 + (y - cy) ** 2 > r * r:
        return None
    bw = n * 0.105
    gap = n * 0.055
    total = len(BARS) * bw + (len(BARS) - 1) * gap
    x0 = (n - total) / 2
    for i, h in enumerate(BARS):
        bx = x0 + i * (bw + gap)
        hh = h * n * 0.62
        by = (n - hh) / 2
        rr = bw / 2
        if bx <= x <= bx + bw and by <= y <= by + hh:
            # round the bar ends
            ey = min(max(y, by + rr), by + hh - rr)
            if (x - (bx + rr)) ** 2 + (y - ey) ** 2 <= rr * rr:
                return FG
    return BG


def render(n):
    rows = []
    for py in range(n):
        row = bytearray([0])
        for px in range(n):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    c = inside(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS, n)
                    if c:
                        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 255
            k = SS * SS
            a = acc[3] // k
            if a:
                cov = acc[3] / 255
                row += bytes([int(acc[0] / cov), int(acc[1] / cov), int(acc[2] / cov), a])
            else:
                row += bytes([0, 0, 0, 0])
        rows.append(bytes(row))
    raw = b''.join(rows)

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', n, n, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


if __name__ == '__main__':
    out = os.path.join(os.path.dirname(__file__), '..', 'icons')
    for n in (16, 32, 48, 128):
        with open(os.path.join(out, f'icon{n}.png'), 'wb') as f:
            f.write(render(n))
