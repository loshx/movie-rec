# -*- coding: utf-8 -*-
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


OUT_DIR = Path(__file__).resolve().parent

BG = (248, 251, 255)
PANEL = (236, 243, 255)
BOX = (255, 255, 255)
BORDER = (46, 85, 140)
TEXT = (28, 47, 79)
SUB = (88, 111, 148)
ARROW = (12, 60, 128)
ARROW_GLOW = (190, 216, 247)
ACCENT = (82, 142, 216)


def load_font(size: int, bold: bool = False):
    candidates = [
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ]
    for c in candidates:
        p = Path(c)
        if p.exists():
            return ImageFont.truetype(str(p), size)
    return ImageFont.load_default()


FONT_BIG = load_font(52, bold=True)
FONT_TITLE = load_font(40, bold=True)
FONT_M = load_font(30, bold=False)
FONT_SUB = load_font(32, bold=False)
FONT_FOOT = load_font(24, bold=False)
FONT_EDGE = load_font(24, bold=True)


def rounded(draw: ImageDraw.ImageDraw, rect, fill, outline=BORDER, radius=20, width=3):
    draw.rounded_rectangle(rect, radius=radius, fill=fill, outline=outline, width=width)


def draw_icon(draw: ImageDraw.ImageDraw, kind: str, x: int, y: int, size: int = 44):
    rounded(draw, (x, y, x + size, y + size), (240, 248, 255), ACCENT, radius=10, width=2)
    cx, cy = x + size // 2, y + size // 2
    if kind == "mobile":
        draw.rounded_rectangle((x + 10, y + 6, x + size - 10, y + size - 6), radius=4, outline=ACCENT, width=2)
        draw.line((cx - 5, y + size - 10, cx + 5, y + size - 10), fill=ACCENT, width=2)
    elif kind == "router":
        draw.rectangle((x + 8, y + 16, x + size - 8, y + size - 10), outline=ACCENT, width=2)
        draw.line((x + 12, y + 20, x + size - 12, y + 20), fill=ACCENT, width=2)
        draw.line((x + 14, y + 26, x + size - 14, y + 26), fill=ACCENT, width=2)
    elif kind == "db":
        draw.ellipse((x + 8, y + 6, x + size - 8, y + 16), outline=ACCENT, width=2)
        draw.rectangle((x + 8, y + 11, x + size - 8, y + size - 8), outline=ACCENT, width=2)
        draw.ellipse((x + 8, y + size - 13, x + size - 8, y + size - 3), outline=ACCENT, width=2)
    elif kind == "server":
        draw.rectangle((x + 8, y + 7, x + size - 8, y + size - 7), outline=ACCENT, width=2)
        draw.line((x + 11, y + 17, x + size - 11, y + 17), fill=ACCENT, width=2)
        draw.line((x + 11, y + 25, x + size - 11, y + 25), fill=ACCENT, width=2)
    elif kind == "socket":
        draw.ellipse((x + 9, y + 9, x + size - 9, y + size - 9), outline=ACCENT, width=2)
        draw.line((cx, y + 9, cx, y + size - 9), fill=ACCENT, width=2)
        draw.line((x + 9, cy, x + size - 9, cy), fill=ACCENT, width=2)
    elif kind == "ml":
        draw.ellipse((x + 9, y + 9, x + size - 9, y + size - 9), outline=ACCENT, width=2)
        draw.line((x + 14, cy, cx, y + 14), fill=ACCENT, width=2)
        draw.line((cx, y + 14, x + size - 14, cy), fill=ACCENT, width=2)
        draw.line((x + 14, cy, x + size - 14, cy), fill=ACCENT, width=2)
    elif kind == "tmdb":
        draw.polygon(
            [(x + 10, y + size - 10), (x + size // 2, y + 8), (x + size - 10, y + size - 10)],
            outline=ACCENT,
            fill=None,
            width=2,
        )
    elif kind == "cloud":
        draw.ellipse((x + 8, y + 14, x + 22, y + 28), outline=ACCENT, width=2)
        draw.ellipse((x + 16, y + 10, x + 30, y + 28), outline=ACCENT, width=2)
        draw.ellipse((x + 24, y + 14, x + 36, y + 28), outline=ACCENT, width=2)
        draw.line((x + 10, y + 28, x + 35, y + 28), fill=ACCENT, width=2)
    elif kind == "push":
        draw.arc((x + 8, y + 8, x + size - 8, y + size - 8), 220, 320, fill=ACCENT, width=2)
        draw.arc((x + 12, y + 12, x + size - 12, y + size - 12), 220, 320, fill=ACCENT, width=2)
        draw.ellipse((cx - 2, cy + 8, cx + 2, cy + 12), fill=ACCENT, outline=ACCENT)


def draw_node(draw: ImageDraw.ImageDraw, rect, title: str, subtitle: str, icon: str):
    rounded(draw, rect, BOX, BORDER, radius=18, width=3)
    x1, y1, _, _ = rect
    draw_icon(draw, icon, x1 + 14, y1 + 12, size=44)
    draw.text((x1 + 74, y1 + 56), title, font=FONT_TITLE, fill=TEXT, anchor="lm")
    draw.text((x1 + 74, y1 + 112), subtitle, font=FONT_SUB, fill=SUB, anchor="lm")


def edge_label(draw: ImageDraw.ImageDraw, x: int, y: int, text: str):
    bb = draw.textbbox((0, 0), text, font=FONT_EDGE)
    tw = bb[2] - bb[0]
    th = bb[3] - bb[1]
    pad_x = 10
    pad_y = 6
    rect = (x - tw // 2 - pad_x, y - th // 2 - pad_y, x + tw // 2 + pad_x, y + th // 2 + pad_y)
    rounded(draw, rect, BOX, ARROW, radius=10, width=2)
    draw.text((x, y), text, font=FONT_EDGE, fill=ARROW, anchor="mm")


def arrow(draw: ImageDraw.ImageDraw, start, end):
    x1, y1 = start
    x2, y2 = end
    draw.line((x1, y1, x2, y2), fill=ARROW_GLOW, width=11)
    draw.line((x1, y1, x2, y2), fill=ARROW, width=6)
    if abs(x2 - x1) >= abs(y2 - y1):
        sign = 1 if x2 > x1 else -1
        head = [(x2, y2), (x2 - 22 * sign, y2 - 14), (x2 - 22 * sign, y2 + 14)]
    else:
        sign = 1 if y2 > y1 else -1
        head = [(x2, y2), (x2 - 14, y2 - 22 * sign), (x2 + 14, y2 - 22 * sign)]
    draw.polygon(head, fill=ARROW_GLOW)
    draw.polygon(head, fill=ARROW)


def arrow_path(draw: ImageDraw.ImageDraw, points):
    for i in range(len(points) - 1):
        draw.line((points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]), fill=ARROW_GLOW, width=11)
        draw.line((points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]), fill=ARROW, width=6)
    arrow(draw, points[-2], points[-1])


def generate_a7(path: Path):
    w, h = 2200, 1240
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)

    rounded(d, (40, 60, 720, 1180), PANEL, BORDER, radius=24, width=3)
    rounded(d, (760, 60, 1440, 1180), PANEL, BORDER, radius=24, width=3)
    rounded(d, (1480, 60, 2160, 1180), PANEL, BORDER, radius=24, width=3)
    d.text((380, 100), "Front-end mobil", font=FONT_BIG, fill=TEXT, anchor="ma")
    d.text((1100, 100), "Core services", font=FONT_BIG, fill=TEXT, anchor="ma")
    d.text((1820, 100), "Servicii externe", font=FONT_BIG, fill=TEXT, anchor="ma")

    app = (90, 180, 670, 350)
    router = (90, 410, 670, 580)
    sqlite = (90, 640, 670, 810)
    api = (810, 180, 1390, 350)
    ws = (810, 410, 1390, 580)
    ml = (810, 640, 1390, 810)
    tmdb = (1530, 180, 2110, 350)
    cloud = (1530, 410, 2110, 580)
    push = (1530, 640, 2110, 810)

    draw_node(d, app, "Mobile App (Expo RN)", "UI screens + interactions", "mobile")
    draw_node(d, router, "Router + UI Flow", "Navigation + route stack", "router")
    draw_node(d, sqlite, "SQLite local", "Offline persistence", "db")
    draw_node(d, api, "Backend API (Node.js)", "REST business endpoints", "server")
    draw_node(d, ws, "WebSocket Gateway", "Live chat/presence", "socket")
    draw_node(d, ml, "ML Service (FastAPI)", "Ingest + recommendations", "ml")
    draw_node(d, tmdb, "TMDB API", "Catalog metadata", "tmdb")
    draw_node(d, cloud, "Cloudinary", "Media storage", "cloud")
    draw_node(d, push, "Expo Push Service", "Push notifications", "push")

    # Front-end to core
    arrow(d, (670, 265), (810, 265))
    edge_label(d, 740, 228, "HTTPS / REST")
    arrow(d, (670, 495), (810, 495))
    edge_label(d, 740, 458, "WSS / realtime")
    arrow(d, (380, 580), (380, 640))
    edge_label(d, 500, 610, "Local state")

    # Core to external + ML, all routed from API box edge (clear and readable)
    arrow_path(d, [(1390, 220), (1460, 220), (1460, 265), (1530, 265)])  # API -> TMDB
    edge_label(d, 1460, 188, "TMDB REST API")

    arrow_path(d, [(1390, 260), (1475, 260), (1475, 495), (1530, 495)])  # API -> Cloudinary
    edge_label(d, 1568, 380, "Signed media upload")

    arrow_path(d, [(1390, 300), (1490, 300), (1490, 725), (1530, 725)])  # API -> Push
    edge_label(d, 1580, 620, "Push publish API")

    arrow_path(d, [(1390, 340), (1435, 340), (1435, 725), (1390, 725)])  # API -> ML
    edge_label(d, 1335, 620, "ML recommendations")

    d.text((50, 1205), "Sursa: elaborat de autor.", font=FONT_FOOT, fill=SUB)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", dpi=(300, 300), optimize=True)


