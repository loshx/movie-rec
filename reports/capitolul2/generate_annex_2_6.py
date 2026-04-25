# -*- coding: utf-8 -*-
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = Path(__file__).resolve().parent

BG = (248, 251, 255)
PANEL = (236, 243, 255)
BOX = (255, 255, 255)
BORDER = (44, 84, 140)
TEXT = (30, 48, 78)
SUB = (88, 112, 150)
ARROW = (14, 64, 132)
ARROW_SOFT = (186, 214, 248)


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


F_H1 = load_font(66, True)
F_H2 = load_font(44, True)
F_T = load_font(36, True)
F_B = load_font(32, False)
F_S = load_font(28, False)
F_L = load_font(28, True)


def rr(d: ImageDraw.ImageDraw, rect, fill, outline=BORDER, radius=14, w=3):
    d.rounded_rectangle(rect, radius=radius, fill=fill, outline=outline, width=w)


def text_block(d: ImageDraw.ImageDraw, x: int, y: int, text: str, font, color=TEXT, lh=38):
    for i, line in enumerate(text.split("\n")):
        d.text((x, y + i * lh), line, font=font, fill=color)


def arrow(d: ImageDraw.ImageDraw, p1, p2, label=None, lx=None, ly=None):
    x1, y1 = p1
    x2, y2 = p2
    d.line((x1, y1, x2, y2), fill=ARROW_SOFT, width=10)
    d.line((x1, y1, x2, y2), fill=ARROW, width=5)
    if abs(x2 - x1) >= abs(y2 - y1):
        s = 1 if x2 > x1 else -1
        head = [(x2, y2), (x2 - 16 * s, y2 - 11), (x2 - 16 * s, y2 + 11)]
    else:
        s = 1 if y2 > y1 else -1
        head = [(x2, y2), (x2 - 11, y2 - 16 * s), (x2 + 11, y2 - 16 * s)]
    d.polygon(head, fill=ARROW)

    if label:
        if lx is None:
            lx = (x1 + x2) // 2
        if ly is None:
            ly = (y1 + y2) // 2
        bb = d.textbbox((0, 0), label, font=F_L)
        tw, th = bb[2] - bb[0], bb[3] - bb[1]
        rr(d, (lx - tw // 2 - 8, ly - th // 2 - 6, lx + tw // 2 + 8, ly + th // 2 + 6), BOX, ARROW, 8, 2)
        d.text((lx, ly), label, font=F_L, fill=ARROW, anchor="mm")


def table_cell(d, rect, txt, head=False):
    rr(d, rect, PANEL if head else BOX, BORDER, 10, 2)
    x1, y1, x2, y2 = rect
    f = F_T if head else F_B
    maxw = x2 - x1 - 16
    words = str(txt).split()
    lines, cur = [], ""
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
    yy = y1 + 8
    lh = f.size + 4
    for line in lines[:4]:
        d.text((x1 + 8, yy), line, font=f, fill=TEXT)
        yy += lh


def generate_a13(path: Path):
    w, h = 3400, 2200
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)

    d.text((80, 50), "Anexa A.13 - Pipeline ML (ingest -> train -> infer -> explain)", font=F_H1, fill=TEXT)

    rr(d, (70, 170, 1070, 2040), PANEL, BORDER, 18, 3)
    rr(d, (1190, 170, 2290, 2040), PANEL, BORDER, 18, 3)
    rr(d, (2410, 170, 3330, 2040), PANEL, BORDER, 18, 3)
    d.text((570, 220), "Input + Ingest", font=F_H2, fill=TEXT, anchor="ma")
    d.text((1740, 220), "Train Artifacts", font=F_H2, fill=TEXT, anchor="ma")
    d.text((2870, 220), "Infer + Explain", font=F_H2, fill=TEXT, anchor="ma")

    rr(d, (120, 300, 1020, 700), BOX)
    text_block(d, 155, 345, "Input events:\n- watchlist (0.5)\n- watched (1.0)\n- favorite (2.0)\n- favorite_actor (1.65)\n- rating 0..10 -> 0..2", F_B, TEXT, 52)

    rr(d, (120, 760, 1020, 1160), BOX)
    text_block(d, 155, 805, "Normalize:\n- latest event state\n- recency decay (240 zile)\n- clip score [0, 6]\n- clean duplicates", F_B, TEXT, 52)

    rr(d, (120, 1220, 1020, 1640), BOX)
    text_block(d, 155, 1265, "Ingest endpoints:\nPOST /ingest\nPOST /ingest/batch\nPOST /ingest/replace-user\nPOST /follows/sync", F_B, TEXT, 52)

    rr(d, (1240, 320, 2240, 760), BOX)
    text_block(d, 1275, 365, "Build matrices:\n- user_item pivot\n- csr sparse matrix\n- user_index + item_index", F_B, TEXT, 54)

    rr(d, (1240, 820, 2240, 1260), BOX)
    text_block(d, 1275, 865, "Fit models:\n- user KNN (cosine)\n- item KNN (cosine)\n- TruncatedSVD\n- popularity series", F_B, TEXT, 54)

    rr(d, (1240, 1320, 2240, 1760), BOX)
    text_block(d, 1275, 1365, "Store artifacts:\nRecoArtifacts{\ninteractions, knn, item_knn,\nsvd, popularity, follows\n}", F_B, TEXT, 54)

    rr(d, (2460, 320, 3280, 860), BOX)
    text_block(d, 2495, 365, "Recommend flow:\n- user_knn\n- item_knn\n- profile_similar\n- svd\n- follow_taste\n- popularity", F_B, TEXT, 52)

    rr(d, (2460, 920, 3280, 1460), BOX)
    text_block(d, 2495, 965, "Blend + filter:\n- dynamic blend by seen_count\n- remove already seen\n- min signal threshold\n- cold-start fallback\n- top_n + reason", F_B, TEXT, 50)

    rr(d, (2460, 1520, 3280, 1940), BOX)
    text_block(d, 2495, 1565, "Explain endpoint:\nGET /explain/{user}/{tmdb}\nreturns: final_score,\nscore_parts, neighbors,\nsimilar_seen_items", F_B, TEXT, 50)

    arrow(d, (1020, 510), (1240, 510), "normalized")
    arrow(d, (1020, 960), (1240, 980), "train input")
    arrow(d, (1020, 1430), (1240, 1500), "ingest")
    arrow(d, (2240, 530), (2460, 530), "artifacts")
    arrow(d, (2240, 1050), (2460, 1090), "scores")
    arrow(d, (2240, 1540), (2460, 1700), "explain data")

    d.text((80, 2115), "Sursa: elaborat de autor pe baza logicii reale din ml/train.py + ml/api.py.", font=F_S, fill=SUB)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", dpi=(300, 300), optimize=True)


def generate_a14(path: Path):
    w, h = 3400, 2200
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)

    d.text((80, 50), "Anexa A.14 - Semnale si ponderi in scorul final", font=F_H1, fill=TEXT)

    rr(d, (80, 180, 1650, 2060), PANEL, BORDER, 18, 3)
    rr(d, (1750, 180, 3320, 2060), PANEL, BORDER, 18, 3)
    d.text((865, 230), "A) Event weights", font=F_H2, fill=TEXT, anchor="ma")
    d.text((2535, 230), "B) Dynamic blend", font=F_H2, fill=TEXT, anchor="ma")

    cards_left = [
        ("watchlist", "0.50", "intentie initiala"),
        ("watched", "1.00", "consum explicit"),
        ("favorite", "2.00", "semnal puternic"),
        ("favorite_actor", "1.65", "preferinta contextuala"),
        ("rating", "0..10 -> 0..2", "normalizare liniara"),
        ("recency", "half-life 240 zile", "boost/slabire in timp"),
    ]
    y = 300
    for sig, val, note in cards_left:
        rr(d, (130, y, 1600, y + 250), BOX)
        d.text((170, y + 40), sig, font=F_T, fill=TEXT)
        d.text((600, y + 40), val, font=F_T, fill=ARROW)
        d.text((170, y + 125), note, font=F_B, fill=SUB)
        y += 290

    cards_right = [
        (">=18 seen", "user_knn 0.37 | item_knn 0.33 | svd 0.20 | follow 0.08 | pop 0.02"),
        (">=8 seen", "user_knn 0.35 | item_knn 0.31 | svd 0.20 | follow 0.10 | pop 0.04"),
        (">=1 seen", "user_knn 0.28 | item_knn 0.24 | svd 0.18 | follow 0.10 | pop 0.20"),
        ("0 seen", "user_knn 0.08 | item_knn 0.06 | svd 0.06 | follow 0.05 | pop 0.75"),
        ("no follows", "follow=0 -> redistribuire: item +0.50f, svd +0.30f, pop +0.20f"),
        ("many follows", "follow_boost +0.03 (cap 0.22), popularity -0.02"),
    ]
    y = 300
    for level, desc in cards_right:
        rr(d, (1800, y, 3270, y + 250), BOX)
        d.text((1840, y + 38), level, font=F_T, fill=TEXT)
        text_block(d, 1840, y + 115, desc, F_B, SUB, 40)
        y += 290

    d.text((80, 2115), "Sursa: elaborat de autor pe baza constantelor/event rules din ml/train.py.", font=F_S, fill=SUB)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", dpi=(300, 300), optimize=True)


