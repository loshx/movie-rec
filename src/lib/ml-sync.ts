import {
  getUserFavoriteActors,
  getUserFavoriteDirectors,
  getUserFavorites,
  getUserRatings,
  getUserWatchlist,
  getUserWatched,
} from '@/db/user-movies';
import { hasMlApi, ingestMlInteractionsBatch, MlInteractionEvent } from '@/lib/ml-recommendations';
import { getPersonCombinedCredits } from '@/lib/tmdb';

function pushIf<T>(arr: T[], value: T | null | undefined) {
  if (value) arr.push(value);
}

export async function syncUserHistoryToMl(userId: number) {
  if (!hasMlApi()) return;

  const [watchlist, favorites, watched, ratings, favoriteActors, favoriteDirectors] = await Promise.all([
    getUserWatchlist(userId),
    getUserFavorites(userId),
    getUserWatched(userId),
    getUserRatings(userId),
    getUserFavoriteActors(userId),
    getUserFavoriteDirectors(userId),
  ]);

  const payload: MlInteractionEvent[] = [];
  for (const row of watchlist) {
    pushIf(payload, {
      user_id: userId,
      tmdb_id: row.tmdbId,
      media_type: row.mediaType ?? 'movie',
      event_type: 'watchlist',
      event_value: 1,
      occurred_at: row.createdAt,
    });
  }
  for (const row of favorites) {
    pushIf(payload, {
      user_id: userId,
      tmdb_id: row.tmdbId,
      media_type: row.mediaType ?? 'movie',
      event_type: 'favorite',
      event_value: 1,
      occurred_at: row.createdAt,
    });
  }
  for (const row of watched) {
    pushIf(payload, {
      user_id: userId,
      tmdb_id: row.tmdbId,
      media_type: row.mediaType ?? 'movie',
      event_type: 'watched',
      event_value: 1,
      occurred_at: row.createdAt,
    });
  }
  for (const row of ratings) {
    pushIf(payload, {
      user_id: userId,
      tmdb_id: row.tmdbId,
      media_type: row.mediaType ?? 'movie',
      event_type: 'rating',
      event_value: typeof row.rating === 'number' ? row.rating : null,
      occurred_at: row.createdAt,
    });
  }

  if (favoriteActors.length > 0) {
    const creditsByActor = await Promise.all(
      favoriteActors.slice(0, 12).map(async (row) => {
        try {
          const res = await getPersonCombinedCredits(row.personId);
          return { createdAt: row.createdAt, items: res.cast ?? [] };
        } catch {
          return { createdAt: row.createdAt, items: [] as any[] };
        }
      })
    );

    for (const actorCredits of creditsByActor) {
      for (const item of actorCredits.items
        .filter((x) => (x.media_type === 'movie' || x.media_type === 'tv') && x.id > 0)
        .sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0))
        .slice(0, 18)) {
        pushIf(payload, {
          user_id: userId,
          tmdb_id: item.id,
          media_type: item.media_type,
          event_type: 'favorite_actor',
          event_value: item.vote_average ?? null,
          occurred_at: actorCredits.createdAt,
        });
      }
    }
  }

  if (favoriteDirectors.length > 0) {
    const creditsByDirector = await Promise.all(
      favoriteDirectors.slice(0, 12).map(async (row) => {
        try {
          const res = await getPersonCombinedCredits(row.personId);
          return {
            createdAt: row.createdAt,
            items: (res.crew ?? []).filter(
              (x) =>
                (x.media_type === 'movie' || x.media_type === 'tv') &&
                (String(x.job || '').toLowerCase() === 'director' ||
                  String(x.department || '').toLowerCase() === 'directing')
            ),
          };
        } catch {
          return { createdAt: row.createdAt, items: [] as any[] };
        }
      })
    );

    for (const directorCredits of creditsByDirector) {
      for (const item of directorCredits.items
        .filter((x) => (x.media_type === 'movie' || x.media_type === 'tv') && x.id > 0)
        .sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0))
        .slice(0, 18)) {
        pushIf(payload, {
          user_id: userId,
          tmdb_id: item.id,
          media_type: item.media_type,
          event_type: 'favorite_actor',
          event_value: item.vote_average ?? null,
          occurred_at: directorCredits.createdAt,
        });
      }
    }
  }

  const dedup = new Map<string, MlInteractionEvent>();
  for (const item of payload) {
    const key = `${item.user_id}:${item.tmdb_id}:${item.media_type}:${item.event_type}`;
    if (!dedup.has(key)) dedup.set(key, item);
  }

  await ingestMlInteractionsBatch(Array.from(dedup.values()));
}
