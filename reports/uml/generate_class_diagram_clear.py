from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


def esc(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


@dataclass
class Box:
    key: str
    title: str
    x: float
    y: float
    w: float
    attrs: list[str]
    ops: list[str]

    def h(self) -> float:
        return 42 + max(1, len(self.attrs)) * 16 + 14 + max(1, len(self.ops)) * 16 + 10

    def left(self, dy: float = 0) -> tuple[float, float]:
        return (self.x, self.y + self.h() / 2 + dy)

    def right(self, dy: float = 0) -> tuple[float, float]:
        return (self.x + self.w, self.y + self.h() / 2 + dy)

    def top(self, dx: float = 0) -> tuple[float, float]:
        return (self.x + self.w / 2 + dx, self.y)

    def bottom(self, dx: float = 0) -> tuple[float, float]:
        return (self.x + self.w / 2 + dx, self.y + self.h())


class Svg:
    def __init__(self, w: int, h: int):
        self.w = w
        self.h = h
        self.parts: list[str] = []

    def add(self, s: str) -> None:
        self.parts.append(s)

    def render(self) -> str:
        defs = """
<defs>
  <marker id="openArrow" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">
    <path d="M0,0 L10,5 L0,10" fill="none" stroke="#B8C7EC" stroke-width="1.3"/>
  </marker>
  <marker id="triangle" markerWidth="14" markerHeight="14" refX="13" refY="7" orient="auto">
    <path d="M0,7 L13,0 L13,14 Z" fill="#0C1224" stroke="#C7D4F6" stroke-width="1.2"/>
  </marker>
  <marker id="diamond" markerWidth="14" markerHeight="14" refX="2" refY="7" orient="auto">
    <path d="M2,7 L7,2 L12,7 L7,12 Z" fill="#C7D4F6" stroke="#C7D4F6" stroke-width="1"/>
  </marker>
  <filter id="shadow" x="-20%" y="-20%" width="160%" height="160%">
    <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000000" flood-opacity="0.3"/>
  </filter>
</defs>
"""
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" '
            f'viewBox="0 0 {self.w} {self.h}" font-family="Segoe UI, Arial, sans-serif">'
            f"{defs}{''.join(self.parts)}</svg>"
        )


def draw_layer(svg: Svg, x: float, y: float, w: float, h: float, title: str) -> None:
    svg.add(
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="#121C39" stroke="#35518E" stroke-width="1.4" filter="url(#shadow)"/>'
    )
    svg.add(f'<line x1="{x}" y1="{y+42}" x2="{x+w}" y2="{y+42}" stroke="#35518E" stroke-width="1"/>')
    svg.add(f'<text x="{x+14}" y="{y+28}" fill="#ECF2FF" font-size="15" font-weight="700">{esc(title)}</text>')


def draw_class(svg: Svg, b: Box) -> None:
    h = b.h()
    svg.add(
        f'<rect x="{b.x}" y="{b.y}" width="{b.w}" height="{h}" rx="9" fill="#0F162D" stroke="#4B66A6" stroke-width="1.1"/>'
    )
    svg.add(f'<line x1="{b.x}" y1="{b.y+42}" x2="{b.x+b.w}" y2="{b.y+42}" stroke="#4B66A6" stroke-width="1"/>')

    attrs_end = b.y + 42 + max(1, len(b.attrs)) * 16 + 8
    svg.add(f'<line x1="{b.x}" y1="{attrs_end}" x2="{b.x+b.w}" y2="{attrs_end}" stroke="#4B66A6" stroke-width="1"/>')

    svg.add(
        f'<text x="{b.x+b.w/2}" y="{b.y+27}" fill="#F4F8FF" font-size="13" font-weight="700" text-anchor="middle">{esc(b.title)}</text>'
    )

    y = b.y + 58
    for a in b.attrs:
        svg.add(f'<text x="{b.x+10}" y="{y}" fill="#D7E1FA" font-size="11">{esc(a)}</text>')
        y += 16

    y = attrs_end + 15
    for o in b.ops:
        svg.add(f'<text x="{b.x+10}" y="{y}" fill="#CBECD8" font-size="11">{esc(o)}</text>')
        y += 16


