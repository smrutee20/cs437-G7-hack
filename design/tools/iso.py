#!/usr/bin/env python3
"""Geometry helper for the Feedback Booth isometric illustrations.

Projection (30 degree isometric, SVG y axis pointing down):

    sx = ox + (x - y) * cos(30)
    sy = oy + (x + y) * sin(30) - z

x runs down-right, y runs down-left, z runs up. A box shows three faces:
top (z = z1), front (y = y1, facing lower-left) and side (x = x1, facing
lower-right). Fill them #1c1c1c / #151515 / #111111 and stroke #555555.

Flat artwork can be mapped onto a face with an SVG/CSS matrix, using
face-local coordinates (u to the right, w downwards):

    front face: matrix(0.866 0.5 0 1 Px Py)       Px,Py = P(x0, y1, z_top)
    side face:  matrix(0.866 -0.5 0 1 Px Py)      Px,Py = P(x1, y1, z_top)
    top face:   matrix(0.866 0.5 -0.866 0.5 Px Py) Px,Py = P(x0, y0, z)

Strokes inside a matrix group need vector-effect: non-scaling-stroke.

Usage:
    python3 design/tools/iso.py booth
    python3 design/tools/iso.py press
    python3 design/tools/iso.py dots "6D 08H" [--x0 17 --y0 24.5 --pitch 4 --gap 4 --r 1.5]
"""

import argparse

COS30 = 0.8660254
SIN30 = 0.5

FONT_5X7 = {
    " ": "00000,00000,00000,00000,00000,00000,00000",
    "0": "01110,10001,10011,10101,11001,10001,01110",
    "1": "00100,01100,00100,00100,00100,00100,01110",
    "2": "01110,10001,00001,00010,00100,01000,11111",
    "3": "11111,00010,00100,00010,00001,10001,01110",
    "4": "00010,00110,01010,10010,11111,00010,00010",
    "5": "11111,10000,11110,00001,00001,10001,01110",
    "6": "00110,01000,10000,11110,10001,10001,01110",
    "7": "11111,00001,00010,00100,01000,01000,01000",
    "8": "01110,10001,10001,01110,10001,10001,01110",
    "9": "01110,10001,10001,01111,00001,00010,01100",
    "A": "01110,10001,10001,11111,10001,10001,10001",
    "B": "11110,10001,10001,11110,10001,10001,11110",
    "C": "01110,10001,10000,10000,10000,10001,01110",
    "D": "11100,10010,10001,10001,10001,10010,11100",
    "E": "11111,10000,10000,11110,10000,10000,11111",
    "F": "11111,10000,10000,11110,10000,10000,10000",
    "G": "01110,10001,10000,10111,10001,10001,01111",
    "H": "10001,10001,10001,11111,10001,10001,10001",
    "I": "01110,00100,00100,00100,00100,00100,01110",
    "J": "00111,00010,00010,00010,00010,10010,01100",
    "K": "10001,10010,10100,11000,10100,10010,10001",
    "L": "10000,10000,10000,10000,10000,10000,11111",
    "M": "10001,11011,10101,10101,10001,10001,10001",
    "N": "10001,10001,11001,10101,10011,10001,10001",
    "O": "01110,10001,10001,10001,10001,10001,01110",
    "P": "11110,10001,10001,11110,10000,10000,10000",
    "Q": "01110,10001,10001,10001,10101,10010,01101",
    "R": "11110,10001,10001,11110,10100,10010,10001",
    "S": "01111,10000,10000,01110,00001,00001,11110",
    "T": "11111,00100,00100,00100,00100,00100,00100",
    "U": "10001,10001,10001,10001,10001,10001,01110",
    "V": "10001,10001,10001,10001,10001,01010,00100",
    "W": "10001,10001,10001,10101,10101,10101,01010",
    "X": "10001,10001,01010,00100,01010,10001,10001",
    "Y": "10001,10001,10001,01010,00100,00100,00100",
    "Z": "11111,00001,00010,00100,01000,10000,11111",
    "-": "00000,00000,00000,11111,00000,00000,00000",
    ".": "00000,00000,00000,00000,00000,01100,01100",
    "?": "01110,10001,00001,00010,00100,00000,00100",
}


