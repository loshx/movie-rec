from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


def esc(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


@dataclass
class Point:
    x: float
    y: float


@dataclass
class ClassBox:
    key: str
    title: str
    x: float
    y: float
    w: float
    attrs: list[str]
    ops: list[str]

    def h(self) -> float:
        # Header + attrs + divider + ops + paddings
        attrs_h = max(1, len(self.attrs)) * 17
        ops_h = max(1, len(self.ops)) * 17
        return 42 + attrs_h + 14 + ops_h + 12

    def anchor(self, where: str, dx: float = 0.0, dy: float = 0.0) -> Point:
        h = self.h()
        if where == "left":
            return Point(self.x + dx, self.y + h / 2 + dy)
        if where == "right":
            return Point(self.x + self.w + dx, self.y + h / 2 + dy)
        if where == "top":
            return Point(self.x + self.w / 2 + dx, self.y + dy)
        if where == "bottom":
            return Point(self.x + self.w / 2 + dx, self.y + h + dy)
        raise ValueError(f"Unknown anchor '{where}'")


class Svg:
    def __init__(self, width: int, height: int) -> None:
        self.width = width
        self.height = height
        self.parts: list[str] = []

    def add(self, s: str) -> None:
        self.parts.append(s)

    def defs(self) -> str:
        return """
<defs>
  <filter id="shadow" x="-20%" y="-20%" width="160%" height="160%">
    <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.28"/>
  </filter>
  <marker id="depArrow" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">
    <path d="M0,0 L10,5 L0,10" fill="none" stroke="#9AAAD1" stroke-width="1.4"/>
  </marker>
  <marker id="genArrow" markerWidth="14" markerHeight="14" refX="13" refY="7" orient="auto">
    <path d="M0,7 L13,0 L13,14 Z" fill="#0D1326" stroke="#AFC0EA" stroke-width="1.3"/>
  </marker>
  <marker id="compDiamond" markerWidth="14" markerHeight="14" refX="2" refY="7" orient="auto">
    <path d="M2,7 L7,2 L12,7 L7,12 Z" fill="#AFC0EA" stroke="#AFC0EA" stroke-width="1.1"/>
  </marker>
</defs>
"""

    def render(self) -> str:
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.width}" height="{self.height}" '
            f'viewBox="0 0 {self.width} {self.height}" font-family="Segoe UI, Arial, sans-serif">'
            f'{self.defs()}'
            + "".join(self.parts)
            + "</svg>"
        )


def draw_layer(svg: Svg, x: float, y: float, w: float, h: float, title: str, fill: str, stroke: str) -> None:
    svg.add(
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="14" fill="{fill}" stroke="{stroke}" stroke-width="1.4" filter="url(#shadow)"/>'
    )
    svg.add(f'<line x1="{x}" y1="{y+44}" x2="{x+w}" y2="{y+44}" stroke="{stroke}" stroke-width="1.0"/>')
    svg.add(
        f'<text x="{x+16}" y="{y+29}" fill="#EAF0FF" font-size="15" font-weight="700">{esc(title)}</text>'
    )


def draw_class(svg: Svg, cls: ClassBox) -> None:
    h = cls.h()
    svg.add(
        f'<rect x="{cls.x}" y="{cls.y}" width="{cls.w}" height="{h}" rx="10" fill="#121A31" stroke="#40598F" stroke-width="1.1"/>'
    )
    svg.add(f'<line x1="{cls.x}" y1="{cls.y+42}" x2="{cls.x+cls.w}" y2="{cls.y+42}" stroke="#40598F" stroke-width="1.0"/>')

    attrs_h = max(1, len(cls.attrs)) * 17
    attrs_end_y = cls.y + 42 + attrs_h + 8
    svg.add(f'<line x1="{cls.x}" y1="{attrs_end_y}" x2="{cls.x+cls.w}" y2="{attrs_end_y}" stroke="#40598F" stroke-width="1.0"/>')

    svg.add(
        f'<text x="{cls.x + cls.w/2}" y="{cls.y+27}" fill="#F5F8FF" font-size="13" text-anchor="middle" font-weight="700">{esc(cls.title)}</text>'
    )

    ay = cls.y + 58
    for a in cls.attrs:
        svg.add(f'<text x="{cls.x+10}" y="{ay}" fill="#D7E0FA" font-size="11">{esc(a)}</text>')
        ay += 17

    oy = attrs_end_y + 16
    for o in cls.ops:
        svg.add(f'<text x="{cls.x+10}" y="{oy}" fill="#CDE7D9" font-size="11">{esc(o)}</text>')
        oy += 17


