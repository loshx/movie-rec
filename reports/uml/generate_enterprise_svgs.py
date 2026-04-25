from __future__ import annotations

import argparse
import webbrowser
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


@dataclass
class Point:
    x: float
    y: float


class SvgCanvas:
    def __init__(self, width: int, height: int, background: str = "#0B1020") -> None:
        self.width = width
        self.height = height
        self._elements: list[str] = []
        self._elements.append(
            f'<rect x="0" y="0" width="{width}" height="{height}" fill="{background}" />'
        )

    def add(self, element: str) -> None:
        self._elements.append(element)

    def defs(self) -> str:
        return """
<defs>
  <filter id="softShadow" x="-30%" y="-30%" width="160%" height="160%">
    <feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000000" flood-opacity="0.35"/>
  </filter>
  <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3.5" orient="auto">
    <polygon points="0 0, 9 3.5, 0 7" fill="#A8B3CF"/>
  </marker>
</defs>
"""

    def render(self) -> str:
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.width}" height="{self.height}" '
            f'viewBox="0 0 {self.width} {self.height}" font-family="Segoe UI, Arial, sans-serif">'
            + self.defs()
            + "".join(self._elements)
            + "</svg>"
        )


def _esc(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def draw_title(canvas: SvgCanvas, text: str, subtitle: str) -> None:
    canvas.add(
        f'<text x="{canvas.width/2}" y="44" fill="#F4F7FF" font-size="28" text-anchor="middle" font-weight="700">{_esc(text)}</text>'
    )
    canvas.add(
        f'<text x="{canvas.width/2}" y="70" fill="#A8B3CF" font-size="14" text-anchor="middle">{_esc(subtitle)}</text>'
    )


def draw_panel(
    canvas: SvgCanvas,
    x: float,
    y: float,
    w: float,
    h: float,
    title: str,
    fill: str = "#101A33",
    border: str = "#2B3E72",
) -> None:
    canvas.add(
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="18" fill="{fill}" stroke="{border}" stroke-width="1.5" filter="url(#softShadow)" />'
    )
    canvas.add(
        f'<text x="{x+16}" y="{y+30}" fill="#EAF0FF" font-size="16" font-weight="700">{_esc(title)}</text>'
    )


def draw_actor(canvas: SvgCanvas, center: Point, label: str) -> None:
    x, y = center.x, center.y
    # head
    canvas.add(f'<circle cx="{x}" cy="{y}" r="12" fill="none" stroke="#EAF0FF" stroke-width="2"/>')
    # body
    canvas.add(f'<line x1="{x}" y1="{y+12}" x2="{x}" y2="{y+50}" stroke="#EAF0FF" stroke-width="2"/>')
    # arms
    canvas.add(f'<line x1="{x-20}" y1="{y+28}" x2="{x+20}" y2="{y+28}" stroke="#EAF0FF" stroke-width="2"/>')
    # legs
    canvas.add(f'<line x1="{x}" y1="{y+50}" x2="{x-16}" y2="{y+75}" stroke="#EAF0FF" stroke-width="2"/>')
    canvas.add(f'<line x1="{x}" y1="{y+50}" x2="{x+16}" y2="{y+75}" stroke="#EAF0FF" stroke-width="2"/>')
    canvas.add(
        f'<text x="{x}" y="{y+98}" fill="#D5DEFA" font-size="13" text-anchor="middle" font-weight="600">{_esc(label)}</text>'
    )


def draw_usecase(canvas: SvgCanvas, x: float, y: float, w: float, h: float, label: str) -> None:
    canvas.add(
        f'<ellipse cx="{x+w/2}" cy="{y+h/2}" rx="{w/2}" ry="{h/2}" fill="#172447" stroke="#5A78C9" stroke-width="1.4"/>'
    )
    lines = label.split("\n")
    if len(lines) == 1:
        canvas.add(
            f'<text x="{x+w/2}" y="{y+h/2+5}" fill="#EFF4FF" font-size="12" text-anchor="middle">{_esc(lines[0])}</text>'
        )
    else:
        start = y + h / 2 - (len(lines) - 1) * 8
        for idx, line in enumerate(lines):
            canvas.add(
                f'<text x="{x+w/2}" y="{start + idx*16}" fill="#EFF4FF" font-size="12" text-anchor="middle">{_esc(line)}</text>'
            )


def draw_arrow(canvas: SvgCanvas, a: Point, b: Point, dashed: bool = False, label: str | None = None) -> None:
    dash = 'stroke-dasharray="6 6"' if dashed else ""
    canvas.add(
        f'<line x1="{a.x}" y1="{a.y}" x2="{b.x}" y2="{b.y}" stroke="#A8B3CF" stroke-width="1.6" marker-end="url(#arrow)" {dash}/>'
    )
    if label:
        mx, my = (a.x + b.x) / 2, (a.y + b.y) / 2 - 5
        canvas.add(
            f'<text x="{mx}" y="{my}" fill="#BFD0FF" font-size="11" text-anchor="middle">{_esc(label)}</text>'
        )


def draw_class_box(
    canvas: SvgCanvas,
    x: float,
    y: float,
    w: float,
    title: str,
    attrs: Iterable[str],
    fill: str = "#111A33",
) -> float:
    attrs_list = list(attrs)
    body_h = 24 + len(attrs_list) * 16
    h = 36 + body_h
    canvas.add(
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" stroke="#3E5A9F" stroke-width="1.2"/>'
    )
    canvas.add(f'<line x1="{x}" y1="{y+36}" x2="{x+w}" y2="{y+36}" stroke="#3E5A9F" stroke-width="1"/>')
    canvas.add(
        f'<text x="{x+w/2}" y="{y+24}" fill="#F4F7FF" font-size="13" text-anchor="middle" font-weight="700">{_esc(title)}</text>'
    )
    text_y = y + 56
    for attr in attrs_list:
        canvas.add(
            f'<text x="{x+10}" y="{text_y}" fill="#D3DDF8" font-size="11">{_esc(attr)}</text>'
        )
        text_y += 16
    return h


def generate_use_case_svg(out_file: Path) -> None:
    c = SvgCanvas(1800, 1100)
    draw_title(
        c,
        "Movie-Rec - Use Case Diagram (Enterprise Style)",
        "Actori, functionalitati principale si integrarea cu servicii externe",
    )

    draw_panel(c, 260, 110, 1280, 860, "Sistemul Movie-Rec")

    draw_actor(c, Point(120, 250), "Utilizator")
    draw_actor(c, Point(120, 470), "Administrator")
    draw_actor(c, Point(1660, 230), "TMDB API")
    draw_actor(c, Point(1660, 430), "Cloudinary")
    draw_actor(c, Point(1660, 630), "ML Service")
    draw_actor(c, Point(1660, 830), "Expo Push")

    use_cases = {
        "auth": (380, 180, 220, 72, "Autentificare\nregister/login"),
        "profile": (650, 180, 240, 72, "Gestionare profil\nprivacy/follow"),
        "search": (940, 180, 220, 72, "Cautare\nmovie/tv/person"),
        "details": (1210, 180, 250, 72, "Vizualizare detalii\nmovie/tv"),
        "lists": (380, 330, 250, 72, "Liste personale\nwatchlist/favorites"),
        "foryou": (690, 330, 250, 72, "For You\nrecomandari"),
        "gallery": (1000, 330, 250, 72, "Gallery\nimport + social"),
        "cinema": (1310, 330, 210, 72, "Cinema Live\nchat + poll"),
        "notif": (520, 500, 260, 72, "Notificari\nin-app + push"),
        "syncml": (860, 500, 260, 72, "Sync semnale\ncatre ML"),
        "admin_cinema": (1210, 500, 300, 72, "Admin Cinema Event\ncreate/update/close"),
        "admin_poll": (1210, 650, 300, 72, "Admin Poll\nopen/close"),
    }

    centers: dict[str, Point] = {}
    for key, (x, y, w, h, label) in use_cases.items():
        draw_usecase(c, x, y, w, h, label)
        centers[key] = Point(x + w / 2, y + h / 2)

    user_anchor = Point(168, 288)
    admin_anchor = Point(168, 508)
    tmdb_anchor = Point(1608, 268)
    cloud_anchor = Point(1608, 468)
    ml_anchor = Point(1608, 668)
    expo_anchor = Point(1608, 868)

    # user links
    for key in ["auth", "profile", "search", "details", "lists", "foryou", "gallery", "cinema", "notif"]:
        draw_arrow(c, user_anchor, centers[key])

    # admin links
    for key in ["admin_cinema", "admin_poll"]:
        draw_arrow(c, admin_anchor, centers[key])

    # externals
    draw_arrow(c, centers["search"], tmdb_anchor)
    draw_arrow(c, centers["details"], tmdb_anchor)
    draw_arrow(c, centers["gallery"], cloud_anchor)
    draw_arrow(c, centers["foryou"], ml_anchor)
    draw_arrow(c, centers["syncml"], ml_anchor)
    draw_arrow(c, centers["notif"], expo_anchor)

    # include/extend
    draw_arrow(c, centers["lists"], centers["syncml"], dashed=True, label="<<include>>")
    draw_arrow(c, centers["foryou"], centers["syncml"], dashed=True, label="<<include>>")
    draw_arrow(c, centers["admin_cinema"], centers["cinema"], dashed=True, label="<<include>>")
    draw_arrow(c, centers["admin_poll"], centers["cinema"], dashed=True, label="<<include>>")

    out_file.write_text(c.render(), encoding="utf-8")


def generate_class_svg(out_file: Path) -> None:
    c = SvgCanvas(2200, 1400)
    draw_title(
        c,
        "Movie-Rec - Class Diagram (Domain + Services)",
        "Structura orientata pe entitati, servicii aplicative si integrari externe",
    )

    draw_panel(c, 40, 110, 1380, 1220, "Domain Layer")
    draw_panel(c, 1470, 220, 300, 460, "Application Services", fill="#122038")
    draw_panel(c, 1810, 220, 350, 460, "External Integrations", fill="#122038")

    class_pos: dict[str, tuple[float, float, float, float]] = {}

    def put(name: str, x: float, y: float, w: float, title: str, attrs: list[str]) -> None:
        h = draw_class_box(c, x, y, w, title, attrs)
        class_pos[name] = (x, y, w, h)

    # domain entities
    put("User", 80, 170, 250, "User", ["+id:int", "+backend_user_id:int", "+nickname:str", "+role:str"])
    put("AuthSession", 360, 170, 250, "AuthSession", ["+id:int", "+user_id:int", "+session_token:str"])
    put("UserMovieState", 640, 170, 290, "UserMovieState", ["+user_id:int", "+tmdb_id:int", "+media_type:str", "+rating:int"])
    put("UserListPrivacy", 960, 170, 250, "UserListPrivacy", ["+user_id:int", "+watchlist:bool", "+favorites:bool"])

    put("MovieComment", 80, 430, 280, "MovieComment", ["+id:int", "+tmdb_id:int", "+user_id:int", "+parent_id:int"])
    put("GalleryItem", 390, 430, 280, "GalleryItem", ["+id:int", "+title:str", "+image_url:str", "+shot_id:str"])
    put("GalleryComment", 700, 430, 280, "GalleryComment", ["+id:int", "+gallery_id:int", "+user_id:int", "+parent_id:int"])
    put("CinemaEvent", 1010, 430, 280, "CinemaEvent", ["+id:int", "+title:str", "+video_url:str", "+start_at:datetime"])

    put("CinemaPoll", 80, 700, 250, "CinemaPoll", ["+id:int", "+question:str", "+status:str"])
    put("CinemaPollOption", 360, 700, 300, "CinemaPollOption", ["+id:str", "+poll_id:int", "+title:str", "+votes:int"])
    put("Notification", 690, 700, 280, "Notification", ["+id:int", "+user_id:int", "+type:str", "+action_path:str"])
    put("PushToken", 1000, 700, 250, "PushToken", ["+id:int", "+user_id:int", "+expo_push_token:str"])

    put("MLInteraction", 80, 970, 300, "MLInteraction", ["+user_id:int", "+tmdb_id:int", "+event_type:str", "+event_value:float"])
    put("RecommendationResult", 410, 970, 320, "RecommendationResult", ["+user_id:int", "+tmdb_id:int", "+score:float", "+reason:str"])
    put("FollowRelation", 760, 970, 260, "FollowRelation", ["+follower_id:int", "+followee_id:int"])
    put("MediaItem", 1050, 970, 240, "MediaItem", ["+tmdb_id:int", "+title:str", "+vote_average:float"])

    # services
    put("AuthService", 1510, 270, 220, "AuthService", ["+register()", "+login()", "+syncSession()"])
    put("MovieStateService", 1510, 430, 220, "MovieStateService", ["+toggleWatchlist()", "+setRating()"])
    put("CinemaService", 1510, 590, 220, "CinemaService", ["+createEvent()", "+votePoll()"])

    # external
    put("TMDBClient", 1845, 270, 280, "TMDBClient", ["+searchMulti()", "+getMovieById()"])
    put("CloudinaryClient", 1845, 430, 280, "CloudinaryClient", ["+signUpload()", "+deleteImage()"])
    put("MLApiClient", 1845, 590, 280, "MLApiClient", ["+ingest()", "+recommendations()"])

    def center(name: str) -> Point:
        x, y, w, h = class_pos[name]
        return Point(x + w / 2, y + h / 2)

    # helper for relation lines
    def rel(a: str, b: str, label: str | None = None, dashed: bool = False) -> None:
        draw_arrow(c, center(a), center(b), dashed=dashed, label=label)

    # domain relations
    rel("User", "AuthSession", "1..0/1")
    rel("User", "UserMovieState", "1..*")
    rel("User", "MovieComment", "1..*")
    rel("User", "GalleryComment", "1..*")
    rel("User", "Notification", "1..*")
    rel("User", "PushToken", "1..*")
    rel("User", "FollowRelation", "1..*")
    rel("CinemaPoll", "CinemaPollOption", "1..*")
    rel("UserMovieState", "MediaItem")
    rel("MLInteraction", "RecommendationResult")

    # service deps
    rel("AuthService", "User", dashed=True)
    rel("AuthService", "AuthSession", dashed=True)
    rel("MovieStateService", "UserMovieState", dashed=True)
    rel("MovieStateService", "MLInteraction", dashed=True)
    rel("CinemaService", "CinemaEvent", dashed=True)
    rel("CinemaService", "CinemaPoll", dashed=True)

    # integrations
    rel("MovieStateService", "TMDBClient", dashed=True)
    rel("MovieStateService", "MLApiClient", dashed=True)
    rel("CinemaService", "CloudinaryClient", dashed=True)

    out_file.write_text(c.render(), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate enterprise-style SVG diagrams for Movie-Rec.")
    parser.add_argument(
        "--open",
        action="store_true",
        help="Open generated SVG files in default browser.",
    )
    args = parser.parse_args()

    out_dir = Path(__file__).resolve().parent
    out_dir.mkdir(parents=True, exist_ok=True)

    use_case_out = out_dir / "use_case_enterprise.svg"
    class_out = out_dir / "class_diagram_enterprise.svg"

    generate_use_case_svg(use_case_out)
    generate_class_svg(class_out)

    print(f"[ok] generated {use_case_out}")
    print(f"[ok] generated {class_out}")
    if args.open:
        webbrowser.open(use_case_out.resolve().as_uri())
        webbrowser.open(class_out.resolve().as_uri())


if __name__ == "__main__":
    main()
