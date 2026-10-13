# Tiles out/f*.png given on the command line into out/sheet.png (2 columns).
import sys
from PIL import Image, ImageDraw
files = sys.argv[1:]
ims = [Image.open(f) for f in files]
w, h = ims[0].size
cols = 2
rows = (len(ims) + cols - 1) // cols
sheet = Image.new("RGB", (w * cols, h * rows), "#333")
d = ImageDraw.Draw(sheet)
for i, (f, im) in enumerate(zip(files, ims)):
    x, y = (i % cols) * w, (i // cols) * h
    sheet.paste(im, (x, y))
    d.rectangle([x, y, x + w - 1, y + h - 1], outline="#f0f")
    d.text((x + 8, y + 6), f, fill="#f0f")
sheet.save("out/sheet.png")