def generate_a15(path: Path):
    w, h = 3400, 2200
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)

    d.text((80, 50), "Anexa A.15 - Exemplu output /recommendations si /explain", font=F_H1, fill=TEXT)

    rr(d, (80, 180, 3320, 1040), PANEL, BORDER, 16, 3)
    d.text((120, 235), "A) GET /recommendations/{user_id}?media_type=movie&top_n=5", font=F_H2, fill=TEXT)
    rec_json = (
        '{\n'
        '  "user_id": 17,\n'
        '  "media_type": "movie",\n'
        '  "model_rows": 4287,\n'
        '  "items": [\n'
        '    {"tmdb_id": 157336, "score": 0.812, "reason": "knn+item+svd"},\n'
        '    {"tmdb_id": 603,    "score": 0.779, "reason": "profile+hybrid"},\n'
        '    {"tmdb_id": 11,     "score": 0.744, "reason": "follow+item+svd"},\n'
        '    {"tmdb_id": 27205,  "score": 0.701, "reason": "item_knn"},\n'
        '    {"tmdb_id": 19995,  "score": 0.672, "reason": "popularity"}\n'
        '  ]\n'
        '}'
    )
    text_block(d, 130, 310, rec_json, F_B, TEXT, 44)

    rr(d, (80, 1120, 3320, 2060), PANEL, BORDER, 16, 3)
    d.text((120, 1175), "B) GET /explain/{user_id}/{tmdb_id}?media_type=movie", font=F_H2, fill=TEXT)
    exp_json = (
        '{\n'
        '  "user_id": 17,\n'
        '  "tmdb_id": 157336,\n'
        '  "already_seen": false,\n'
        '  "final_score": 0.812,\n'
        '  "score_parts": {\n'
        '    "user_knn": 0.276,\n'
        '    "item_knn": 0.221,\n'
        '    "svd": 0.161,\n'
        '    "follow_taste": 0.112,\n'
        '    "popularity": 0.042\n'
        '  },\n'
        '  "top_neighbor_users": [\n'
        '    {"user_id": 8, "similarity": 0.91, "interaction_score": 1.75},\n'
        '    {"user_id": 24, "similarity": 0.87, "interaction_score": 1.64}\n'
        '  ],\n'
        '  "similar_seen_items": [\n'
        '    {"tmdb_id": 157347, "similarity": 0.84, "user_strength": 2.11},\n'
        '    {"tmdb_id": 603, "similarity": 0.79, "user_strength": 1.95}\n'
        '  ]\n'
        '}'
    )
    text_block(d, 130, 1255, exp_json, F_B, TEXT, 42)

    d.text((80, 2115), "Sursa: elaborat de autor (structura endpoint-uri din ml/api.py + explain din ml/train.py).", font=F_S, fill=SUB)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", dpi=(300, 300), optimize=True)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    generate_a13(OUT_DIR / "anexa_A13_pipeline_ml.png")
    generate_a14(OUT_DIR / "anexa_A14_semnale_ponderi.png")
    generate_a15(OUT_DIR / "anexa_A15_exemplu_output_ml.png")
    print("Generated A13/A14/A15")


if __name__ == "__main__":
    main()
