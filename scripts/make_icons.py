"""生成 PDF AI 扩展的图标（蓝紫渐变 + 文档 + AI 星标）。"""
from PIL import Image, ImageDraw
import os

OUT = "/Users/ahs/Documents/一坨/pdf-ai-sidebar/icons"
os.makedirs(OUT, exist_ok=True)


def make(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 圆角矩形背景：先画一个 45° 渐变的大图，再 resize 到目标尺寸
    # （用 PIL 自带的渐变 API 不存在，这里手工）
    r = max(4, size // 5)
    # 1. 渐变填充：斜向 蓝 → 紫
    grad = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * max(1, size - 1))
            t = max(0.0, min(1.0, t))
            cr = int(59 + (139 - 59) * t)
            cg = int(130 + (92 - 130) * t)
            cb = int(246 + (246 - 246) * t)
            grad.putpixel((x, y), (cr, cg, cb, 255))
    # 2. 用一个圆角 mask
    mask = Image.new("L", (size, size), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([(0, 0), (size - 1, size - 1)], radius=r, fill=255)
    img.paste(grad, (0, 0), mask)

    # 3. 文档图标
    pad = int(size * 0.22)
    doc_left = pad
    doc_top = pad
    doc_right = size - pad
    doc_bottom = size - pad

    draw = ImageDraw.Draw(img)
    # 文档主体
    draw.rectangle(
        [doc_left, doc_top, doc_right, doc_bottom],
        fill=(255, 255, 255, 240),
    )
    # 文档折角
    fold = int(size * 0.18)
    draw.polygon(
        [
            (doc_right - fold, doc_top),
            (doc_right, doc_top + fold),
            (doc_right - fold, doc_top + fold),
        ],
        fill=(200, 200, 220, 250),
    )
    # 折角分隔线
    draw.line(
        [(doc_right - fold, doc_top), (doc_right - fold, doc_top + fold), (doc_right, doc_top + fold)],
        fill=(160, 160, 180, 250),
        width=max(1, size // 60),
    )

    # 文档里画几条线（模拟文本）
    line_pad = int(size * 0.10)
    line_left = doc_left + line_pad
    line_right_max = doc_right - line_pad
    line_top = doc_top + int(size * 0.32)
    line_h = max(1, int(size * 0.04))
    line_gap = line_h * 3
    for i in range(3):
        y = line_top + i * line_gap
        right = line_right_max - int(i * size * 0.10)
        draw.rectangle(
            [line_left, y, right, y + line_h],
            fill=(99, 102, 241, 255),
        )

    # 右下角加个 AI 星
    star_size = size * 0.32
    star_cx = size - size * 0.20
    star_cy = size - size * 0.20
    s = star_size / 2
    pts = [
        (star_cx, star_cy - s),
        (star_cx + s * 0.3, star_cy - s * 0.3),
        (star_cx + s, star_cy),
        (star_cx + s * 0.3, star_cy + s * 0.3),
        (star_cx, star_cy + s),
        (star_cx - s * 0.3, star_cy + s * 0.3),
        (star_cx - s, star_cy),
        (star_cx - s * 0.3, star_cy - s * 0.3),
    ]
    draw.polygon(pts, fill=(251, 191, 36, 255), outline=(217, 119, 6, 255))
    # 写 AI 字
    text = "AI"
    # 简单估算宽度
    tw = size * 0.16
    th = size * 0.14
    draw.text(
        (star_cx - tw / 2, star_cy - th / 2 - size * 0.01),
        text,
        fill=(120, 53, 15, 255),
    )

    return img


for s in (16, 48, 128):
    img = make(s)
    path = os.path.join(OUT, f"icon-{s}.png")
    img.save(path)
    print("wrote", path, img.size)