def generate_a8(path: Path):
    w, h = 2200, 1240
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)

    rounded(d, (40, 60, 980, 1180), PANEL, BORDER, radius=24, width=3)
    rounded(d, (1020, 60, 2160, 1180), PANEL, BORDER, radius=24, width=3)
    d.text((510, 100), "Client / Demo", font=FONT_BIG, fill=TEXT, anchor="ma")
    d.text((1590, 100), "Server / Cloud", font=FONT_BIG, fill=TEXT, anchor="ma")

    dev1 = (100, 180, 920, 350)
    dev2 = (100, 410, 920, 580)
    pc = (100, 640, 920, 810)
    backend = (1100, 180, 2080, 350)
    ml = (1100, 470, 2080, 640)
    ext = (1100, 760, 2080, 930)

    draw_node(d, dev1, "Android Device #1", "Movie-Rec app", "mobile")
    draw_node(d, dev2, "Android Device #2", "Multi-user test", "mobile")
    draw_node(d, pc, "Developer PC", "Expo + monitoring", "router")
    draw_node(d, backend, "Backend Host", "Node REST + WS", "server")
    draw_node(d, ml, "ML Host", "FastAPI + Uvicorn", "ml")
    draw_node(d, ext, "External Services", "TMDB + Cloudinary + Expo Push", "cloud")

    # Client side requests
    arrow(d, (920, 265), (1100, 265))   # device1 -> backend
    edge_label(d, 1010, 228, "HTTPS app traffic")
    arrow(d, (920, 495), (1100, 265))   # device2 -> backend
    edge_label(d, 1005, 445, "Multi-user requests")
    arrow(d, (920, 725), (1100, 305))   # pc -> backend
    edge_label(d, 980, 660, "Admin/API ops")

    # Server side internal flows (no side loops, clearer)
    arrow(d, (1590, 350), (1590, 470))  # backend -> ml
    arrow(d, (1700, 350), (1700, 760))  # backend -> external providers
    # Place labels after both lines are drawn so text is never covered by arrows
    edge_label(d, 1520, 410, "Internal ML API")
    edge_label(d, 1860, 560, "TMDB / Cloudinary / Push")

    d.text((50, 1205), "Sursa: elaborat de autor.", font=FONT_FOOT, fill=SUB)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", dpi=(300, 300), optimize=True)


