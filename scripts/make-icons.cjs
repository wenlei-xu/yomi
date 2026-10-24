// Regenerates Yomi app icons and splash screens from a single source PNG.
// Usage: node scripts/make-icons.cjs <source.png>
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const source = process.argv[2];
if (!source || !fs.existsSync(source)) {
  console.error("usage: node scripts/make-icons.cjs <source.png>");
  process.exit(1);
}

const python = process.platform === "win32" ? "python" : "python3";
const script = String.raw`
import sys
from PIL import Image
import os
import os.path as pathmod

source, res = sys.argv[1], sys.argv[2]
CREAM = (251, 244, 226)

im = Image.open(source).convert("RGBA")
alpha = im.getchannel("A")
# Trim transparent margin, ignoring near-zero noise.
bbox = alpha.point(lambda v: 255 if v > 8 else 0).getbbox()
if bbox:
    im = im.crop(bbox)
cat_w, cat_h = im.size

def canvas(size):
    return Image.new("RGBA", (size, size), CREAM + (255,))

def rounded(size, radius):
    mask = Image.new("L", (size, size), 0)
    from PIL import ImageDraw
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask

def draw_round(base, size, radius, fill=CREAM):
    from PIL import ImageDraw
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=fill + (255,))
    base.alpha_composite(layer)

def save(img, dest):
    d = pathmod.dirname(dest)
    os.makedirs(d, exist_ok=True)
    img.save(dest, "PNG", optimize=True)
    print("wrote", dest)

def joined(*parts):
    return pathmod.join(*parts)

def fit_center(box, target):
    w, h = box.size
    scale = min(target[0] / w, target[1] / h)
    return box.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)

# 1. Web brand mark: square art, no plate, so it sits on the app header.
web = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
cat = fit_center(im, (512, 512))
web.alpha_composite(cat, ((512 - cat.size[0]) // 2, (512 - cat.size[1]) // 2))
save(web, joined(res, "public", "logo.png"))

# 2. Adaptive launcher icon: 108dp canvas, art kept inside the 66dp safe zone.
for tag, size in [("mdpi", 108), ("hdpi", 162), ("xhdpi", 216), ("xxhdpi", 324), ("xxxhdpi", 432)]:
    plate = canvas(size)
    target = round(size * 0.62)
    cat = fit_center(im, (target, target))
    plate.alpha_composite(cat, ((size - cat.size[0]) // 2, (size - cat.size[1]) // 2))
    save(plate, joined(res, "android", "app", "src", "main", "res", "mipmap-" + tag, "ic_launcher_foreground.png"))

# 3. Legacy square and round launcher icons.
for tag, size in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)]:
    square = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_round(square, size, round(size * 0.22))
    cat = fit_center(im, (round(size * 0.78), round(size * 0.78)))
    square.alpha_composite(cat, ((size - cat.size[0]) // 2, (size - cat.size[1]) // 2))
    save(square, joined(res, "android", "app", "src", "main", "res", "mipmap-" + tag, "ic_launcher.png"))

    circle = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    from PIL import ImageDraw
    ImageDraw.Draw(circle).ellipse((0, 0, size - 1, size - 1), fill=CREAM + (255,))
    cat = fit_center(im, (round(size * 0.74), round(size * 0.74)))
    circle.alpha_composite(cat, ((size - cat.size[0]) // 2, (size - cat.size[1]) // 2))
    save(circle, joined(res, "android", "app", "src", "main", "res", "mipmap-" + tag, "ic_launcher_round.png"))

# 4. Splash screens: cream field, art centred, sized against the short edge.
for tag, size in [("mdpi", 320), ("hdpi", 480), ("xhdpi", 720), ("xxhdpi", 960), ("xxxhdpi", 1280)]:
    for orient, dims in [("port", (round(size * 0.6), round(size))), ("land", (size, round(size * 0.6)))]:
        w, h = dims
        bg = Image.new("RGB", (w, h), CREAM)
        target = round(min(w, h) * 0.42)
        cat = fit_center(im, (target, target))
        cat_rgba = cat.convert("RGBA")
        bg.paste(cat_rgba, ((w - cat.size[0]) // 2, (h - cat.size[1]) // 2), cat_rgba)
        save(bg.convert("RGB"), joined(res, "android", "app", "src", "main", "res",
            "drawable-" + orient + "-" + tag, "splash.png"))

bg = Image.new("RGB", (480, 320), CREAM)
cat = fit_center(im, (round(320 * 0.42), round(320 * 0.42)))
cat_rgba = cat.convert("RGBA")
bg.paste(cat_rgba, ((480 - cat.size[0]) // 2, (320 - cat.size[1]) // 2), cat_rgba)
save(bg, joined(res, "android", "app", "src", "main", "res", "drawable", "splash.png"))
`;

const tmp = path.join(root, "scripts", ".make-icons.py");
fs.writeFileSync(tmp, script, "utf8");
try {
  execFileSync(python, [tmp, source, root], { stdio: "inherit" });
} finally {
  fs.unlinkSync(tmp);
}
