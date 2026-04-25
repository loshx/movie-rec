from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


OUT_DIR = Path(__file__).resolve().parent
W, H = 2400, 1900
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


FONT_HEAD = load_font(30, bold=True)
FONT_TEXT = load_font(22, bold=False)
FONT_FOOT = load_font(20, bold=False)


def draw_cell(draw, rect, text, font, fill, text_color=TEXT, align="left"):
    draw.rounded_rectangle(rect, radius=10, fill=fill, outline=LINE, width=2)
    x1, y1, x2, y2 = rect
    if align == "center":
        draw.text(((x1 + x2) // 2, (y1 + y2) // 2), text, font=font, fill=text_color, anchor="mm")
        return
    draw.text((x1 + 14, (y1 + y2) // 2), text, font=font, fill=text_color, anchor="lm")


def generate_annex_a5(path: Path):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    headers = [("ID", 170), ("Tip", 140), ("Cerință", 1460), ("Prioritate", 420)]
    rows = [
        ("FR-01", "FR", "Sistemul permite înregistrare, autentificare și deconectare utilizator.", "Critică"),
        ("FR-02", "FR", "Utilizatorul poate edita profilul și seta vizibilitatea listelor.", "Înaltă"),
        ("FR-03", "FR", "Utilizatorul gestionează stările: watchlist, favorite, watched, rating.", "Critică"),
        ("FR-04", "FR", "Aplicația afișează recomandări personalizate în secțiunea For You.", "Critică"),
        ("FR-05", "FR", "Sistemul oferă căutare pentru filme, seriale, actori și regizori.", "Înaltă"),
        ("FR-06", "FR", "Utilizatorul poate filtra pe categorie, an și sortare după ranking.", "Medie"),
        ("FR-07", "FR", "Pagina detalii prezintă trailer, cast, similar și comentarii.", "Înaltă"),
        ("FR-08", "FR", "Modul Cinema afișează event live/upcoming cu countdown.", "Înaltă"),
        ("FR-09", "FR", "Utilizatorul votează o singură dată în poll-ul activ.", "Înaltă"),
        ("FR-10", "FR", "Chat live suportă trimitere/primire mesaje prin WebSocket.", "Înaltă"),
        ("FR-11", "FR", "Gallery suportă like, favorite, comentarii și reply-uri.", "Înaltă"),
        ("FR-12", "FR", "Sistemul oferă notificări în aplicație și push.", "Înaltă"),
        ("FR-13", "FR", "Adminul poate crea/închide poll și publica cinema event.", "Critică"),
        ("FR-14", "FR", "Adminul poate importa și șterge itemi gallery.", "Înaltă"),
        ("FR-15", "FR", "Sistemul suportă follow/unfollow și vizualizare profil public.", "Medie"),
        ("FR-16", "FR", "Datele utilizatorului se sincronizează către backend și ML ingest.", "Critică"),
        ("NFR-01", "NFR", "Interfața principală răspunde rapid pe dispozitive mobile.", "Critică"),
        ("NFR-02", "NFR", "Sistemul funcționează și în fallback local când backend-ul lipsește.", "Înaltă"),
        ("NFR-03", "NFR", "Accesul la funcțiile admin este protejat prin rol și cheie admin.", "Critică"),
        ("NFR-04", "NFR", "Arhitectura este modulară: App, Backend, ML, servicii externe.", "Înaltă"),
        ("NFR-05", "NFR", "Persistența datelor locale folosește SQLite cu migrare sigură.", "Înaltă"),
        ("NFR-06", "NFR", "Comunicarea realtime respectă protocol WebSocket standard.", "Înaltă"),
    ]

    x0, y0 = 40, 40
    header_h, row_h = 66, 72

    x = x0
    for t, w in headers:
        draw_cell(d, (x, y0, x + w, y0 + header_h), t, FONT_HEAD, fill=(25, 76, 128), text_color=WHITE, align="center")
        x += w + 10

    for idx, row in enumerate(rows):
        y = y0 + header_h + 12 + idx * (row_h + 8)
        x = x0
        fill = (16, 38, 63) if idx % 2 == 0 else (18, 44, 73)
        for col_i, ((_, w), cell) in enumerate(zip(headers, row)):
            align = "center" if col_i in (0, 1, 3) else "left"
            draw_cell(d, (x, y, x + w, y + row_h), cell, FONT_TEXT, fill=fill, align=align)
            x += w + 10

    d.text(
        (40, H - 40),
        "Sursa: elaborat de autor, pe baza cerințelor extrase din proiectul Movie-Rec.",
        font=FONT_FOOT,
        fill=(184, 201, 230),
        anchor="ls",
    )

    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG")


def generate_annex_a6(path: Path):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    headers = [("ReqID", 200), ("Componente impactate", 1120), ("Verificare / test", 1020)]
    rows = [
        ("FR-01", "auth.tsx, login.tsx, register.tsx, /api/auth/local/*", "Test cont nou + login/logout + persistare sesiune"),
        ("FR-03", "user-movies.ts, movie/[id].tsx, database.ts", "Toggle stări + rating, verificare DB local/remot"),
        ("FR-04", "ml-recommendations.ts, index.tsx, ml/api.py", "Comparare listă For You cu date profil user"),
        ("FR-05", "search panel home + tmdb.ts", "Căutare titlu/actor/regizor pe query-uri reale"),
        ("FR-08", "cinema.tsx, cinema-backend.ts, /api/cinema/current", "Afișare countdown și intrare în live"),
        ("FR-09", "cinema.tsx, /api/cinema/poll/*", "Vote once + blocare revotare + rezultate"),
        ("FR-10", "cinema.tsx, WebSocket /ws, chat store server", "Mesaj trimis/recepționat între două dispozitive"),
        ("FR-11", "gallery.tsx, gallery db/api, comments", "Like/favorite/comment/reply + refresh feed"),
        ("FR-12", "NotificationsContext, notifications.tsx, push API", "Notificare internă + push token register"),
        ("FR-13", "admin.tsx, /api/cinema/poll, /api/cinema/events", "Creare poll/event și afișare pe client"),
        ("FR-16", "ml-sync.ts, backend sync profile, /ingest", "Sincronizare interacțiuni și verificare ML health"),
        ("NFR-03", "middleware/admin key checks server", "Acces endpoint admin permis doar cu cheie validă"),
        ("NFR-06", "RFC6455 WS stack + client socket", "Stabilitate conexiune chat pe sesiuni extinse"),
    ]

    x0, y0 = 40, 80
    header_h, row_h = 70, 115

    x = x0
    for t, w in headers:
        draw_cell(d, (x, y0, x + w, y0 + header_h), t, FONT_HEAD, fill=(25, 76, 128), text_color=WHITE, align="center")
        x += w + 10

    for idx, row in enumerate(rows):
        y = y0 + header_h + 14 + idx * (row_h + 10)
        x = x0
        fill = (16, 38, 63) if idx % 2 == 0 else (18, 44, 73)
        for col_i, ((_, w), cell) in enumerate(zip(headers, row)):
            align = "center" if col_i == 0 else "left"
            draw_cell(d, (x, y, x + w, y + row_h), cell, FONT_TEXT, fill=fill, align=align)
            x += w + 10

    d.text(
        (40, H - 40),
        "Sursa: elaborat de autor; matrice de trasabilitate cerință -> componentă -> verificare.",
        font=FONT_FOOT,
        fill=(184, 201, 230),
        anchor="ls",
    )

    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG")


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    generate_annex_a5(OUT_DIR / "anexa_A5_tabel_cerinte_fr_nfr.png")
    generate_annex_a6(OUT_DIR / "anexa_A6_matrice_trasabilitate_cerinte.png")
    print("Generated annexes in:", OUT_DIR)


if __name__ == "__main__":
    main()
