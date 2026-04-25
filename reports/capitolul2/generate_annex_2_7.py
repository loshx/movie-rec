# -*- coding: utf-8 -*-
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent / "anexa_A15_user_flow_diagram.png"
OUT.parent.mkdir(parents=True, exist_ok=True)

W, H = 5000, 3400

BG = (247, 250, 255)
LANE = (233, 241, 255)
BOX = (255, 255, 255)
BORDER = (37, 83, 146)
TEXT = (27, 46, 77)
SUB = (92, 114, 150)
ARROW = (20, 77, 148)
ARROW_SOFT = (188, 215, 248)


def load_font(size: int, bold: bool = False, emoji: bool = False):
    candidates = []
    if emoji:
        candidates.extend([
            "C:/Windows/Fonts/seguiemj.ttf",
            "C:/Windows/Fonts/segoeui.ttf",
            "C:/Windows/Fonts/arial.ttf",
        ])
    else:
        candidates.extend([
            "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
            "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
        ])
    for c in candidates:
        p = Path(c)
        if p.exists():
            return ImageFont.truetype(str(p), size)
    return ImageFont.load_default()


F_H2 = load_font(72, True)
F_TITLE = load_font(58, True)
F_BODY = load_font(52, False)
F_SMALL = load_font(42, False)
F_LABEL = load_font(42, True)
F_ICON = load_font(64, False, emoji=True)


def rr(d: ImageDraw.ImageDraw, rect, fill, outline=BORDER, radius=20, width=3):
    d.rounded_rectangle(rect, radius=radius, fill=fill, outline=outline, width=width)


def text_block(d: ImageDraw.ImageDraw, x: int, y: int, lines, font, color=TEXT, line_height=66):
    if isinstance(lines, str):
        lines = lines.split("\n")
    for i, line in enumerate(lines):
        d.text((x, y + i * line_height), line, font=font, fill=color)