def path_d(points: list[Point]) -> str:
    if len(points) < 2:
        return ""
    head = f"M {points[0].x:.1f} {points[0].y:.1f}"
    segs = "".join(f" L {p.x:.1f} {p.y:.1f}" for p in points[1:])
    return head + segs


def draw_relation(
    svg: Svg,
    points: list[Point],
    kind: str = "association",
    label: str | None = None,
    tail_mult: str | None = None,
    head_mult: str | None = None,
) -> None:
    marker_start = ""
    marker_end = ""
    dash = ""
    stroke = "#9AAAD1"
    width = "1.4"

    if kind == "dependency":
        dash = ' stroke-dasharray="6 5"'
        marker_end = ' marker-end="url(#depArrow)"'
    elif kind == "generalization":
        marker_end = ' marker-end="url(#genArrow)"'
    elif kind == "composition":
        marker_start = ' marker-start="url(#compDiamond)"'
    elif kind == "association":
        pass

    d = path_d(points)
    svg.add(
        f'<path d="{d}" fill="none" stroke="{stroke}" stroke-width="{width}"{dash}{marker_start}{marker_end}/>'
    )

    if label:
        mx = (points[0].x + points[-1].x) / 2
        my = (points[0].y + points[-1].y) / 2 - 8
        svg.add(f'<text x="{mx:.1f}" y="{my:.1f}" fill="#C6D5FF" font-size="10.5" text-anchor="middle">{esc(label)}</text>')

    if tail_mult:
        p = points[0]
        svg.add(f'<text x="{p.x-10:.1f}" y="{p.y-6:.1f}" fill="#C6D5FF" font-size="10">{esc(tail_mult)}</text>')
    if head_mult:
        p = points[-1]
        svg.add(f'<text x="{p.x+4:.1f}" y="{p.y-6:.1f}" fill="#C6D5FF" font-size="10">{esc(head_mult)}</text>')


def routed(a: Point, b: Point, lane_x: float | None = None, lane_y: float | None = None) -> list[Point]:
    # Orthogonal router with one lane.
    if abs(a.y - b.y) <= 8 or abs(a.x - b.x) <= 8:
        return [a, b]
    if lane_x is not None:
        return [a, Point(lane_x, a.y), Point(lane_x, b.y), b]
    if lane_y is not None:
        return [a, Point(a.x, lane_y), Point(b.x, lane_y), b]
    mid_x = (a.x + b.x) / 2
    return [a, Point(mid_x, a.y), Point(mid_x, b.y), b]