def line(svg: Svg, p1: tuple[float, float], p2: tuple[float, float], kind: str, label: str = "") -> None:
    x1, y1 = p1
    x2, y2 = p2
    dash = ' stroke-dasharray="6 4"' if kind == "dep" else ""
    marker_start = ' marker-start="url(#diamond)"' if kind == "comp" else ""
    marker_end = ' marker-end="url(#triangle)"' if kind == "gen" else (' marker-end="url(#openArrow)"' if kind == "dep" else "")
    svg.add(
        f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="#B8C7EC" stroke-width="1.4"{dash}{marker_start}{marker_end}/>'
    )
    if label:
        mx = (x1 + x2) / 2
        my = (y1 + y2) / 2 - 6
        svg.add(f'<text x="{mx}" y="{my}" fill="#C8D7FF" font-size="10.5" text-anchor="middle">{esc(label)}</text>')


def poly(svg: Svg, pts: list[tuple[float, float]], kind: str, label: str = "") -> None:
    dash = ' stroke-dasharray="6 4"' if kind == "dep" else ""
    marker_start = ' marker-start="url(#diamond)"' if kind == "comp" else ""
    marker_end = ' marker-end="url(#triangle)"' if kind == "gen" else (' marker-end="url(#openArrow)"' if kind == "dep" else "")
    d = f"M {pts[0][0]} {pts[0][1]} " + " ".join(f"L {x} {y}" for x, y in pts[1:])
    svg.add(f'<path d="{d}" fill="none" stroke="#B8C7EC" stroke-width="1.4"{dash}{marker_start}{marker_end}/>')
    if label:
        mx = (pts[0][0] + pts[-1][0]) / 2
        my = (pts[0][1] + pts[-1][1]) / 2 - 6
        svg.add(f'<text x="{mx}" y="{my}" fill="#C8D7FF" font-size="10.5" text-anchor="middle">{esc(label)}</text>')


