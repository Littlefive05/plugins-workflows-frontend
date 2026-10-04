# 磁带贴图生成（PIL）—— 供 Blender 建模引用
#   关键：标签几何只保留"带窗四周边条"，所以所有印刷必须落在四条边内、并避开 5 颗螺钉的位置。
#   版面（U,V）= 0..1 对应世界 (X -45..45mm, Y -28.5..28.5mm)：
#     上条 V 0.69..1.00 | 下条 V 0.00..0.31 | 左条 U 0.00..0.211 | 右条 U 0.58..1.00
#     螺钉在 (U,V) ≈ (0.067,0.895)(0.933,0.895)(0.067,0.105)(0.933,0.105) 与中心 (0.5,0.5)
# 用法: <python-with-PIL> make-tape-textures.py <outdir>
import os, sys, random
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1] if len(sys.argv) > 1 else r"C:\LFModels\workspaces\series-0x2b\tools\tex"
os.makedirs(OUT, exist_ok=True)
F_DIN = r"C:\Windows\Fonts\bahnschrift.ttf"
F_MONO = r"C:\Windows\Fonts\consola.ttf"

def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()

def noise(img, amount=8):
    px = img.load(); w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]; n = random.randint(-amount, amount)
            px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)), a)
    return img

W, H = 2048, 1300
# 边条像素范围
TOP_V0 = 0.69; BOT_V1 = 0.31; LEFT_U1 = 0.211; RIGHT_U0 = 0.58
def px_u(u): return int(u * W)
def px_v(v): return int((1.0 - v) * H)     # PIL 的 y 向下，V 向上

INK = (26, 27, 30, 255); DIM = (108, 112, 120, 255); RED = (198, 55, 45, 255)

# ---------------- 标签层 ----------------
im = Image.new("RGBA", (W, H), (238, 231, 216, 255))
d = ImageDraw.Draw(im)
noise(im, 8)

# ===== 上条：SERIES 0x2B（避开左上/右上螺钉）=====
d.rectangle([px_u(0.105), px_v(0.955), px_u(0.115), px_v(0.795)], fill=RED)   # 竖红条
d.text((px_u(0.125), px_v(0.945)), "SERIES 0x2B", font=font(F_DIN, 92), fill=INK)
d.text((px_u(0.128), px_v(0.815)), "TYPE II / HIGH BIAS", font=font(F_MONO, 38), fill=DIM)
d.text((px_u(0.520), px_v(0.815)), "BLEND-TAPE", font=font(F_MONO, 38), fill=DIM)
d.text((px_u(0.760), px_v(0.815)), "REV r0001", font=font(F_MONO, 38), fill=DIM)
d.line([px_u(0.105), px_v(0.775), px_u(0.895), px_v(0.775)], fill=INK, width=3)

# ===== 下条：规格表（两行 × 四对，避开左下/右下螺钉）=====
rows = [[("SIDE", "A"), ("SPEED", "4.76 cm/s"), ("TRACKS", "02 STEREO"), ("SAMPLE", "48.0 kHz")],
        [("DEPTH", "24 bit"), ("LENGTH", "02:04"), ("AZIMUTH", "90 deg"), ("BIAS", "+0.9 dB")]]
for ri, row in enumerate(rows):
    x = px_u(0.105); y = px_v(0.285 - ri * 0.095)
    for k, v in row:
        d.text((x, y), k, font=font(F_MONO, 33), fill=DIM)
        d.text((x + 132, y), v, font=font(F_MONO, 33), fill=INK)
        x += px_u(0.205)
d.line([px_u(0.105), px_v(0.318), px_u(0.895), px_v(0.318)], fill=INK, width=3)

# ===== 左条：竖排小字（真实磁带标签的常见做法）=====
# 边条 V 范围只有 0.31..0.69（490px），竖排文字必须短，否则会越界到窗上/标签外
left = "BLEND-TAPE / SERIES 0x2B"
strip = Image.new("RGBA", (470, 130), (0, 0, 0, 0))
ds = ImageDraw.Draw(strip)
ds.text((6, 40), left, font=font(F_MONO, 34), fill=INK)
strip = strip.rotate(90, expand=True)
im.paste(strip, (px_u(0.052), px_v(0.685)), strip)

# ===== 右条：竖排技术注解（右条起点是 U 0.789，不是 0.58）=====
right = "KREA2 >> TRELLIS.2 >> BLENDER"
strip2 = Image.new("RGBA", (470, 130), (0, 0, 0, 0))
ds2 = ImageDraw.Draw(strip2)
ds2.text((6, 40), right, font=font(F_MONO, 34), fill=DIM)
strip2 = strip2.rotate(90, expand=True)
im.paste(strip2, (px_u(0.800), px_v(0.685)), strip2)

# ===== 底边微字（真实标签底部的印刷脚注）=====
for i in range(3):
    d.text((px_u(0.105), px_v(0.075 - i * 0.035)),
           "ISO 0x2B   BLEND-TAPE   DIFFUSION   HUB 330   4.76 cm/s   " * 2,
           font=font(F_MONO, 24), fill=(150, 152, 158, 200))
# 角标（在螺钉内侧，不冲突）
for (ux, uy, dx, dy) in [(0.125, 0.735, 1, -1), (0.875, 0.735, -1, -1), (0.125, 0.345, 1, 1), (0.875, 0.345, -1, 1)]:
    cx, cy, s = px_u(ux), px_v(uy), 40
    d.line([cx + dx * s, cy, cx, cy, cx, cy + dy * s], fill=(26, 27, 30, 120), width=4)

im.save(os.path.join(OUT, "label.png"))
print("SAVED label.png", im.size)

# ---------------- 背板 ----------------
im2 = Image.new("RGBA", (2048, 1300), (30, 39, 58, 255))
d2 = ImageDraw.Draw(im2)
noise(im2, 6)
d2.text((140, 110), "SIDE B", font=font(F_DIN, 140), fill=(176, 188, 208, 235))
d2.text((150, 280), "BLEND-TAPE / SERIES 0x2B", font=font(F_MONO, 48), fill=(122, 136, 160, 220))
d2.line([140, 368, 1908, 368], fill=(122, 136, 160, 120), width=3)
d2.text((160, 430), "02", font=font(F_DIN, 380), fill=(96, 112, 140, 205))
rows2 = [("SPEED", "4.76 cm/s"), ("TRACK", "02"), ("BIAS", "+0.9 dB"),
         ("AZIMUTH", "90 deg"), ("HUB", "330"), ("SCREW", "05")]
y = 430
for k, v in rows2:
    d2.text((900, y), k, font=font(F_MONO, 44), fill=(112, 126, 150, 220))
    d2.text((1320, y), v, font=font(F_MONO, 44), fill=(170, 182, 202, 235))
    d2.line([896, y + 58, 1900, y + 58], fill=(122, 136, 160, 70), width=2)
    y += 92
for i in range(7):
    d2.text((150, 1090 + i * 27), "ISO 0x2B  BLEND-TAPE  DIFFUSION  " * 3 + str(i),
            font=font(F_MONO, 22), fill=(98, 112, 136, 150))
im2.save(os.path.join(OUT, "back.png"))
print("SAVED back.png", im2.size)

# ---------------- 壳体微噪声 ----------------
im3 = Image.new("RGBA", (1024, 1024), (54, 57, 60, 255))
px = im3.load()
for yy in range(1024):
    for xx in range(1024):
        n = random.randint(-7, 7)
        px[xx, yy] = (54 + n, 57 + n, 60 + n, 255)
im3.save(os.path.join(OUT, "shell.png"))
print("SAVED shell.png", im3.size)
print("DONE")
