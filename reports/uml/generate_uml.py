from __future__ import annotations

import argparse
from pathlib import Path
from urllib import error, request


USE_CASE_PUML = r"""@startuml
title Movie-Rec - Use Case Diagram
left to right direction
skinparam shadowing false
skinparam actorStyle awesome
skinparam packageStyle rectangle
skinparam usecase {
  BackgroundColor #F8FAFC
  BorderColor #0F172A
  ArrowColor #334155
}

actor "Utilizator" as User
actor "Administrator" as Admin
actor "TMDB API" as TMDB <<External>>
actor "Cloudinary" as Cloudinary <<External>>
actor "Expo Push Service" as ExpoPush <<External>>
actor "ML Service (FastAPI)" as ML <<External>>

Admin --|> User

rectangle "Sistemul Movie-Rec" as System {
  usecase "Autentificare\n(înregistrare / login)" as UC_Auth
  usecase "Gestionare profil\n(editare, privacy, follow)" as UC_Profile
  usecase "Căutare filme / seriale /\npersoane" as UC_Search
  usecase "Vizualizare detalii film / serial" as UC_Details
  usecase "Gestionare liste\n(watchlist, favorite, watched, rating)" as UC_Lists
  usecase "Generare recomandări\nFor You" as UC_ForYou
  usecase "Sincronizare semnale\ncătre modulul ML" as UC_MLSync
  usecase "Import în Gallery\n(imagine + metadate)" as UC_GalleryImport
  usecase "Interacțiuni Gallery\n(like, save, comment)" as UC_GallerySocial
  usecase "Vizionare Cinema Live\n+ chat" as UC_CinemaLive
  usecase "Votare Cinema Poll" as UC_PollVote
  usecase "Activare reminder live\n(Notify me)" as UC_Reminder
  usecase "Înregistrare token push" as UC_PushToken
  usecase "Primire notificări\n(push + in-app)" as UC_Notifications

  usecase "Administrare Cinema Event\n(create/update/close)" as UC_AdminCinema
  usecase "Administrare Poll\n(open/close)" as UC_AdminPoll
}

User --> UC_Auth
User --> UC_Profile
User --> UC_Search
User --> UC_Details
User --> UC_Lists
User --> UC_ForYou
User --> UC_GalleryImport
User --> UC_GallerySocial
User --> UC_CinemaLive
User --> UC_PollVote
User --> UC_Reminder
User --> UC_Notifications

Admin --> UC_AdminCinema
Admin --> UC_AdminPoll

UC_ForYou .> UC_MLSync : <<include>>
UC_Lists .> UC_MLSync : <<include>>
UC_Notifications .> UC_PushToken : <<include>>
UC_Reminder .> UC_Notifications : <<extend>>

UC_Search --> TMDB
UC_Details --> TMDB
UC_GalleryImport --> Cloudinary
UC_Notifications --> ExpoPush
UC_ForYou --> ML
UC_MLSync --> ML

UC_AdminCinema .> UC_CinemaLive : <<include>>
UC_AdminPoll .> UC_PollVote : <<include>>
@enduml
"""


