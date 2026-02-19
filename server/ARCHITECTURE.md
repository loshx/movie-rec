# Backend Architecture (Cinema)

## Goal
Single backend for all users/devices so cinema sessions are shared globally.

## Runtime
- Node.js server
- HTTP REST API + WebSocket in one process
- Default port: `8787`
- Entry point: `server/cinema-ws-server.js`

## Storage
- Persistent JSON store: `server/data/cinema-events.json`
- Structure:
  - `idSeq`: next event id
  - `items[]`: cinema events

## REST API
- `GET /health`
- `GET /api/cinema/latest`
- `GET /api/cinema/current?now=<iso>`
- `POST /api/cinema/events`
  - Requires `x-admin-key` when `ADMIN_API_KEY` is set
  - Body:
    - `title`
    - `description`
    - `video_url` (public URL)
    - `poster_url` (public URL)
    - `start_at` (ISO)
    - `end_at` (ISO)
    - `created_by` (optional)

## WebSocket API
- Endpoint: `/ws`
- Room key used by app: `cinema:<eventId>`
- Messages:
  - Client -> Server:
    - `join`
    - `message`
    - `like`
  - Server -> Client:
    - `history`
    - `message`
    - `stats` (`viewers`, `likes`)
    - `liked`

## Mobile/Web integration
- App reads backend URL from `expo.extra.EXPO_PUBLIC_BACKEND_URL`
- App reads WS URL from:
  - `EXPO_PUBLIC_CINEMA_WS_URL`, or
  - fallback `EXPO_PUBLIC_BACKEND_URL + /ws`
- `src/db/cinema.ts` and `src/db/cinema.web.ts`:
  - Use backend when configured
  - Fallback to local DB/localStorage when backend URL missing

## Start
```bash
npm run backend
```

## Required env for secure admin publish
- `ADMIN_API_KEY=<secret>` on backend process
- `EXPO_PUBLIC_ADMIN_API_KEY=<same secret>` in app config