def project(x, y, z, origin):
    return (origin[0] + (x - y) * COS30, origin[1] + (x + y) * SIN30 - z)


def fmt(points):
    return " ".join(f"{px:.1f},{py:.1f}" for px, py in points)


def box(name, x0, y0, z0, w, d, h, origin):
    x1, y1, z1 = x0 + w, y0 + d, z0 + h
    p = lambda x, y, z: project(x, y, z, origin)
    top = [p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)]
    front = [p(x0, y1, z0), p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1)]
    side = [p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)]
    print(f"<!-- {name} -->")
    print(f'<polygon points="{fmt(top)}" fill="#1c1c1c"/>')
    print(f'<polygon points="{fmt(front)}" fill="#151515"/>')
    print(f'<polygon points="{fmt(side)}" fill="#111111"/>')


def face_matrix(kind, point):
    a = {"front": "0.866 0.5 0 1", "side": "0.866 -0.5 0 1", "top": "0.866 0.5 -0.866 0.5"}[kind]
    return f"matrix({a} {point[0]:.1f} {point[1]:.1f})"


def booth():
    o = (140, 226)  # rendered with viewBox="0 30 340 390"
    box("plinth", 0, 0, 0, 220, 150, 14, o)
    box("body", 26, 20, 14, 168, 96, 150, o)
    box("cap", 20, 14, 164, 180, 108, 12, o)
    box("sign", 50, 40, 176, 120, 20, 46, o)
    print("body front  ", face_matrix("front", project(26, 116, 164, o)), "(display window u10-158 w18-58, slot u44-124 w138-144)")
    print("body side   ", face_matrix("side", project(194, 116, 164, o)))
    print("sign front  ", face_matrix("front", project(50, 60, 222, o)))
    print("ledge top   ", face_matrix("top", project(78, 121, 14, o)), "(card 64x24)")


def press():
    o = (150, 186)  # rendered with viewBox="16 40 316 330"
    box("plinth", 0, 0, 0, 200, 150, 14, o)
    box("column", 70, 10, 14, 60, 40, 130, o)
    box("rod (moves with head)", 96, 104, 68, 8, 8, 74, o)
    box("arm", 80, 30, 118, 40, 90, 24, o)
    box("head (moves 22px down to stamp)", 72, 88, 38, 56, 40, 30, o)
    print("column front", face_matrix("front", project(70, 50, 118, o)))
    print("column side ", face_matrix("side", project(130, 50, 144, o)))
    print("head front  ", face_matrix("front", project(72, 128, 68, o)))
    print("card top    ", face_matrix("top", project(72, 90, 14, o)), "(card 56x38; slides out by translate(52px,30px))")
    print("lever pivot ", "translate(%.1f %.1f)" % project(130, 30, 100, o))


def dots(text, x0, y0, pitch, gap, r):
    glyph_w = 4 * pitch + gap
    lit, grid = [], []
    for i, ch in enumerate(text.upper()):
        rows = FONT_5X7.get(ch, FONT_5X7[" "]).split(",")
        for row in range(7):
            for col in range(5):
                cx = x0 + i * glyph_w + col * pitch
                cy = y0 + row * pitch
                circle = f'<circle cx="{cx:g}" cy="{cy:g}" r="{r:g}"/>'
                grid.append(circle)
                if rows[row][col] == "1":
                    lit.append(circle)
    print(f"<!-- grid ({len(grid)}) -->")
    print("".join(grid))
    print(f"<!-- pattern ({len(lit)}) -->")
    print("".join(lit))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("what", choices=["booth", "press", "dots"])
    parser.add_argument("text", nargs="?", default="404")
    parser.add_argument("--x0", type=float, default=0)
    parser.add_argument("--y0", type=float, default=0)
    parser.add_argument("--pitch", type=float, default=3)
    parser.add_argument("--gap", type=float, default=5, help="extra space between glyphs")
    parser.add_argument("--r", type=float, default=1.15)
    args = parser.parse_args()
    if args.what == "booth":
        booth()
    elif args.what == "press":
        press()
    else:
        dots(args.text, args.x0, args.y0, args.pitch, args.gap, args.r)


if __name__ == "__main__":
    main()