def build_diagram(out_file: Path) -> None:
    svg = Svg(2600, 1560)

    svg.add('<rect x="0" y="0" width="2600" height="1560" fill="#0B1020"/>')
    svg.add(
        '<text x="1300" y="44" fill="#F1F6FF" font-size="27" text-anchor="middle" font-weight="700">Movie-Rec - Class Diagram (EA Style)</text>'
    )
    svg.add(
        '<text x="1300" y="70" fill="#AFC0EA" font-size="13" text-anchor="middle">Domain + Application Services + External Integrations</text>'
    )

    draw_layer(svg, 40, 92, 1480, 1428, "Domain Layer", "#101932", "#2E457A")
    draw_layer(svg, 1560, 180, 460, 1260, "Application Services", "#11203F", "#35528F")
    draw_layer(svg, 2060, 180, 500, 1260, "External Systems", "#11203F", "#35528F")

    classes: dict[str, ClassBox] = {}

    def add(cls: ClassBox) -> None:
        classes[cls.key] = cls
        draw_class(svg, cls)

    # Domain classes
    add(
        ClassBox(
            "User",
            "User",
            80,
            160,
            420,
            ["- id:int", "- nickname:string", "- name:string", "- role:string", "- avatarUrl:string", "- bio:string"],
            ["+ updateProfile()", "+ setTastePrivacy()", "+ deleteAccount()"],
        )
    )
    add(
        ClassBox(
            "Admin",
            "Admin",
            540,
            160,
            420,
            ["- adminKey:string", "- permissions:string"],
            ["+ createCinemaEvent()", "+ createCinemaPoll()", "+ importGalleryContent()"],
        )
    )
    add(
        ClassBox(
            "AuthSession",
            "AuthSession",
            1000,
            160,
            420,
            ["- id:int", "- userId:int", "- sessionToken:string", "- source:string", "- createdAt:datetime"],
            ["+ create()", "+ revoke()"],
        )
    )

    add(
        ClassBox(
            "UserMovieState",
            "UserMovieState",
            80,
            400,
            420,
            [
                "- userId:int",
                "- tmdbId:int",
                "- mediaType:string",
                "- watchlist:bool",
                "- favorite:bool",
                "- watched:bool",
                "- rating:int",
            ],
            ["+ toggleWatchlist()", "+ toggleFavorite()", "+ setRating()"],
        )
    )
    add(
        ClassBox(
            "UserListPrivacy",
            "UserListPrivacy",
            540,
            400,
            420,
            ["- userId:int", "- watchlist:bool", "- favorites:bool", "- watched:bool", "- rated:bool"],
            ["+ getPrivacy()", "+ setPrivacy()"],
        )
    )
    add(
        ClassBox(
            "FollowRelation",
            "FollowRelation",
            1000,
            400,
            420,
            ["- followerId:int", "- followingId:int", "- createdAt:datetime"],
            ["+ follow()", "+ unfollow()"],
        )
    )

    add(
        ClassBox(
            "MovieComment",
            "MovieComment",
            80,
            640,
            420,
            ["- id:int", "- tmdbId:int", "- userId:int", "- parentId:int", "- text:string", "- createdAt:datetime"],
            ["+ addReply()", "+ listThread()"],
        )
    )
    add(
        ClassBox(
            "GalleryItem",
            "GalleryItem",
            540,
            640,
            420,
            ["- id:int", "- userId:int", "- title:string", "- imageUrl:string", "- likesCount:int", "- savesCount:int"],
            ["+ toggleLike()", "+ toggleSave()", "+ addComment()"],
        )
    )
    add(
        ClassBox(
            "GalleryComment",
            "GalleryComment",
            1000,
            640,
            420,
            ["- id:int", "- galleryId:int", "- userId:int", "- parentId:int", "- text:string", "- createdAt:datetime"],
            ["+ addReply()", "+ listThread()"],
        )
    )

    add(
        ClassBox(
            "CinemaEvent",
            "CinemaEvent",
            80,
            900,
            420,
            ["- id:int", "- title:string", "- videoUrl:string", "- startAt:datetime", "- status:string", "- createdBy:int"],
            ["+ create()", "+ getCurrent()", "+ getLatest()"],
        )
    )
    add(
        ClassBox(
            "CinemaPoll",
            "CinemaPoll",
            540,
            900,
            420,
            ["- id:int", "- eventId:int", "- question:string", "- status:string"],
            ["+ vote()", "+ close()"],
        )
    )
    add(
        ClassBox(
            "CinemaPollOption",
            "CinemaPollOption",
            1000,
            900,
            420,
            ["- id:string", "- pollId:int", "- title:string", "- votes:int"],
            ["+ incrementVote()"],
        )
    )

    add(
        ClassBox(
            "LiveMessage",
            "LiveMessage",
            80,
            1160,
            420,
            ["- id:int", "- eventId:int", "- userId:int", "- text:string", "- createdAt:datetime"],
            ["+ send()"],
        )
    )
    add(
        ClassBox(
            "Notification",
            "Notification",
            540,
            1160,
            420,
            ["- id:int", "- userId:int", "- type:string", "- title:string", "- isRead:bool", "- createdAt:datetime"],
            ["+ add()", "+ markRead()"],
        )
    )
    add(
        ClassBox(
            "PushToken",
            "PushToken",
            1000,
            1160,
            420,
            ["- id:int", "- userId:int", "- expoPushToken:string", "- platform:string", "- active:bool"],
            ["+ register()", "+ disable()"],
        )
    )

    # Application services
    add(
        ClassBox(
            "AuthService",
            "AuthService",
            1600,
            250,
            380,
            [],
            ["+ register()", "+ login()", "+ syncSession()"],
        )
    )
    add(
        ClassBox(
            "ContentService",
            "ContentService",
            1600,
            430,
            380,
            [],
            ["+ searchMulti()", "+ getMovieDetails()", "+ getCategoryFeed()"],
        )
    )
    add(
        ClassBox(
            "RecommendationService",
            "RecommendationService",
            1600,
            610,
            380,
            [],
            ["+ syncInteractionsToML()", "+ getForYou()", "+ getDailyMoodPicks()"],
        )
    )
    add(
        ClassBox(
            "GalleryService",
            "GalleryService",
            1600,
            790,
            380,
            [],
            ["+ addGalleryItem()", "+ deleteGalleryItem()", "+ addGalleryComment()"],
        )
    )
    add(
        ClassBox(
            "CinemaService",
            "CinemaService",
            1600,
            970,
            380,
            [],
            ["+ createCinemaEvent()", "+ createCinemaPoll()", "+ sendLiveMessage()"],
        )
    )
    add(
        ClassBox(
            "NotificationService",
            "NotificationService",
            1600,
            1150,
            380,
            [],
            ["+ registerPushToken()", "+ createInAppNotification()", "+ sendPush()"],
        )
    )

    # External clients
    add(
        ClassBox(
            "TMDBApiClient",
            "TMDBApiClient",
            2100,
            300,
            420,
            ["- baseUrl:string", "- apiKey:string"],
            ["+ searchMulti()", "+ getMovieById()", "+ getPersonById()"],
        )
    )
    add(
        ClassBox(
            "MLApiClient",
            "MLApiClient",
            2100,
            540,
            420,
            ["- baseUrl:string", "- healthy:bool"],
            ["+ ingest()", "+ recommendations()", "+ explain()"],
        )
    )
    add(
        ClassBox(
            "CloudinaryClient",
            "CloudinaryClient",
            2100,
            780,
            420,
            ["- cloudName:string"],
            ["+ signUpload()", "+ deleteMedia()"],
        )
    )
    add(
        ClassBox(
            "ExpoPushClient",
            "ExpoPushClient",
            2100,
            1020,
            420,
            ["- projectId:string"],
            ["+ sendPushBatch()"],
        )
    )

    c = classes

    # Domain relations
    draw_relation(
        svg,
        [c["Admin"].anchor("left"), c["User"].anchor("right")],
        kind="generalization",
        label="is-a",
    )
    draw_relation(
        svg,
        routed(c["User"].anchor("right", dy=-18), c["AuthSession"].anchor("left", dy=-18), lane_y=222),
        kind="composition",
        tail_mult="1",
        head_mult="0..*",
    )
    draw_relation(
        svg,
        [c["User"].anchor("bottom", dx=-70), c["UserMovieState"].anchor("top", dx=-70)],
        kind="composition",
        tail_mult="1",
        head_mult="0..*",
    )
    draw_relation(
        svg,
        routed(c["User"].anchor("right", dy=14), c["UserListPrivacy"].anchor("left", dy=-10), lane_x=518),
        kind="composition",
        tail_mult="1",
        head_mult="1",
    )
    draw_relation(
        svg,
        [c["User"].anchor("bottom", dx=0), c["MovieComment"].anchor("top", dx=0)],
        kind="association",
        tail_mult="1",
        head_mult="0..*",
    )
    draw_relation(
        svg,
        routed(c["User"].anchor("right", dy=38), c["FollowRelation"].anchor("left", dy=-12), lane_x=740),
        kind="association",
        label="follows",
    )
    draw_relation(
        svg,
        routed(c["User"].anchor("bottom", dx=52), c["Notification"].anchor("top", dx=-40), lane_x=520),
        kind="composition",
        tail_mult="1",
        head_mult="0..*",
    )
    draw_relation(
        svg,
        routed(c["User"].anchor("bottom", dx=86), c["PushToken"].anchor("top", dx=-20), lane_x=720),
        kind="composition",
        tail_mult="1",
        head_mult="0..*",
    )
    draw_relation(
        svg,
        [c["User"].anchor("bottom", dx=-100), c["LiveMessage"].anchor("top", dx=-100)],
        kind="association",
        tail_mult="1",
        head_mult="0..*",
    )

    draw_relation(
        svg,
        [c["Admin"].anchor("bottom", dx=0), c["GalleryItem"].anchor("top", dx=0)],
        kind="association",
        label="creates",
    )
    draw_relation(
        svg,
        routed(c["Admin"].anchor("bottom", dx=80), c["CinemaEvent"].anchor("top", dx=80), lane_x=960),
        kind="association",
        label="creates",
    )
    draw_relation(
        svg,
        [c["Admin"].anchor("bottom", dx=30), c["CinemaPoll"].anchor("top", dx=30)],
        kind="association",
        label="manages",
    )

    draw_relation(
        svg,
        [c["GalleryItem"].anchor("right"), c["GalleryComment"].anchor("left")],
        kind="composition",
        tail_mult="1",
        head_mult="0..*",
    )
    draw_relation(
        svg,
        [c["CinemaEvent"].anchor("right"), c["CinemaPoll"].anchor("left")],
        kind="composition",
        tail_mult="1",
        head_mult="0..1",
    )
    draw_relation(
        svg,
        [c["CinemaPoll"].anchor("right"), c["CinemaPollOption"].anchor("left")],
        kind="composition",
        tail_mult="1",
        head_mult="2..*",
    )
    draw_relation(
        svg,
        [c["CinemaEvent"].anchor("bottom", dx=-70), c["LiveMessage"].anchor("top", dx=70)],
        kind="association",
        tail_mult="1",
        head_mult="0..*",
    )

    # Service -> domain/external dependencies
    draw_relation(
        svg,
        routed(c["AuthService"].anchor("left", dy=-12), c["User"].anchor("right", dy=-20), lane_x=1528),
        kind="dependency",
    )
    draw_relation(
        svg,
        routed(c["AuthService"].anchor("left", dy=12), c["AuthSession"].anchor("right", dy=-6), lane_x=1528),
        kind="dependency",
    )

    draw_relation(
        svg,
        routed(c["ContentService"].anchor("left", dy=-8), c["UserMovieState"].anchor("right", dy=0), lane_x=1528),
        kind="dependency",
    )
    draw_relation(
        svg,
        routed(c["ContentService"].anchor("left", dy=12), c["MovieComment"].anchor("right", dy=0), lane_x=1528),
        kind="dependency",
    )
    draw_relation(
        svg,
        routed(c["ContentService"].anchor("right"), c["TMDBApiClient"].anchor("left"), lane_x=2040),
        kind="dependency",
    )

    draw_relation(
        svg,
        routed(c["RecommendationService"].anchor("left", dy=-10), c["UserMovieState"].anchor("right", dy=20), lane_x=1528),
        kind="dependency",
    )
    draw_relation(
        svg,
        routed(c["RecommendationService"].anchor("left", dy=14), c["FollowRelation"].anchor("right", dy=0), lane_x=1528),
        kind="dependency",
    )
    draw_relation(
        svg,
        routed(c["RecommendationService"].anchor("right", dy=-12), c["MLApiClient"].anchor("left", dy=-10), lane_x=2040),
        kind="dependency",
    )
    draw_relation(
        svg,
        routed(c["RecommendationService"].anchor("right", dy=14), c["TMDBApiClient"].anchor("left", dy=24), lane_x=2040),
        kind="dependency",
    )

    draw_relation(
        svg,
        routed(c["GalleryService"].anchor("left", dy=-12), c["GalleryItem"].anchor("right", dy=0), lane_x=1528),
        kind="dependency",
    )
    draw_relation(
        svg,
        routed(c["GalleryService"].anchor("left", dy=14), c["GalleryComment"].anchor("right", dy=0), lane_x=1528),
        kind="dependency",
    )
    draw_relation(
        svg,
        routed(c["GalleryService"].anchor("right"), c["CloudinaryClient"].anchor("left"), lane_x=2040),
        kind="dependency",
    )

    draw_relation(
        svg,
        routed(c["CinemaService"].anchor("left", dy=-18), c["CinemaEvent"].anchor("right", dy=-6), lane_x=1528),
        kind="dependency",
    )
    draw_relation(
        svg,
        routed(c["CinemaService"].anchor("left", dy=0), c["CinemaPoll"].anchor("right", dy=0), lane_x=1528),
        kind="dependency",
    )
    draw_relation(
        svg,
        routed(c["CinemaService"].anchor("left", dy=18), c["LiveMessage"].anchor("right", dy=0), lane_x=1528),
        kind="dependency",
    )

    draw_relation(
        svg,
        routed(c["NotificationService"].anchor("left", dy=-12), c["Notification"].anchor("right", dy=0), lane_x=1528),
        kind="dependency",
    )
    draw_relation(
        svg,
        routed(c["NotificationService"].anchor("left", dy=12), c["PushToken"].anchor("right", dy=0), lane_x=1528),
        kind="dependency",
    )
    draw_relation(
        svg,
        routed(c["NotificationService"].anchor("right"), c["ExpoPushClient"].anchor("left"), lane_x=2040),
        kind="dependency",
    )

    out_file.write_text(svg.render(), encoding="utf-8")


def main() -> None:
    out = Path(__file__).resolve().parent / "class_diagram_ea_style.svg"
    build_diagram(out)
    print(f"[ok] generated {out}")


if __name__ == "__main__":
    main()