CLASS_DIAGRAM_PUML = r"""@startuml
title Movie-Rec - Class Diagram (Domain + Service)
skinparam shadowing false
skinparam classAttributeIconSize 0
skinparam packageStyle rectangle
skinparam monochrome true

package "Domain Entities" {
  class User {
    +id: int
    +backend_user_id: int
    +nickname: string
    +name: string
    +email: string
    +role: string
    +bio: string
    +avatar_url: string
  }

  class AuthSession {
    +id: int
    +user_id: int
    +session_token: string
    +created_at: datetime
  }

  abstract class MediaItem {
    +tmdb_id: int
    +title: string
    +overview: string
    +poster_path: string
    +backdrop_path: string
    +vote_average: float
  }

  class Movie
  class TvShow

  class UserMovieState {
    +user_id: int
    +tmdb_id: int
    +media_type: string
    +in_watchlist: bool
    +in_favorites: bool
    +watched: bool
    +rating: int
    +updated_at: datetime
  }

  class UserListPrivacy {
    +user_id: int
    +watchlist: bool
    +favorites: bool
    +watched: bool
    +rated: bool
  }

  class FollowRelation {
    +follower_id: int
    +followee_id: int
    +created_at: datetime
  }

  class MovieComment {
    +id: int
    +tmdb_id: int
    +user_id: int
    +text: string
    +parent_id: int
    +created_at: datetime
  }

  class GalleryItem {
    +id: int
    +title: string
    +tag: string
    +image_url: string
    +shot_id: string
    +created_at: datetime
  }

  class GalleryComment {
    +id: int
    +gallery_id: int
    +user_id: int
    +text: string
    +parent_id: int
    +created_at: datetime
  }

  class CinemaEvent {
    +id: int
    +title: string
    +video_url: string
    +poster_url: string
    +tmdb_id: int
    +start_at: datetime
    +end_at: datetime
  }

  class CinemaPoll {
    +id: int
    +question: string
    +status: string
    +expires_at: datetime
  }

  class CinemaPollOption {
    +id: string
    +poll_id: int
    +title: string
    +tmdb_id: int
    +poster_url: string
    +votes: int
  }

  class Notification {
    +id: int
    +user_id: int
    +type: string
    +title: string
    +body: string
    +action_path: string
    +read_at: datetime
  }

  class NotificationSubscription {
    +user_id: int
    +kind: string
    +target_id: string
    +payload_json: string
  }

  class PushToken {
    +id: int
    +user_id: int
    +expo_push_token: string
    +platform: string
    +device_name: string
  }

  class MLInteraction {
    +user_id: int
    +tmdb_id: int
    +media_type: string
    +event_type: string
    +event_value: float
    +occurred_at: datetime
  }

  class RecommendationResult {
    +user_id: int
    +tmdb_id: int
    +score: float
    +reason: string
  }
}

package "Application Services" {
  class AuthService
  class MovieStateService
  class GalleryService
  class CinemaService
  class NotificationService
  class RecommendationService
}

package "External Integrations" {
  class TMDBClient
  class CloudinaryClient
  class MLApiClient
  class ExpoPushClient
}

MediaItem <|-- Movie
MediaItem <|-- TvShow

User "1" -- "0..1" AuthSession
User "1" -- "0..*" UserMovieState
User "1" -- "0..*" MovieComment
User "1" -- "0..*" GalleryComment
User "1" -- "0..*" Notification
User "1" -- "0..*" NotificationSubscription
User "1" -- "0..*" PushToken
User "1" -- "0..*" MLInteraction
User "1" -- "0..*" FollowRelation : follower
User "1" -- "0..*" FollowRelation : followee
User "1" -- "0..1" UserListPrivacy

UserMovieState "*" --> "1" MediaItem
MovieComment "*" --> "1" MediaItem
GalleryComment "*" --> "1" GalleryItem
CinemaPoll "1" *-- "2..*" CinemaPollOption

AuthService ..> User
AuthService ..> AuthSession

MovieStateService ..> UserMovieState
MovieStateService ..> UserListPrivacy
MovieStateService ..> MLInteraction
MovieStateService ..> TMDBClient

GalleryService ..> GalleryItem
GalleryService ..> GalleryComment
GalleryService ..> CloudinaryClient

CinemaService ..> CinemaEvent
CinemaService ..> CinemaPoll
CinemaService ..> CinemaPollOption
CinemaService ..> MovieComment

NotificationService ..> Notification
NotificationService ..> NotificationSubscription
NotificationService ..> PushToken
NotificationService ..> ExpoPushClient

RecommendationService ..> MLInteraction
RecommendationService ..> RecommendationResult
RecommendationService ..> MLApiClient
RecommendationService ..> TMDBClient

@enduml
"""


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def render_with_kroki(plantuml_source: str, out_svg: Path) -> None:
    req = request.Request(
        url="https://kroki.io/plantuml/svg",
        data=plantuml_source.encode("utf-8"),
        headers={
            "Content-Type": "text/plain; charset=utf-8",
            "Accept": "image/svg+xml,text/plain,*/*",
            "User-Agent": "movie-rec-uml-generator/1.0",
        },
        method="POST",
    )
    with request.urlopen(req, timeout=30) as response:
        svg_data = response.read()
    out_svg.write_bytes(svg_data)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate Movie-Rec UML diagrams (Use Case + Class)."
    )
    parser.add_argument(
        "--render",
        action="store_true",
        help="Also render SVG files using Kroki API.",
    )
    args = parser.parse_args()

    out_dir = Path(__file__).resolve().parent
    use_case_puml = out_dir / "use_case_movie_rec.puml"
    class_puml = out_dir / "class_diagram_movie_rec.puml"

    write_text(use_case_puml, USE_CASE_PUML)
    write_text(class_puml, CLASS_DIAGRAM_PUML)

    print(f"[ok] Wrote {use_case_puml}")
    print(f"[ok] Wrote {class_puml}")

    if not args.render:
        return

    use_case_svg = out_dir / "use_case_movie_rec.svg"
    class_svg = out_dir / "class_diagram_movie_rec.svg"

    try:
        render_with_kroki(USE_CASE_PUML, use_case_svg)
        print(f"[ok] Rendered {use_case_svg}")
    except (error.URLError, TimeoutError, OSError) as exc:
        print(f"[warn] Could not render use-case SVG: {exc}")

    try:
        render_with_kroki(CLASS_DIAGRAM_PUML, class_svg)
        print(f"[ok] Rendered {class_svg}")
    except (error.URLError, TimeoutError, OSError) as exc:
        print(f"[warn] Could not render class SVG: {exc}")


if __name__ == "__main__":
    main()
