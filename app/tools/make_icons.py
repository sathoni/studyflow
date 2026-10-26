"""
Draws the StudyFlow icons and the demo placeholder slide with Pillow.

Run it with:   python tools/make_icons.py      (from the app folder)

Writes, all opaque (iOS shows transparency as black):
  public/icons/icon-180.png           apple-touch-icon (iOS rounds the corners itself)
  public/icons/icon-192.png           manifest, purpose "any"
  public/icons/icon-512.png           manifest, purpose "any"
  public/icons/icon-512-maskable.png  manifest, purpose "maskable" (mark inside the 80 % safe zone)
  public/demo/placeholder.webp        the image every visual shows in demo mode

The mark: a white stack of three cards on the StudyFlow blue, with a flowing
line across the front card. Drawn at 4x and scaled down, for smooth edges.
"""

from pathlib import Path
import math

from PIL import Image, ImageDraw, ImageFont

APP = Path(__file__).resolve().parent.parent
ICONS = APP / "public" / "icons"
DEMO = APP / "public" / "demo"

BLUE_TOP = (63, 125, 255)
BLUE_BOTTOM = (36, 88, 232)
BLUE = (47, 107, 255)
WHITE = (255, 255, 255)


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size):
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)
    for y in range(size):
        draw.line([(0, y), (size, y)], fill=mix(BLUE_TOP, BLUE_BOTTOM, y / (size - 1)))
    return img


def draw_mark(img, scale):
    """The stack of cards, centred, `scale` = share of the canvas the mark may use."""
    s = img.width
    d = ImageDraw.Draw(img)
    unit = s * scale
    cx, cy = s / 2, s / 2 + unit * 0.10
    w, h = unit * 0.80, unit * 0.56
    r = unit * 0.10
    # Back cards: narrower and higher, in a white mixed into the blue (opaque).
    for k, (shrink, lift, tint) in enumerate([(0.74, 0.30, 0.38), (0.87, 0.15, 0.66)]):
        bw = w * shrink
        top = cy - h / 2 - unit * lift
        colour = mix(mix(BLUE_TOP, BLUE_BOTTOM, 0.35 + 0.1 * k), WHITE, tint)
        d.rounded_rectangle([cx - bw / 2, top, cx + bw / 2, top + h], radius=r, fill=colour)
    # The front card.
    d.rounded_rectangle([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], radius=r, fill=WHITE)
    # The flow mark: one smooth wave across the card, then a dot. Stamped as
    # overlapping discs rather than drawn as a wide line: Pillow's wide lines
    # fray at the joints, discs give a clean round stroke.
    x0, x1 = cx - w * 0.30, cx + w * 0.16
    amp = h * 0.14
    lw = unit * 0.066
    steps = int((x1 - x0) * 2)
    for i in range(steps + 1):
        t = i / steps
        x = x0 + (x1 - x0) * t
        y = cy + amp * math.sin(t * 2 * math.pi + math.pi * 0.5) * -1
        d.ellipse([x - lw / 2, y - lw / 2, x + lw / 2, y + lw / 2], fill=BLUE)
    dot = lw * 0.62
    dx = x1 + w * 0.13
    d.ellipse([dx - dot, cy - amp - dot, dx + dot, cy - amp + dot], fill=BLUE)


def icon(size, scale, name):
    big = gradient(size * 4)
    draw_mark(big, scale)
    out = big.resize((size, size), Image.LANCZOS)
    out.save(ICONS / name, optimize=True)
    print("wrote", ICONS / name)


def font(px):
    for name in ("segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, px)
        except OSError:
            continue
    return ImageFont.load_default()


def placeholder():
    """A neutral 'slide' with a little schema: boxes, arrows and a caption."""
    w, h = 2000, 1125
    img = Image.new("RGB", (w, h), (247, 249, 253))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, w, 120], fill=(47, 107, 255))
    d.text((60, 30), "Voorbeeldschema (demo)", font=font(56), fill=WHITE)
    labels = ["Leverancier", "Producent", "Groothandel", "Klant"]
    bw, bh, gap = 340, 200, 120
    left = (w - (4 * bw + 3 * gap)) / 2
    top = 360
    for i, label in enumerate(labels):
        x = left + i * (bw + gap)
        d.rounded_rectangle([x, top, x + bw, top + bh], radius=28, fill=WHITE, outline=(47, 107, 255), width=6)
        tw = d.textlength(label, font=font(44))
        d.text((x + (bw - tw) / 2, top + bh / 2 - 28), label, font=font(44), fill=(15, 23, 42))
        if i < 3:
            ax = x + bw + 16
            ay = top + bh / 2
            d.line([(ax, ay), (ax + gap - 40, ay)], fill=(100, 116, 139), width=8)
            d.polygon([(ax + gap - 32, ay), (ax + gap - 58, ay - 18), (ax + gap - 58, ay + 18)], fill=(100, 116, 139))
    # A small table underneath.
    tx, ty = 420, 720
    cols, rows, cw, ch = 4, 3, 290, 80
    for r in range(rows):
        for c in range(cols):
            fill = (225, 234, 255) if r == 0 else WHITE
            d.rectangle([tx + c * cw, ty + r * ch, tx + (c + 1) * cw, ty + (r + 1) * ch], fill=fill, outline=(203, 213, 225), width=3)
    d.text((60, h - 80), "Afbeelding in demomodus", font=font(36), fill=(100, 116, 139))
    DEMO.mkdir(parents=True, exist_ok=True)
    img.save(DEMO / "placeholder.webp", "WEBP", quality=72, method=6)
    print("wrote", DEMO / "placeholder.webp")


if __name__ == "__main__":
    ICONS.mkdir(parents=True, exist_ok=True)
    icon(180, 0.62, "icon-180.png")
    icon(192, 0.62, "icon-192.png")
    icon(512, 0.62, "icon-512.png")
    icon(512, 0.50, "icon-512-maskable.png")
    placeholder()
