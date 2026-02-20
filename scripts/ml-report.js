/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP_JSON_PATH = path.join(ROOT, 'app.json');
const STORE_PATH = process.env.ML_REPORT_STORE_PATH || path.join(ROOT, 'server', 'data', 'cinema-events.json');
const REPORT_DIR = path.join(ROOT, 'reports');
const REPORT_JSON_PATH = path.join(REPORT_DIR, 'ml-report.json');
const REPORT_MD_PATH = path.join(REPORT_DIR, 'ml-report.md');

const TOP_K = Math.max(5, Number(process.env.ML_REPORT_TOP_K || 20));
const MIN_HISTORY = Math.max(4, Number(process.env.ML_REPORT_MIN_HISTORY || 5));
const MAX_USERS = Math.max(1, Number(process.env.ML_REPORT_MAX_USERS || 50));

function nowIso() {
  return new Date().toISOString();
}

function readJsonSafe(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function resolveConfig() {
  const appJson = readJsonSafe(APP_JSON_PATH, {});
  const extra = appJson?.expo?.extra || {};
  return {
    mlApiUrl: String(process.env.ML_API_URL || process.env.EXPO_PUBLIC_ML_API_URL || extra.EXPO_PUBLIC_ML_API_URL || '').trim(),
    tmdbToken: String(process.env.TMDB_TOKEN || process.env.EXPO_PUBLIC_TMDB_TOKEN || extra.EXPO_PUBLIC_TMDB_TOKEN || '').trim(),
    tmdbApiKey: String(process.env.TMDB_API_KEY || process.env.EXPO_PUBLIC_TMDB_API_KEY || extra.EXPO_PUBLIC_TMDB_API_KEY || '').trim(),
  };
}

function normalizeMediaType(value) {
  return String(value || '').toLowerCase() === 'tv' ? 'tv' : 'movie';
}

function asPositiveId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function parseDateValue(value, fallback) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function pushEvent(events, userId, mediaType, tmdbId, timestampMs, strength, source) {
  if (!userId || !tmdbId) return;
  events.push({
    userId,
    mediaType: normalizeMediaType(mediaType),
    tmdbId,
    timestampMs,
    strength,
    source,
  });
}

function collectEventsFromMovieState(userId, movieState, events) {
  const baseNow = Date.now();
  const watchlist = Array.isArray(movieState?.watchlist) ? movieState.watchlist : [];
  const favorites = Array.isArray(movieState?.favorites) ? movieState.favorites : [];
  const watched = Array.isArray(movieState?.watched) ? movieState.watched : [];
  const ratings = Array.isArray(movieState?.ratings) ? movieState.ratings : [];

  for (const row of watchlist) {
    const tmdbId = asPositiveId(row?.tmdb_id ?? row?.tmdbId);
    pushEvent(events, userId, row?.media_type ?? row?.mediaType, tmdbId, parseDateValue(row?.created_at ?? row?.createdAt, baseNow), 1, 'movieState.watchlist');
  }
  for (const row of favorites) {
    const tmdbId = asPositiveId(row?.tmdb_id ?? row?.tmdbId);
    pushEvent(events, userId, row?.media_type ?? row?.mediaType, tmdbId, parseDateValue(row?.created_at ?? row?.createdAt, baseNow), 2, 'movieState.favorites');
  }
  for (const row of watched) {
    const tmdbId = asPositiveId(row?.tmdb_id ?? row?.tmdbId);
    pushEvent(events, userId, row?.media_type ?? row?.mediaType, tmdbId, parseDateValue(row?.created_at ?? row?.createdAt, baseNow), 2, 'movieState.watched');
  }
  for (const row of ratings) {
    const tmdbId = asPositiveId(row?.tmdb_id ?? row?.tmdbId);
    const rating = Number(row?.rating);
    if (!Number.isFinite(rating) || rating < 7) continue;
    pushEvent(
      events,
      userId,
      row?.media_type ?? row?.mediaType,
      tmdbId,
      parseDateValue(row?.updated_at ?? row?.created_at ?? row?.updatedAt ?? row?.createdAt, baseNow),
      Math.max(2, Math.min(4, rating / 2)),
      'movieState.ratings'
    );
  }
}

function collectEventsFromProfile(userId, profile, events) {
  const now = Date.now();
  const readList = (list, source, strength, requireRating) => {
    const rows = Array.isArray(list) ? list : [];
    rows.forEach((row, index) => {
      const tmdbId = asPositiveId(row?.tmdb_id ?? row?.tmdbId);
      if (!tmdbId) return;
      if (requireRating) {
        const rating = Number(row?.rating);
        if (!Number.isFinite(rating) || rating < 7) return;
      }
      pushEvent(
        events,
        userId,
        row?.media_type ?? row?.mediaType,
        tmdbId,
        now - index * 1000,
        strength,
        source
      );
    });
  };

  readList(profile?.watchlist, 'profile.watchlist', 1, false);
  readList(profile?.favorites, 'profile.favorites', 2, false);
  readList(profile?.watched, 'profile.watched', 2, false);
  readList(profile?.rated, 'profile.rated', 3, true);
}

function buildUserDatasets(store) {
  const events = [];
  const userIds = new Set();

  const movieStates = store?.movieStates && typeof store.movieStates === 'object' ? store.movieStates : {};
  for (const [rawUserId, movieState] of Object.entries(movieStates)) {
    const userId = asPositiveId(rawUserId) || asPositiveId(movieState?.user_id);
    if (!userId) continue;
    userIds.add(userId);
    collectEventsFromMovieState(userId, movieState, events);
  }

  const users = store?.users && typeof store.users === 'object' ? store.users : {};
  for (const [rawUserId, profile] of Object.entries(users)) {
    const userId = asPositiveId(rawUserId) || asPositiveId(profile?.user_id);
    if (!userId) continue;
    userIds.add(userId);
    collectEventsFromProfile(userId, profile, events);
  }

  const grouped = new Map();
  for (const event of events) {
    const key = `${event.userId}:${event.mediaType}:${event.tmdbId}`;
    const prev = grouped.get(key);
    if (!prev) {
      grouped.set(key, event);
      continue;
    }
    if (event.timestampMs > prev.timestampMs || event.strength > prev.strength) {
      grouped.set(key, {
        ...prev,
        timestampMs: Math.max(prev.timestampMs, event.timestampMs),
        strength: Math.max(prev.strength, event.strength),
      });
    }
  }

  const byUserMedia = new Map();
  for (const row of grouped.values()) {
    const key = `${row.userId}:${row.mediaType}`;
    if (!byUserMedia.has(key)) byUserMedia.set(key, []);
    byUserMedia.get(key).push(row);
  }

  const datasets = [];
  for (const [key, rows] of byUserMedia.entries()) {
    const [userIdRaw, mediaType] = key.split(':');
    const userId = Number(userIdRaw);
    rows.sort((a, b) => b.timestampMs - a.timestampMs);
    const ids = rows.map((row) => row.tmdbId);
    if (ids.length < MIN_HISTORY) continue;
    const holdoutSize = Math.max(1, Math.min(5, Math.floor(ids.length * 0.2) || 1));
    const holdoutIds = ids.slice(0, holdoutSize);
    const trainIds = ids.slice(holdoutSize);
    if (!trainIds.length) continue;
    datasets.push({
      userId,
      mediaType: normalizeMediaType(mediaType),
      trainIds,
      holdoutIds,
      historySize: ids.length,
    });
  }

  datasets.sort((a, b) => b.historySize - a.historySize);
  return datasets.slice(0, MAX_USERS);
}

function buildTmdbRequest(pathname, config) {
  const base = 'https://api.themoviedb.org/3';
  if (config.tmdbToken) return `${base}${pathname}`;
  const delimiter = pathname.includes('?') ? '&' : '?';
  return `${base}${pathname}${delimiter}api_key=${encodeURIComponent(config.tmdbApiKey)}`;
}

async function tmdbFetch(pathname, config) {
  if (!config.tmdbToken && !config.tmdbApiKey) {
    throw new Error('TMDB token/key missing.');
  }
  const url = buildTmdbRequest(pathname, config);
  const headers = config.tmdbToken
    ? {
        Authorization: `Bearer ${config.tmdbToken}`,
        'Content-Type': 'application/json;charset=utf-8',
      }
    : {
        'Content-Type': 'application/json;charset=utf-8',
      };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

async function fetchTmdbBaseline(seedIds, mediaType, topK, config) {
  const scores = new Map();
  for (const seedId of seedIds.slice(0, 3)) {
    const path = mediaType === 'tv'
      ? `/tv/${seedId}/recommendations?language=en-US&page=1`
      : `/movie/${seedId}/recommendations?language=en-US&page=1`;
    let payload;
    try {
      payload = await tmdbFetch(path, config);
    } catch {
      continue;
    }
    const results = Array.isArray(payload?.results) ? payload.results : [];
    results.slice(0, topK).forEach((item, idx) => {
      const id = asPositiveId(item?.id);
      if (!id || seedIds.includes(id)) return;
      const current = scores.get(id) || 0;
      scores.set(id, current + (topK - idx));
    });
  }
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id]) => id);
}