def generate_a9(path: Path):
    w, h = 2200, 1500
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)

    headers = [("Categorie", 300), ("Element", 560), ("Versiune / Specificatie", 520), ("Rol", 760)]
    rows = [
        ("Software dev", "Expo CLI", "SDK 55", "Build/rulare aplicatie"),
        ("Software dev", "Node.js + npm", "v20+", "Backend si tooling"),
        ("Software dev", "Python", "3.11+ / 3.12+", "Rulare ML"),
        ("Runtime", "FastAPI + Uvicorn", "ASGI stack", "Serviciu recomandari"),
        ("Runtime", "SQLite", "Embedded DB", "Persistenta locala"),
        ("Protocol", "WebSocket (RFC6455)", "Standard", "Chat live"),
        ("Serviciu extern", "TMDB API", "REST", "Metadata continut"),
        ("Serviciu extern", "Cloudinary", "Upload API", "Media gallery"),
        ("Serviciu extern", "Expo Push / FCM", "Push infra", "Notificari"),
        ("Hardware", "Laptop / PC", "16 GB RAM, SSD", "Dezvoltare"),
        ("Hardware", "Telefon Android", "Wi-Fi / 4G", "Demo aplicatie"),
    ]

    x0, y0, gap = 20, 60, 10
    h_head, h_row = 88, 112

    def draw_cell(rect, text, header=False):
        rounded(d, rect, PANEL if header else BOX, BORDER, radius=10, width=2)
        x1, y1, x2, _ = rect
        f = FONT_TITLE if header else FONT_M

        words = text.split()
        lines, cur = [], ""
        maxw = x2 - x1 - 24
        for w_ in words:
            trial = (cur + " " + w_).strip()
            bb = d.textbbox((0, 0), trial, font=f)
            if bb[2] - bb[0] <= maxw:
                cur = trial
            else:
                if cur:
                    lines.append(cur)
                cur = w_
        if cur:
            lines.append(cur)

        yy = y1 + 10
        line_h = f.size + 4
        for ln in lines:
            d.text((x1 + 12, yy), ln, font=f, fill=TEXT)
            yy += line_h

    x = x0
    for title, wcol in headers:
        draw_cell((x, y0, x + wcol, y0 + h_head), title, header=True)
        x += wcol + gap

    for i, row in enumerate(rows):
        y = y0 + h_head + 12 + i * (h_row + gap)
        x = x0
        for val, (_, wcol) in zip(row, headers):
            draw_cell((x, y, x + wcol, y + h_row), val, header=False)
            x += wcol + gap

    d.text((25, 1460), "Sursa: elaborat de autor.", font=FONT_FOOT, fill=SUB)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", dpi=(300, 300), optimize=True)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    generate_a7(OUT_DIR / "anexa_A6_component_diagram.png")
    generate_a8(OUT_DIR / "anexa_A7_deployment_diagram.png")
    generate_a9(OUT_DIR / "anexa_A8_software_hardware_table.png")
    print("Generated A6/A7/A8 (fit-page + larger text + 300dpi)")


if __name__ == "__main__":
    main()
