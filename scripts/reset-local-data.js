#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const storePath = path.join(ROOT, 'server', 'data', 'cinema-events.json');
const mlDbPath = path.join(ROOT, 'ml', 'ml_local.db');

const emptyStore = {
  store_updated_at: new Date().toISOString(),
  idSeq: 1,
  userIdSeq: 1,
  items: [],
  cinemaPollIdSeq: 1,
  cinemaPollCurrent: null,
  commentIdSeq: 1,
  comments: [],
  users: {},
  localAuth: {},
  userAliases: {},
  userSessions: {},
  follows: {},
  movieStates: {},
  galleryIdSeq: 1,
  galleryCommentIdSeq: 1,
  galleryItems: [],
  galleryLikes: [],
  galleryFavorites: [],
  galleryComments: [],
};

function writeStore() {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, `${JSON.stringify(emptyStore, null, 2)}\n`, 'utf8');
}

function removeMlDb() {
  if (fs.existsSync(mlDbPath)) {
    fs.rmSync(mlDbPath, { force: true });
  }
}

writeStore();
removeMlDb();

process.stdout.write('[reset-local-data] local backend store reset\n');
process.stdout.write('[reset-local-data] ml/ml_local.db removed (if it existed)\n');
