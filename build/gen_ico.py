#!/usr/bin/env python3
"""从 appicon.png 生成 Windows icon.ico（多尺寸）"""
from PIL import Image
import os

src = "build/appicon.png"
dst = "build/windows/icon.ico"

img = Image.open(src).convert("RGBA")
sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
imgs = [img.resize(s, Image.LANCZOS) for s in sizes]

imgs[0].save(dst, format="ICO", sizes=sizes, append_images=imgs[1:])
print(f"✓ 生成 {dst}（{os.path.getsize(dst)} bytes）")
