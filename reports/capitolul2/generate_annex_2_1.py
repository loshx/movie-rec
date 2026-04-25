from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


OUT_DIR = Path(__file__).resolve().parent

W, H = 2200, 1300
BG = (7, 20, 37)
WHITE = (245, 247, 255)
TEXT = (231, 239, 255)
LINE = (209, 222, 245)


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


FONT_TITLE = load_font(50, bold=True)
FONT_H2 = load_font(34, bold=True)
FONT_TEXT = load_font(24, bold=False)
FONT_FOOT = load_font(20, bold=False)


def draw_rounded_box(draw, rect, fill, outline=LINE, radius=24, width=3):
    draw.rounded_rectangle(rect, radius=radius, fill=fill, outline=outline, width=width)


def draw_multiline(draw, x, y, lines, font, fill=TEXT, line_gap=8):
    cur_y = y
    for ln in lines:
        draw.text((x, cur_y), ln, font=font, fill=fill)
        bbox = draw.textbbox((x, cur_y), ln, font=font)
        cur_y = bbox[3] + line_gap


def generate_problem_objective_tree(path: Path):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # Top boxes
    problem = (90, 180, 1030, 560)
    objective = (1170, 180, 2110, 560)
    draw_rounded_box(d, problem, fill=(74, 31, 45))
    draw_rounded_box(d, objective, fill=(17, 58, 47))

    d.text((560, 230), "Problema principală", font=FONT_H2, fill=WHITE, anchor="ma")
    draw_multiline(
        d,
        130,
        280,
        [
            "- Catalog multimedia foarte mare => userul pierde timp la selecție",
            "- Recomandări generice, fără adaptare suficientă la gusturi",
            "- Cold-start pentru user nou și item nou",
            "- Fără mecanisme live/social, retenția scade",
        ],
        FONT_TEXT,
    )

    d.text((1640, 230), "Obiectiv general", font=FONT_H2, fill=WHITE, anchor="ma")
    draw_multiline(
        d,
        1210,
        280,
        [
            "- Recomandări personalizate, rapide și explicabile",
            "- Combinare semnale: watched/favorites/ratings + metadata",
            "- Experiență unificată: Home, Cinema Live, Gallery, Notifications",
            "- Arhitectură modulară: App + Backend + ML + API externe",
        ],
        FONT_TEXT,
    )

    # Lower boxes
    o1 = (90, 700, 740, 1130)
    o2 = (790, 700, 1440, 1130)
    o3 = (1490, 700, 2110, 1130)
    for r in (o1, o2, o3):
        draw_rounded_box(d, r, fill=(13, 62, 90))

    d.text((415, 750), "O1 - Date și profil", font=FONT_H2, fill=WHITE, anchor="ma")
    draw_multiline(
        d,
        125,
        800,
        [
            "- Colectare coerentă acțiuni user",
            "- Sincronizare locală/remotă predictibilă",
            "- Model de date stabil pentru user state",
        ],
        FONT_TEXT,
    )

    d.text((1115, 750), "O2 - Motor recomandare", font=FONT_H2, fill=WHITE, anchor="ma")
    draw_multiline(
        d,
        825,
        800,
        [
            "- KNN user/item + SVD + popularity fallback",
            "- Excludere titluri deja văzute unde e necesar",
            "- Scoruri utile pentru feed-ul For You",
        ],
        FONT_TEXT,
    )

    d.text((1800, 750), "O3 - UX și engagement", font=FONT_H2, fill=WHITE, anchor="ma")
    draw_multiline(
        d,
        1520,
        800,
        [
            "- UI simplu și fluid pe mobil",
            "- Cinema live + poll + chat realtime",
            "- Notificări relevante pentru revenire în app",
        ],
        FONT_TEXT,
    )

    # Arrows
    d.line((1030, 370, 1170, 370), fill=LINE, width=4)
    d.polygon([(1170, 370), (1148, 358), (1148, 382)], fill=LINE)

    for sx, sy, tx, ty in [
        (560, 560, 415, 700),
        (1640, 560, 1115, 700),
        (1640, 560, 1800, 700),
    ]:
        d.line((sx, sy, tx, ty), fill=LINE, width=4)
        d.polygon([(tx, ty), (tx - 14, ty - 24), (tx + 14, ty - 24)], fill=LINE)

    d.text(
        (60, 1245),
        "Sursa: elaborat de autor, pe baza analizei proiectului Movie-Rec.",
        font=FONT_FOOT,
        fill=(184, 201, 230),
    )

    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG")


def generate_objective_kpi_matrix(path: Path):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    cols = [
        ("ID", 120),
        ("Obiectiv", 920),
        ("Indicator (KPI)", 760),
        ("Țintă", 360),
    ]
    rows = [
        ("O1", "Date utilizator curate", "Rată sincronizare reușită", ">= 98%"),
        ("O2", "Recomandări relevante", "Precision@10", ">= 0.30"),
        ("O3", "Acoperire recomandări", "Recall@10", ">= 0.20"),
        ("O4", "Utilitate per sesiune", "Hit Rate@10", ">= 0.70"),
        ("O5", "Interacțiune live stabilă", "Mesaje live livrate", "fără pierderi vizibile"),
        ("O6", "Răspuns rapid", "Latență recomandări", "< 1.5 sec"),
        ("O7", "UX mobil fluid", "Crash-free sessions", ">= 99%"),
    ]

    x0, y0 = 60, 170
    header_h = 80
    row_h = 110

    # Header
    x = x0
    for title, w in cols:
        draw_rounded_box(d, (x, y0, x + w, y0 + header_h), fill=(25, 76, 128), radius=16)
        d.text((x + w // 2, y0 + header_h // 2), title, font=FONT_H2, fill=WHITE, anchor="mm")
        x += w + 10

    # Rows
    for ridx, row in enumerate(rows):
        y = y0 + header_h + 18 + ridx * (row_h + 12)
        x = x0
        for cidx, (cell, (_, w)) in enumerate(zip(row, cols)):
            fill = (16, 38, 63) if ridx % 2 == 0 else (18, 44, 73)
            draw_rounded_box(d, (x, y, x + w, y + row_h), fill=fill, radius=12, width=2)
            anchor = "mm" if cidx == 0 else "lm"
            tx = x + w // 2 if cidx == 0 else x + 16
            ty = y + row_h // 2
            d.text((tx, ty), cell, font=FONT_TEXT, fill=TEXT, anchor=anchor)
            x += w + 10

    d.text(
        (60, 1245),
        "Sursa: elaborat de autor; indicatorii sunt aliniați cu evaluarea Top-N și cu cerințele proiectului.",
        font=FONT_FOOT,
        fill=(184, 201, 230),
    )

    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG")


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    generate_problem_objective_tree(OUT_DIR / "anexa_A3_arbore_problema_obiective.png")
    generate_objective_kpi_matrix(OUT_DIR / "anexa_A4_matrice_obiective_kpi.png")
    print("Generated annexes in:", OUT_DIR)


if __name__ == "__main__":
    main()
