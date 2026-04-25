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


F_H1 = load_font(54, True)
F_H2 = load_font(34, True)
F_T = load_font(29, True)
F_B = load_font(25, False)
F_S = load_font(22, False)
F_L = load_font(21, True)


def rr(d: ImageDraw.ImageDraw, rect, fill, outline=BORDER, radius=16, w=3):
    d.rounded_rectangle(rect, radius=radius, fill=fill, outline=outline, width=w)


def draw_text_block(d: ImageDraw.ImageDraw, x: int, y: int, text: str, font, color=TEXT, line_h=30):
    for i, line in enumerate(text.split("\n")):
        d.text((x, y + i * line_h), line, font=font, fill=color)


def arrow(d: ImageDraw.ImageDraw, p1, p2, label=None, lx=None, ly=None):
    x1, y1 = p1
    x2, y2 = p2
    d.line((x1, y1, x2, y2), fill=ARROW_SOFT, width=11)
    d.line((x1, y1, x2, y2), fill=ARROW, width=6)
    if abs(x2 - x1) >= abs(y2 - y1):
        s = 1 if x2 > x1 else -1
        head = [(x2, y2), (x2 - 18 * s, y2 - 12), (x2 - 18 * s, y2 + 12)]
    else:
        s = 1 if y2 > y1 else -1
        head = [(x2, y2), (x2 - 12, y2 - 18 * s), (x2 + 12, y2 - 18 * s)]
    d.polygon(head, fill=ARROW)

    if label:
        if lx is None:
            lx = (x1 + x2) // 2
        if ly is None:
            ly = (y1 + y2) // 2
        bb = d.textbbox((0, 0), label, font=F_L)
        tw, th = bb[2] - bb[0], bb[3] - bb[1]
        rr(d, (lx - tw // 2 - 10, ly - th // 2 - 6, lx + tw // 2 + 10, ly + th // 2 + 6), BOX, ARROW, 10, 2)
        d.text((lx, ly), label, font=F_L, fill=ARROW, anchor="mm")


def arrow_path(d: ImageDraw.ImageDraw, points, label=None, lx=None, ly=None):
    if len(points) < 2:
        return
    for i in range(len(points) - 2):
        x1, y1 = points[i]
        x2, y2 = points[i + 1]
        d.line((x1, y1, x2, y2), fill=ARROW_SOFT, width=11)
        d.line((x1, y1, x2, y2), fill=ARROW, width=6)
    arrow(d, points[-2], points[-1], label=label, lx=lx, ly=ly)


def generate_a10(path: Path):
    w, h = 2500, 1600
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)

    d.text((70, 40), "Anexa A.10 - ERD (date locale + date ML remote)", font=F_H1, fill=TEXT)

    rr(d, (60, 120, 1620, 1500), PANEL, BORDER, 22, 3)
    rr(d, (1680, 120, 2440, 1500), PANEL, BORDER, 22, 3)
    d.text((90, 155), "SQLite local (app)", font=F_H2, fill=TEXT)
    d.text((1710, 155), "ML service DB", font=F_H2, fill=TEXT)

    users = (120, 240, 620, 470)
    auth = (120, 540, 620, 730)
    watch = (700, 240, 1120, 420)
    fav = (1160, 240, 1580, 420)
    watched = (700, 470, 1120, 650)
    ratings = (1160, 470, 1580, 650)
    privacy = (700, 700, 1120, 860)
    notif = (1160, 700, 1580, 900)
    subs = (930, 930, 1430, 1110)

    app_users = (1760, 280, 2360, 460)
    interactions = (1760, 560, 2360, 820)
    follows = (1760, 920, 2360, 1130)

    rr(d, users, BOX)
    draw_text_block(d, 145, 270, "users\nPK id\nbackend_user_id (sync key)\nnickname, role, profile", F_B, TEXT, 34)

    rr(d, auth, BOX)
    draw_text_block(d, 145, 565, "auth_sessions\nPK id=1\nFK user_id -> users.id", F_B, TEXT, 34)

    rr(d, watch, BOX)
    draw_text_block(d, 720, 270, "user_watchlist\nPK (user_id, tmdb_id)\nFK user_id -> users.id", F_B, TEXT, 34)

    rr(d, fav, BOX)
    draw_text_block(d, 1180, 270, "user_favorites\nPK (user_id, tmdb_id)\nFK user_id -> users.id", F_B, TEXT, 34)

    rr(d, watched, BOX)
    draw_text_block(d, 720, 500, "user_watched\nPK (user_id, tmdb_id)\nFK user_id -> users.id", F_B, TEXT, 34)

    rr(d, ratings, BOX)
    draw_text_block(d, 1180, 500, "user_ratings\nPK (user_id, tmdb_id)\nrating, media_type\nFK user_id -> users.id", F_B, TEXT, 34)

    rr(d, privacy, BOX)
    draw_text_block(d, 720, 730, "user_list_privacy\nPK user_id\nwatchlist/favorites/watched/rated", F_B, TEXT, 34)

    rr(d, notif, BOX)
    draw_text_block(d, 1180, 730, "user_notifications\nPK id\nFK user_id -> users.id\ntype, action_path, payload", F_B, TEXT, 34)

    rr(d, subs, BOX)
    draw_text_block(d, 960, 960, "notification_subscriptions\nPK (user_id, kind, target_id)\nFK user_id -> users.id", F_B, TEXT, 34)

    rr(d, app_users, BOX)
    draw_text_block(d, 1790, 315, "app_users\nPK id\n(created_at)", F_B, TEXT, 34)

    rr(d, interactions, BOX)
    draw_text_block(d, 1790, 595, "user_interactions\nPK id\nFK user_id -> app_users.id\n(tmdb_id, media_type, event_type, value)", F_B, TEXT, 34)

    rr(d, follows, BOX)
    draw_text_block(d, 1790, 955, "user_follows\nPK (follower_id, followee_id)\nFK -> app_users.id", F_B, TEXT, 34)

    # legend (explicit entity-to-entity relations + type)
    legend = (90, 1125, 1560, 1485)
    rr(d, legend, BOX, BORDER, 14, 2)
    d.text((115, 1160), "Legenda relatii (entitate -> entitate : tip)", font=F_T, fill=TEXT)
    draw_text_block(
        d,
        120,
        1200,
        "users -> auth_sessions : 1:1\n"
        "users -> user_watchlist : 1:N\n"
        "users -> user_favorites : 1:N\n"
        "users -> user_watched : 1:N\n"
        "users -> user_ratings : 1:N\n"
        "users -> user_list_privacy : 1:1\n"
        "users -> user_notifications : 1:N\n"
        "users -> notification_subscriptions : 1:N\n"
        "app_users -> user_interactions : 1:N\n"
        "app_users -> user_follows : 1:N\n"
        "users.backend_user_id -> app_users.id : sync mapping (logical 1:1)",
        F_S,
        TEXT,
        25,
    )

    # local relations (orthogonal channels, no entity overlap)
    # users -> watch
    arrow_path(d, [(620, 300), (700, 300)], "1:N", 660, 265)
    # users -> fav (top channel)
    arrow_path(d, [(620, 320), (650, 320), (650, 210), (1140, 210), (1140, 300), (1160, 300)], "1:N", 900, 175)
    # users -> watched
    arrow_path(d, [(620, 350), (650, 350), (650, 560), (700, 560)], "1:N", 675, 505)
    # users -> ratings (middle channel between rows)
    arrow_path(d, [(620, 370), (655, 370), (655, 680), (1140, 680), (1140, 560), (1160, 560)], "1:N", 900, 645)
    # users -> privacy
    arrow_path(d, [(620, 400), (660, 400), (660, 780), (700, 780)], "1:1", 680, 735)
    # users -> notifications (lower channel)
    arrow_path(d, [(620, 420), (665, 420), (665, 915), (1140, 915), (1140, 800), (1160, 800)], "1:N", 930, 945)
    # users -> subscriptions
    arrow_path(d, [(620, 440), (670, 440), (670, 1020), (930, 1020)], "1:N", 745, 985)
    # users -> auth_sessions
    arrow_path(d, [(370, 470), (370, 540)], "1:1", 430, 505)

    # remote relations
    # app_users -> interactions
    arrow_path(d, [(2060, 460), (2060, 560)], "1:N", 2145, 510)
    # app_users -> follows (right-side channel to avoid crossing interactions)
    arrow_path(d, [(2300, 460), (2390, 460), (2390, 1025), (2360, 1025)], "1:N", 2340, 740)

    # sync bridge (dashed top channel, outside entities)
    dash_points = [(370, 240), (370, 210), (2060, 210), (2060, 280)]
    for i in range(len(dash_points) - 1):
        d.line((dash_points[i][0], dash_points[i][1], dash_points[i + 1][0], dash_points[i + 1][1]), fill=ARROW, width=4)
    d.polygon([(2060, 280), (2046, 258), (2074, 258)], fill=ARROW)
    edge = "sync by backend_user_id"
    bb = d.textbbox((0, 0), edge, font=F_L)
    tw = bb[2] - bb[0]
    rr(d, (1210 - tw // 2 - 10, 185, 1210 + tw // 2 + 10, 225), BOX, ARROW, 10, 2)
    d.text((1210, 205), edge, font=F_L, fill=ARROW, anchor="mm")

    d.text((70, 1540), "Sursa: elaborat de autor pe baza schemei implementate in proiect.", font=F_S, fill=SUB)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", dpi=(300, 300), optimize=True)


def generate_a11(path: Path):
    w, h = 2500, 1600
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)

    d.text((70, 40), "Anexa A.11 - Schema tabele principale", font=F_H1, fill=TEXT)

    headers = [("Tabel", 430), ("Cheie primara", 360), ("Chei externe", 620), ("Campuri importante", 1020)]
    rows = [
        ("users", "id", "-", "backend_user_id, nickname, role, created_at"),
        ("auth_sessions", "id (check=1)", "user_id -> users.id", "created_at"),
        ("user_watchlist", "(user_id, tmdb_id)", "user_id -> users.id", "media_type, created_at"),
        ("user_favorites", "(user_id, tmdb_id)", "user_id -> users.id", "media_type, created_at"),
        ("user_watched", "(user_id, tmdb_id)", "user_id -> users.id", "media_type, created_at"),
        ("user_ratings", "(user_id, tmdb_id)", "user_id -> users.id", "rating, media_type, updated_at"),
        ("user_list_privacy", "user_id", "user_id -> users.id", "watchlist, favorites, watched, rated"),
        ("user_notifications", "id", "user_id -> users.id", "type, action_path, payload_json, read_at"),
        ("notification_subscriptions", "(user_id, kind, target_id)", "user_id -> users.id", "payload_json, created_at"),
        ("app_users (ML)", "id", "-", "created_at"),
        ("user_interactions (ML)", "id", "user_id -> app_users.id", "tmdb_id, media_type, event_type, event_value"),
        ("user_follows (ML)", "(follower_id, followee_id)", "both -> app_users.id", "created_at"),
    ]

    x0, y0, gap = 50, 120, 12
    h_head, h_row = 78, 98

    def cell(rect, txt, head=False):
        rr(d, rect, PANEL if head else BOX, BORDER, 10, 2)
        x1, y1, x2, _ = rect
        f = F_T if head else F_B
        maxw = x2 - x1 - 20
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
        for ln in lines[:3]:
            d.text((x1 + 10, yy), ln, font=f, fill=TEXT)
            yy += lh

    x = x0
    for t, cw in headers:
        cell((x, y0, x + cw, y0 + h_head), t, True)
        x += cw + gap

    for i, row in enumerate(rows):
        y = y0 + h_head + 10 + i * (h_row + gap)
        x = x0
        for val, (_, cw) in zip(row, headers):
            cell((x, y, x + cw, y + h_row), val, False)
            x += cw + gap

    d.text((60, 1540), "Sursa: elaborat de autor pe baza DDL local (expo-sqlite) si schema ML.", font=F_S, fill=SUB)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", dpi=(300, 300), optimize=True)


def swimlane(d, x1, x2, y1, y2, title):
    rr(d, (x1, y1, x2, y2), PANEL, BORDER, 14, 2)
    rr(d, (x1 + 8, y1 + 8, x2 - 8, y1 + 48), BOX, BORDER, 10, 2)
    d.text(((x1 + x2) // 2, y1 + 30), title, font=F_T, fill=TEXT, anchor="mm")


def step_box(d, x, y, w, h, txt):
    rr(d, (x, y, x + w, y + h), BOX, BORDER, 10, 2)
    draw_text_block(d, x + 10, y + 10, txt, F_S, TEXT, 27)


def generate_a12(path: Path):
    w, h = 2600, 1700
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)

    d.text((60, 40), "Anexa A.12 - Secvente de sincronizare (login, movie-state, notificari)", font=F_H1, fill=TEXT)

    # lanes
    y_top, y_bot = 120, 1610
    lanes = [
        (60, 620, "Client (Expo App)"),
        (660, 1280, "Backend API"),
        (1320, 1960, "SQLite local"),
        (2000, 2540, "ML / Push services"),
    ]
    for x1, x2, title in lanes:
        swimlane(d, x1, x2, y_top, y_bot, title)

    # login sync
    step_box(d, 90, 210, 500, 86, "1) Login request\n(email/nickname + password)")
    arrow(d, (590, 253), (660, 253), "POST /auth/login", 625, 220)
    step_box(d, 690, 210, 560, 86, "2) Validate user + issue session\nreturn user + session token")
    arrow(d, (1280, 253), (1320, 253), "save session", 1300, 220)
    step_box(d, 1350, 210, 580, 86, "3) Store local session\n+ backend_user_id mapping")

    # movie-state sync
    step_box(d, 90, 500, 500, 96, "4) Toggle watched/favorite/rating\noptimistic local update")
    arrow(d, (590, 548), (1320, 548), "local write", 960, 510)
    step_box(d, 1350, 500, 580, 96, "5) Persist local movie-state\n(user_watchlist/favorites/watched/ratings)")
    arrow(d, (590, 620), (660, 620), "POST /movie-state", 625, 585)
    step_box(d, 690, 580, 560, 96, "6) Backend validates + stores\nreturns canonical state")
    arrow(d, (1250, 628), (2000, 628), "ingest interaction", 1620, 590)
    step_box(d, 2030, 580, 480, 96, "7) ML ingest\ninvalidate/rebuild model")

    # notifications sync
    step_box(d, 90, 900, 500, 96, "8) Register push token\n(on login/app start)")
    arrow(d, (590, 948), (660, 948), "POST /notifications/push/register", 720, 905)
    step_box(d, 690, 900, 560, 96, "9) Save token + subscriptions\nprepare push payloads")
    arrow(d, (1250, 948), (2000, 948), "send push", 1630, 910)
    step_box(d, 2030, 900, 480, 96, "10) Expo Push / FCM delivery\nuser gets notification")

    # fallback lane note
    rr(d, (90, 1180, 2440, 1510), BOX, BORDER, 12, 2)
    draw_text_block(
        d,
        120,
        1210,
        "Fallback logic (backend-first + local fallback):\n"
        "- daca backend este disponibil: client -> backend -> confirmare -> update local final\n"
        "- daca backend este indisponibil: schimbarea ramane local marcata pending\n"
        "- la reconnect: se trimite batch sync catre backend si apoi catre ML\n"
        "- consistenta finala este data de raspunsul backend (canonical state)",
        F_B,
        TEXT,
        34,
    )

    d.text((70, 1640), "Sursa: elaborat de autor pe baza fluxurilor implementate in backend + app + ML.", font=F_S, fill=SUB)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", dpi=(300, 300), optimize=True)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    generate_a10(OUT_DIR / "anexa_A10_erd_model_sync.png")
    generate_a11(OUT_DIR / "anexa_A11_schema_tabele_principale.png")
    generate_a12(OUT_DIR / "anexa_A12_secvente_sync.png")
    print("Generated A10/A11/A12")


if __name__ == "__main__":
    main()