def build(out_svg: Path) -> None:
    svg = Svg(2180, 1360)
    svg.add('<rect x="0" y="0" width="2180" height="1360" fill="#0A1020"/>')
    svg.add('<text x="1090" y="40" fill="#F3F8FF" font-size="26" text-anchor="middle" font-weight="700">Movie-Rec - Class Diagram (Clear)</text>')
    svg.add('<text x="1090" y="64" fill="#AFC0EA" font-size="13" text-anchor="middle">Simplified, readable version for thesis</text>')

    draw_layer(svg, 30, 90, 1080, 1240, "Domain Layer")
    draw_layer(svg, 1130, 90, 500, 1240, "Application Services")
    draw_layer(svg, 1650, 90, 500, 1240, "External Systems")

    boxes: dict[str, Box] = {}

    def add(b: Box) -> None:
        boxes[b.key] = b
        draw_class(svg, b)

    # Domain
    add(Box("User", "User", 70, 150, 300, ["- id:int", "- nickname:string", "- name:string", "- role:string"], ["+ updateProfile()", "+ setTastePrivacy()"]))
    add(Box("Admin", "Admin", 400, 150, 300, ["- adminKey:string"], ["+ createCinemaEvent()", "+ importGalleryContent()"]))
    add(Box("AuthSession", "AuthSession", 70, 350, 300, ["- id:int", "- userId:int", "- token:string"], ["+ create()", "+ revoke()"]))
    add(Box("UserMovieState", "UserMovieState", 400, 350, 300, ["- userId:int", "- tmdbId:int", "- mediaType:string", "- rating:int"], ["+ toggleWatchlist()", "+ toggleFavorite()", "+ setRating()"]))
    add(Box("GalleryItem", "GalleryItem", 730, 350, 340, ["- id:int", "- userId:int", "- title:string", "- imageUrl:string"], ["+ toggleLike()", "+ addComment()"]))
    add(Box("CinemaEvent", "CinemaEvent", 70, 610, 300, ["- id:int", "- title:string", "- videoUrl:string", "- startAt:datetime"], ["+ create()", "+ getCurrent()"]))
    add(Box("CinemaPoll", "CinemaPoll", 400, 610, 300, ["- id:int", "- eventId:int", "- question:string", "- status:string"], ["+ vote()", "+ close()"]))
    add(Box("Notification", "Notification", 70, 870, 300, ["- id:int", "- userId:int", "- type:string", "- isRead:bool"], ["+ add()", "+ markRead()"]))
    add(Box("PushToken", "PushToken", 400, 870, 300, ["- id:int", "- userId:int", "- expoPushToken:string", "- platform:string"], ["+ register()", "+ disable()"]))

    # Services
    add(Box("AuthService", "AuthService", 1160, 170, 440, [], ["+ register()", "+ login()", "+ syncSession()"]))
    add(Box("ContentService", "ContentService", 1160, 350, 440, [], ["+ searchMulti()", "+ getMovieDetails()", "+ getCategoryFeed()"]))
    add(Box("RecommendationService", "RecommendationService", 1160, 530, 440, [], ["+ syncInteractionsToML()", "+ getForYou()"]))
    add(Box("GalleryService", "GalleryService", 1160, 710, 440, [], ["+ addGalleryItem()", "+ deleteGalleryItem()"]))
    add(Box("CinemaService", "CinemaService", 1160, 890, 440, [], ["+ createCinemaEvent()", "+ createCinemaPoll()"]))
    add(Box("NotificationService", "NotificationService", 1160, 1070, 440, [], ["+ registerPushToken()", "+ sendPush()"]))

    # External
    add(Box("TMDBApiClient", "TMDBApiClient", 1690, 260, 420, ["- baseUrl:string", "- apiKey:string"], ["+ searchMulti()", "+ getMovieById()"]))
    add(Box("MLApiClient", "MLApiClient", 1690, 520, 420, ["- baseUrl:string"], ["+ ingest()", "+ recommendations()"]))
    add(Box("CloudinaryClient", "CloudinaryClient", 1690, 780, 420, ["- cloudName:string"], ["+ signUpload()", "+ deleteMedia()"]))
    add(Box("ExpoPushClient", "ExpoPushClient", 1690, 1040, 420, ["- projectId:string"], ["+ sendPushBatch()"]))

    b = boxes

    # Core domain relations
    line(svg, b["Admin"].left(), b["User"].right(), "gen", "is-a")
    line(svg, b["User"].bottom(-70), b["AuthSession"].top(-70), "comp", "1 .. 0..*")
    line(svg, b["User"].bottom(70), b["UserMovieState"].top(-40), "comp", "1 .. 0..*")
    line(svg, b["User"].right(20), b["GalleryItem"].left(-10), "assoc", "admin/user interactions")
    line(svg, b["CinemaEvent"].right(), b["CinemaPoll"].left(), "comp", "1 .. 0..1")
    line(svg, b["User"].bottom(-110), b["Notification"].top(-80), "comp", "1 .. 0..*")
    line(svg, b["User"].bottom(110), b["PushToken"].top(-40), "comp", "1 .. 0..*")
    line(svg, b["Admin"].bottom(), b["CinemaEvent"].top(), "assoc", "creates")
    line(svg, b["Admin"].bottom(80), b["CinemaPoll"].top(30), "assoc", "manages")
    line(svg, b["Admin"].right(40), b["GalleryItem"].top(), "assoc", "imports")

    # Service -> Domain / External (dashed dependency)
    line(svg, b["AuthService"].left(-20), b["User"].right(-10), "dep")
    line(svg, b["AuthService"].left(20), b["AuthSession"].right(-10), "dep")

    line(svg, b["ContentService"].left(-10), b["UserMovieState"].right(), "dep")
    line(svg, b["ContentService"].right(), b["TMDBApiClient"].left(), "dep")

    line(svg, b["RecommendationService"].left(-10), b["UserMovieState"].right(10), "dep")
    line(svg, b["RecommendationService"].right(-20), b["MLApiClient"].left(), "dep")
    poly(
        svg,
        [
            b["RecommendationService"].right(18),
            (1640, b["RecommendationService"].right(18)[1]),
            (1640, b["TMDBApiClient"].left(30)[1]),
            b["TMDBApiClient"].left(30),
        ],
        "dep",
    )

    line(svg, b["GalleryService"].left(), b["GalleryItem"].right(), "dep")
    line(svg, b["GalleryService"].right(), b["CloudinaryClient"].left(), "dep")

    line(svg, b["CinemaService"].left(-12), b["CinemaEvent"].right(8), "dep")
    line(svg, b["CinemaService"].left(12), b["CinemaPoll"].right(8), "dep")

    line(svg, b["NotificationService"].left(-10), b["Notification"].right(), "dep")
    line(svg, b["NotificationService"].left(10), b["PushToken"].right(), "dep")
    line(svg, b["NotificationService"].right(), b["ExpoPushClient"].left(), "dep")

    out_svg.write_text(svg.render(), encoding="utf-8")


def main() -> None:
    out = Path(__file__).resolve().parent / "class_diagram_ea_style.svg"
    build(out)
    print(f"[ok] generated {out}")


if __name__ == "__main__":
    main()

