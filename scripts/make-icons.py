"""
Builds Ret's app icons from build/icon-source.png (the mascot on a transparent background).

    python scripts/make-icons.py        (needs Pillow: pip install pillow)

Writes, into build/ (electron-builder's resources folder):
  icon.icns  macOS: Apple's grid, an 824px rounded tile on a 1024 canvas with a soft shadow
  icon.ico   Windows: a near full-bleed rounded tile, 16-256px, small sizes drawn with a
             tighter crop so the face stays readable
  icon.png   1024px, the macOS layout (Linux builds, and the Dock icon in dev)
and src/renderer/public/favicon.png for the web build.

The mascot sits on an off-white tile (its own face colour) so it reads on dark taskbars
and Docks as well as light ones.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "build" / "icon-source.png"
TILE = (248, 250, 251, 255)  # the mascot's own white
SS = 4  # supersampling for smooth edges


def mascot() -> Image.Image:
    art = Image.open(SOURCE).convert("RGBA")
    # Trim to what's actually drawn (ignore near-invisible stray pixels).
    solid = art.getchannel("A").point(lambda a: 255 if a > 32 else 0)
    return art.crop(solid.getbbox())


def rounded_mask(size: int, box: tuple[int, int, int, int], radius: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=radius, fill=255)
    return mask


def place(canvas: Image.Image, art: Image.Image, box: tuple[int, int, int, int], fill: float) -> None:
    """Fit `art` into `box`, scaled to `fill` of the box's height (or width), centred."""
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    scale = min(bw * fill / art.width, bh * fill / art.height)
    w, h = round(art.width * scale), round(art.height * scale)
    sprite = art.resize((w, h), Image.LANCZOS)
    canvas.alpha_composite(sprite, (x0 + (bw - w) // 2, y0 + (bh - h) // 2))


def mac_icon(art: Image.Image, size: int = 1024) -> Image.Image:
    """Apple's macOS grid: an 824/1024 tile, ~185/1024 corner radius, a shadow beneath."""
    s = size * SS
    k = s / 1024
    inset = round(100 * k)
    box = (inset, inset, s - inset, s - inset)
    radius = 185.4 * k

    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    shadow_mask = rounded_mask(s, (box[0], box[1] + round(12 * k), box[2], box[3] + round(12 * k)), radius)
    shadow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    shadow.putalpha(shadow_mask.filter(ImageFilter.GaussianBlur(14 * k)).point(lambda a: a * 0.32))
    canvas.alpha_composite(shadow)

    tile = Image.new("RGBA", (s, s), TILE)
    canvas.paste(tile, (0, 0), rounded_mask(s, box, radius))
    place(canvas, art, box, 0.80)
    return canvas.resize((size, size), Image.LANCZOS)


def win_icon(art: Image.Image, size: int) -> Image.Image:
    """Windows: a rounded tile filling nearly the whole square; small sizes zoom in on the mascot."""
    s = size * SS
    margin = round(s * (0.02 if size <= 32 else 0.04))
    box = (margin, margin, s - margin, s - margin)
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    canvas.paste(Image.new("RGBA", (s, s), TILE), (0, 0), rounded_mask(s, box, (s - 2 * margin) * 0.22))
    place(canvas, art, box, 0.94 if size <= 32 else 0.84)
    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    art = mascot()
    out = ROOT / "build"

    mac = mac_icon(art)
    mac.save(out / "icon.png")
    mac.save(out / "icon.icns")  # Pillow writes every size from 16 to 1024

    sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
    frames = [win_icon(art, n) for n in sizes]
    frames[-1].save(out / "icon.ico", sizes=[(n, n) for n in sizes], append_images=frames[:-1])

    public = ROOT / "src" / "renderer" / "public"
    public.mkdir(parents=True, exist_ok=True)
    win_icon(art, 64).save(public / "favicon.png")
    print("wrote build/icon.icns, build/icon.ico, build/icon.png, src/renderer/public/favicon.png")


if __name__ == "__main__":
    main()