def arrow(d: ImageDraw.ImageDraw, p1, p2, label=None, offset=(0, 0)):
    x1, y1 = p1
    x2, y2 = p2
    d.line((x1, y1, x2, y2), fill=ARROW_SOFT, width=12)
    d.line((x1, y1, x2, y2), fill=ARROW, width=6)

    if abs(x2 - x1) >= abs(y2 - y1):
        s = 1 if x2 > x1 else -1
        head = [(x2, y2), (x2 - 24 * s, y2 - 15), (x2 - 24 * s, y2 + 15)]
    else:
        s = 1 if y2 > y1 else -1
        head = [(x2, y2), (x2 - 15, y2 - 24 * s), (x2 + 15, y2 - 24 * s)]
    d.polygon(head, fill=ARROW)

    if label:
        lx = (x1 + x2) // 2 + offset[0]
        ly = (y1 + y2) // 2 + offset[1]
        bb = d.textbbox((0, 0), label, font=F_LABEL)
        tw, th = bb[2] - bb[0], bb[3] - bb[1]
        rr(d, (lx - tw // 2 - 12, ly - th // 2 - 10, lx + tw // 2 + 12, ly + th // 2 + 10), BOX, ARROW, 12, 2)
        d.text((lx, ly), label, font=F_LABEL, fill=ARROW, anchor="mm")


def node(d: ImageDraw.ImageDraw, rect, title: str, lines, icon: str, icon_bg=(222, 236, 255)):
    x1, y1, x2, y2 = rect
    rr(d, rect, BOX, BORDER, 18, 3)

    icon_size = 88
    icon_x = x1 + 28
    icon_y = y1 + 24
    rr(d, (icon_x, icon_y, icon_x + icon_size, icon_y + icon_size), icon_bg, BORDER, 14, 2)
    d.text((icon_x + icon_size // 2, icon_y + icon_size // 2 + 1), icon, font=F_ICON, fill=ARROW, anchor="mm")

    d.text((icon_x + icon_size + 26, y1 + 30), title, font=F_TITLE, fill=TEXT)
    text_block(d, icon_x + icon_size + 26, y1 + 118, lines, F_BODY, SUB, 62)


def main():
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    rr(d, (70, 60, 1600, 3200), LANE, BORDER, 22, 3)
    rr(d, (1730, 60, 3340, 3200), LANE, BORDER, 22, 3)
    rr(d, (3470, 60, 4930, 3200), LANE, BORDER, 22, 3)

    d.text((835, 165), "Onboarding + Auth", font=F_H2, fill=TEXT, anchor="ma")
    d.text((2535, 165), "Core App Flow", font=F_H2, fill=TEXT, anchor="ma")
    d.text((4200, 165), "Cinema + Gallery", font=F_H2, fill=TEXT, anchor="ma")

    node(d, (140, 260, 1530, 560), "Entry", ["check session", "route login / tabs"], "🚀")
    node(d, (140, 640, 1530, 1080), "Auth", ["login", "register pe pasi", "validari nickname/email"], "🔐")
    node(d, (140, 1160, 1530, 1490), "Onboarding watched", ["alegere titluri vazute", "seed recomandari"], "⭐")
    node(d, (140, 1570, 1530, 1940), "Main tabs", ["Home", "Gallery", "Cinema", "Profile"], "📱")

    node(d, (1790, 260, 3270, 600), "Home", ["featured + sectiuni", "for-you personalizat"], "🏠")
    node(d, (1790, 680, 3270, 1040), "Search + Category", ["query movie/tv/person", "open details"], "🔎")
    node(d, (1790, 1120, 3270, 1560), "Movie / TV Details", ["trailer + cast + similar", "watchlist/favorite/watched/rating", "comments + replies"], "🎬")
    node(d, (1790, 1640, 3270, 2000), "Profile + Lists", ["manage taste lists", "privacy + settings"], "👤")
    node(d, (1790, 2080, 3270, 2520), "UI States", ["loading / empty / error", "retry path unde e cazul"], "⚙️")

    node(d, (3530, 320, 4860, 860), "Cinema", ["no-event placeholder", "upcoming countdown", "live video + chat + poll"], "📺")
    node(d, (3530, 940, 4860, 1300), "Gallery", ["view items", "like / save / comments / replies"], "🖼️")
    node(d, (3530, 1380, 4860, 1740), "Notifications", ["in-app inbox", "deep-link catre ecranul tinta"], "🔔")
    node(d, (3530, 1820, 4860, 2380), "Navigation control", ["bottom dock (4 tabs)", "swipe between tabs", "back gesture pe non-root"], "🧭")

    arrow(d, (1530, 410), (1790, 430), "session ok")
    arrow(d, (1530, 840), (1790, 860), "auth done")
    arrow(d, (1530, 1320), (1790, 1340), "taste seed")
    arrow(d, (1530, 1750), (1790, 1780), "enter app")

    arrow(d, (2530, 600), (2530, 680), "browse", (130, 0))
    arrow(d, (2530, 1040), (2530, 1120), "open", (120, 0))
    arrow(d, (2530, 1560), (2530, 1640), "save", (120, 0))
    arrow(d, (2530, 2000), (2530, 2080), "status", (120, 0))

    arrow(d, (3270, 430), (3530, 530), "cinema")
    arrow(d, (3270, 860), (3530, 1110), "media")
    arrow(d, (3270, 1320), (3530, 1560), "notif")
    arrow(d, (3270, 2280), (3530, 2100), "nav")

    d.text(
        (90, 3300),
        "Sursa: elaborat de autor pe baza fluxurilor reale din aplicatia Movie-Rec (rute + ecrane implementate).",
        font=F_SMALL,
        fill=SUB,
    )

    img.save(OUT, "PNG", dpi=(300, 300), optimize=True)
    print(str(OUT))


if __name__ == "__main__":
    main()