async function fetchMlRecommendations(userId, mediaType, topK, config) {
  if (!config.mlApiUrl) return null;
  const base = config.mlApiUrl.replace(/\/+$/, '');
  const url = `${base}/recommendations/${encodeURIComponent(String(userId))}?media_type=${mediaType}&top_n=${topK}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ML ${res.status}`);
  const payload = await res.json();
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const unique = [];
  const seen = new Set();
  for (const row of items) {
    const id = asPositiveId(row?.tmdb_id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
    if (unique.length >= topK) break;
  }
  return unique;
}

function evaluateSingleRecommendation(recommendedIds, holdoutSet, topK) {
  const clean = (recommendedIds || []).slice(0, topK);
  const hits = clean.filter((id) => holdoutSet.has(id)).length;
  const precisionAtK = topK > 0 ? hits / topK : 0;
  const recallAtK = holdoutSet.size > 0 ? hits / holdoutSet.size : 0;
  return {
    hits,
    precisionAtK,
    recallAtK,
    hit: hits > 0 ? 1 : 0,
    recommendedIds: clean,
  };
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function computeDiversity(lists) {
  const filtered = lists.filter((list) => Array.isArray(list) && list.length > 0);
  if (filtered.length < 2) return null;
  let pairs = 0;
  let diversitySum = 0;
  for (let i = 0; i < filtered.length; i += 1) {
    for (let j = i + 1; j < filtered.length; j += 1) {
      const setA = new Set(filtered[i]);
      const setB = new Set(filtered[j]);
      const union = new Set([...setA, ...setB]);
      let intersectionCount = 0;
      for (const id of setA) {
        if (setB.has(id)) intersectionCount += 1;
      }
      const jaccard = union.size ? intersectionCount / union.size : 0;
      diversitySum += 1 - jaccard;
      pairs += 1;
    }
  }
  return pairs ? diversitySum / pairs : null;
}

function summarizeModel(modelName, rows, topK, catalogSize) {
  const precision = mean(rows.map((row) => row.precisionAtK));
  const recall = mean(rows.map((row) => row.recallAtK));
  const hitRate = mean(rows.map((row) => row.hit));
  const uniqueRecommended = new Set(rows.flatMap((row) => row.recommendedIds || []));
  const coverageDenominator = Math.max(catalogSize || 0, uniqueRecommended.size || 0, 1);
  const coverage = uniqueRecommended.size / coverageDenominator;
  const diversity = computeDiversity(rows.map((row) => row.recommendedIds || []));
  return {
    model: modelName,
    users: rows.length,
    topK,
    precision_at_k: precision,
    recall_at_k: recall,
    hit_rate: hitRate,
    coverage: coverage,
    diversity: diversity,
    unique_recommended_count: uniqueRecommended.size,
  };
}

function pct(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function numberFmt(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'n/a';
  return `${value.toFixed(3)}`;
}

function toMarkdown(report) {
  const lines = [];
  lines.push('# ML Evaluation Report');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Top-K: ${report.top_k}`);
  lines.push(`Users evaluated: ${report.dataset.users_evaluated}`);
  lines.push(`ML API configured: ${report.config.ml_api_configured ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Media | Model | Users | Precision@K | Recall@K | Hit-rate | Coverage | Diversity |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|');

  const medias = ['movie', 'tv'];
  for (const mediaType of medias) {
    const media = report.results[mediaType];
    if (!media) continue;
    const models = [media.ml, media.tmdb].filter(Boolean);
    for (const model of models) {
      lines.push(
        `| ${mediaType} | ${model.model} | ${model.users} | ${pct(model.precision_at_k)} | ${pct(model.recall_at_k)} | ${pct(model.hit_rate)} | ${pct(model.coverage)} | ${numberFmt(model.diversity)} |`
      );
    }
  }

  lines.push('');
  lines.push('## Notes');
  lines.push('');
  report.notes.forEach((note) => lines.push(`- ${note}`));
  lines.push('');
  return lines.join('\n');
}

async function evaluate() {
  const config = resolveConfig();
  const store = readJsonSafe(STORE_PATH, {});
  const datasets = buildUserDatasets(store);

  const byMedia = {
    movie: datasets.filter((row) => row.mediaType === 'movie'),
    tv: datasets.filter((row) => row.mediaType === 'tv'),
  };

  const results = {
    movie: { ml: null, tmdb: null, per_user: [] },
    tv: { ml: null, tmdb: null, per_user: [] },
  };

  const notes = [];
  if (!config.mlApiUrl) {
    notes.push('ML API URL is missing, ML metrics could not be computed. Set EXPO_PUBLIC_ML_API_URL or ML_API_URL.');
  }
  if (!config.tmdbToken && !config.tmdbApiKey) {
    notes.push('TMDB token/key is missing, TMDB baseline metrics could not be computed.');
  }

  for (const mediaType of ['movie', 'tv']) {
    const rows = byMedia[mediaType];
    if (!rows.length) {
      notes.push(`Not enough ${mediaType} history to evaluate (minimum history per user: ${MIN_HISTORY}).`);
      continue;
    }

    const catalog = new Set();
    rows.forEach((row) => {
      row.trainIds.forEach((id) => catalog.add(id));
      row.holdoutIds.forEach((id) => catalog.add(id));
    });

    const mlRows = [];
    const tmdbRows = [];
    for (const row of rows) {
      const holdoutSet = new Set(row.holdoutIds);
      let mlIds = null;
      if (config.mlApiUrl) {
        try {
          mlIds = await fetchMlRecommendations(row.userId, mediaType, TOP_K, config);
        } catch {
          mlIds = null;
        }
      }

      let tmdbIds = null;
      if (config.tmdbToken || config.tmdbApiKey) {
        try {
          tmdbIds = await fetchTmdbBaseline(row.trainIds, mediaType, TOP_K, config);
        } catch {
          tmdbIds = null;
        }
      }

      const perUser = {
        user_id: row.userId,
        media_type: mediaType,
        history_size: row.historySize,
        train_size: row.trainIds.length,
        holdout_size: row.holdoutIds.length,
        holdout_ids: row.holdoutIds,
        ml_recommended_ids: mlIds,
        tmdb_recommended_ids: tmdbIds,
      };
      results[mediaType].per_user.push(perUser);

      if (Array.isArray(mlIds)) {
        mlRows.push(evaluateSingleRecommendation(mlIds, holdoutSet, TOP_K));
      }
      if (Array.isArray(tmdbIds)) {
        tmdbRows.push(evaluateSingleRecommendation(tmdbIds, holdoutSet, TOP_K));
      }
    }

    if (mlRows.length) {
      results[mediaType].ml = summarizeModel('ML', mlRows, TOP_K, catalog.size);
    }
    if (tmdbRows.length) {
      results[mediaType].tmdb = summarizeModel('TMDB-baseline', tmdbRows, TOP_K, catalog.size);
    }
  }

  const report = {
    generated_at: nowIso(),
    top_k: TOP_K,
    min_history_per_user: MIN_HISTORY,
    config: {
      ml_api_configured: !!config.mlApiUrl,
      tmdb_configured: !!(config.tmdbToken || config.tmdbApiKey),
      store_path: STORE_PATH,
    },
    dataset: {
      users_evaluated: datasets.length,
      users_movie: byMedia.movie.length,
      users_tv: byMedia.tv.length,
    },
    results,
    notes,
  };

  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(REPORT_MD_PATH, toMarkdown(report), 'utf8');
  return report;
}

(async () => {
  try {
    const report = await evaluate();
    console.log(`ML report generated: ${REPORT_MD_PATH}`);
    console.log(`Users evaluated: ${report.dataset.users_evaluated}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
})();
