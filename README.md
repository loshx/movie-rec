# movie-rec

Expo and React Native movie discovery app backed by a Node service and a FastAPI recommendation layer.

## Overview

This repository combines three parts into one project:

- mobile and web client built with Expo and React Native
- Node backend used as the main data layer for app state
- FastAPI service for recommendation and ML-related flows

## Highlights

- Modern Expo / React Native app structure
- Local backend-first development workflow
- Separate ML service with Python dependencies
- Environment template for local secrets
- USB and LAN development scripts for device testing

## Architecture

- `src/` - app screens, routes, and UI logic
- `server/` - Node backend services
- `ml/` - FastAPI service and ML dependencies
- `scripts/` - local development orchestration

## Prerequisites

- Node.js 20+
- Python 3.10+
- Android platform tools (`adb`) for USB device flow

## One-time setup

Install JavaScript dependencies:

```bash
npm install
```

Install ML dependencies:

```bash
python -m venv ml/.venv
ml/.venv/Scripts/activate
pip install -r ml/requirements.txt
```

## Environment and private config

1. Copy `.env.example` to `.env` and fill in the values you actually use.
2. Keep `android/app/google-services.json` only on your machine, or provide it to EAS through the `GOOGLE_SERVICES_JSON` file secret.
3. Do not commit runtime tokens or local service files.

## Development

Recommended USB flow:

```bash
npm run dev:usb
```

LAN mode:

```bash
npm run dev:all
```

Start without ML:

```bash
npm run dev:no-ml
```

## Useful commands

Build on Android:

```bash
npx expo run:android --device
```

Reset local backend and ML data:

```bash
npm run reset:data
```

Run backend only:

```bash
npm run backend
```

Run ML service only:

```bash
ml/.venv/Scripts/python -m uvicorn api:app --host 0.0.0.0 --port 8008 --app-dir ml
```

