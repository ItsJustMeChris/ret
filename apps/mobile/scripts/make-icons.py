"""
Builds the phone app's icons from build/icon-source.png, with the desktop's own helpers
(scripts/make-icons.py): the same mascot on the same off-white tile.

    python apps/mobile/scripts/make-icons.py        (needs Pillow)

Writes into apps/mobile/assets/:
  icon.png                 iOS: 1024px, full bleed (iOS rounds the corners itself)
  android-foreground.png   Android adaptive icon: the mascot inside the 66% safe zone
  splash.png               the mascot alone, for the launch screen
"""

import importlib.util
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent.parent
spec = importlib.util.spec_from_file_location("desktop_icons", ROOT / "scripts" / "make-icons.py")
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)

ASSETS = HERE.parent / "assets"
SIZE = 1024


def tile(fill: float, background=desktop.TILE) -> Image.Image:
    canvas = Image.new("RGBA", (SIZE, SIZE), background)
    desktop.place(canvas, desktop.mascot(), (0, 0, SIZE, SIZE), fill)
    return canvas


def main() -> None:
    tile(0.66).convert("RGB").save(ASSETS / "icon.png")
    tile(0.5, (0, 0, 0, 0)).save(ASSETS / "android-foreground.png")
    tile(0.9, (0, 0, 0, 0)).save(ASSETS / "splash.png")
    print("wrote", ", ".join(p.name for p in ASSETS.glob("*.png")))


if __name__ == "__main__":
    main()
