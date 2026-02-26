# Movie Rec Dev Guide

## Architecture (simplified)

- Mobile/Web app: Expo + React Native (`src/`)
- Backend (single source of truth for users/data): Node server (`server/cinema-ws-server.js`)
- ML recommendations service: FastAPI (`ml/api.py`)

When backend URL is configured, app data paths use backend-first logic and avoid local fallback writes.

## Prerequisites

- Node.js 20+
- Python 3.10+
- Android platform tools (`adb`) for USB phone flow

## One-time setup

1. Install JS deps:

```bash
npm install
```

2. Install ML deps:

```bash
python -m venv ml/.venv
ml/.venv/Scripts/activate
pip install -r ml/requirements.txt
```

## Start everything (recommended)

### Android phone via USB (most stable)

```bash
npm run dev:usb
```

This starts backend + ML + Expo and configures `adb reverse` automatically.

### LAN mode (same Wi-Fi)

```bash
npm run dev:all
```

### Start without ML (fallback mode)

```bash
npm run dev:no-ml
```

## Build/install app on Android device

```bash
npx expo run:android --device
```

If Metro port conflict appears:

```bash
npx expo start --dev-client -c --port 8081
```

## Reset local dev data

This clears local backend store and ML sqlite DB:

```bash
npm run reset:data
```

Then reinstall app / clear app storage on phone to remove local sqlite cache.

## Manual service commands (optional)

Backend only:

```bash
npm run backend
```

ML only:

```bash
ml/.venv/Scripts/python -m uvicorn api:app --host 0.0.0.0 --port 8008 --app-dir ml
```
