import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '@/contexts/AuthContext';
import { getUserFavorites, getUserRatings, getUserWatched } from '@/db/user-movies';
import {
  Movie,
  getMoviesByGenre,
  getNewMovies,
  getPopularMovies,
  getSimilarMovies,
  getTopRatedMovies,
  posterUrl,
} from '@/lib/tmdb';
import { getMlRecommendations, hasMlApi } from '@/lib/ml-recommendations';

type Mode = 'trending' | 'genre';

function titleOf(movie: Movie) {
  return String(movie.title || '').trim() || 'Movie';
}

function hasPoster(movie: Movie) {
  return !!movie.poster_path && !!titleOf(movie);
}

function getMovieGenreIds(movie: Movie) {
  const fromIds = Array.isArray((movie as any)?.genre_ids) ? (movie as any).genre_ids : [];
  const fromGenres = Array.isArray((movie as any)?.genres)
    ? (movie as any).genres.map((row: any) => Number(row?.id))
    : [];
  return [...fromIds, ...fromGenres]
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
}

function toUniqueMovies(rows: Movie[]) {
  const seen = new Set<number>();
  const out: Movie[] = [];
  for (const row of rows) {
    const id = Number(row?.id ?? 0);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

function scoreMovie(
  movie: Movie,
  input: {
    watchedSet: Set<number>;
    mlSet: Set<number>;
    genreBoostId?: number | null;
  }
) {
  const id = Number(movie.id);
  const voteAverage = Number((movie as any)?.vote_average ?? 0);
  const voteCount = Number((movie as any)?.vote_count ?? 0);
  const popularity = Number((movie as any)?.popularity ?? 0);
  let score = voteAverage * 0.55 + Math.log1p(Math.max(0, voteCount)) * 0.25 + Math.log1p(Math.max(0, popularity)) * 0.2;
  if (input.mlSet.has(id)) score += 3.2;
  if (input.genreBoostId && getMovieGenreIds(movie).includes(input.genreBoostId)) score += 1.4;
  if (input.watchedSet.has(id)) score -= 6;
  if (voteCount > 0 && voteCount < 120) score -= 0.7;
  return score;
}

export default function DiscoverPicksScreen() {
  const { user } = useAuth();
  const params = useLocalSearchParams<{
    mode?: string;
    genre?: string;
    label?: string;
  }>();

  const mode: Mode = String(params.mode || 'trending').toLowerCase() === 'genre' ? 'genre' : 'trending';
  const genreId = Number(params.genre ?? 0);
  const genreLabel = String(params.label ?? '').trim();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [picks, setPicks] = useState<Movie[]>([]);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const userId = Number(user?.id ?? 0);
        const hasUser = Number.isFinite(userId) && userId > 0;

        const [popular1, topRated1, fresh1, genre1, genre2, favoriteRows, watchedRows, ratingRows, mlRows] =
          await Promise.all([
            getPopularMovies(1),
            getTopRatedMovies(1),
            getNewMovies(1),
            mode === 'genre' && Number.isFinite(genreId) && genreId > 0
              ? getMoviesByGenre(genreId, 1, { sortBy: 'popularity.desc' })
              : Promise.resolve({ results: [], total_pages: 1 }),
            mode === 'genre' && Number.isFinite(genreId) && genreId > 0
              ? getMoviesByGenre(genreId, 2, { sortBy: 'vote_average.desc' })
              : Promise.resolve({ results: [], total_pages: 1 }),
            hasUser ? getUserFavorites(userId) : Promise.resolve([]),
            hasUser ? getUserWatched(userId) : Promise.resolve([]),
            hasUser ? getUserRatings(userId) : Promise.resolve([]),
            hasUser && hasMlApi()
              ? getMlRecommendations(userId, { mediaType: 'movie', topN: 80 }).catch(() => [])
              : Promise.resolve([]),
          ]);

        const watchedSet = new Set((watchedRows ?? []).map((row) => Number(row.tmdbId)));
        const favoriteSeedIds = (favoriteRows ?? [])
          .map((row) => Number(row.tmdbId))
          .filter((id) => Number.isFinite(id) && id > 0)
          .slice(0, 3);
        const mlSet = new Set((mlRows ?? []).map((row) => Number((row as any)?.tmdb_id ?? 0)));
        for (const row of ratingRows ?? []) {
          if (Number(row.rating ?? 0) >= 8.5) {
            mlSet.add(Number(row.tmdbId));
          }
        }

        const similarBuckets = await Promise.all(
          favoriteSeedIds.map(async (id) => {
            try {
              const result = await getSimilarMovies(id, 1);
              return result.results ?? [];
            } catch {
              return [] as Movie[];
            }
          })
        );

        const base = [
          ...(popular1.results ?? []),
          ...(topRated1.results ?? []),
          ...(fresh1.results ?? []),
          ...(genre1.results ?? []),
          ...(genre2.results ?? []),
          ...similarBuckets.flat(),
        ].filter(hasPoster);

        const unique = toUniqueMovies(base);
        const ranked = unique
          .map((movie, idx) => ({
            movie,
            idx,
            score: scoreMovie(movie, {
              watchedSet,
              mlSet,
              genreBoostId: mode === 'genre' && Number.isFinite(genreId) && genreId > 0 ? genreId : null,
            }),
          }))
          .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.idx - b.idx;
          })
          .map((row) => row.movie);

        const filteredByGenre =
          mode === 'genre' && Number.isFinite(genreId) && genreId > 0
            ? ranked.filter((movie) => getMovieGenreIds(movie).includes(genreId))
            : ranked;
        const top6 = (filteredByGenre.length >= 6 ? filteredByGenre : ranked).slice(0, 6);
        if (!active) return;
        setPicks(top6);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Could not load picks.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [genreId, mode, user?.id]);

  const title = useMemo(() => {
    if (mode === 'genre' && Number.isFinite(genreId) && genreId > 0) {
      return genreLabel ? `${genreLabel} Picks` : 'Mood Picks';
    }
    return 'Everyone Is Watching';
  }, [genreId, genreLabel, mode]);

  const subtitle = mode === 'genre'
    ? 'TMDB quality + popularity + your ML/KNN taste signals'
    : 'Live trend blend from TMDB + personalized taste boost';

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={18} color="#FFFFFF" />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
        </View>
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color="#FFFFFF" />
        </View>
      ) : error ? (
        <View style={styles.loadingWrap}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : (
        <FlatList
          data={picks}
          keyExtractor={(item) => String(item.id)}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => {
            const image = posterUrl(item.poster_path, 'w342');
            return (
              <Pressable
                onPress={() => router.push({ pathname: '/movie/[id]', params: { id: String(item.id), type: 'movie' } })}
                style={styles.card}>
                {image ? (
                  <Image source={{ uri: image }} style={styles.poster} contentFit="cover" transition={120} />
                ) : (
                  <View style={[styles.poster, styles.posterFallback]} />
                )}
                <Text style={styles.movieTitle} numberOfLines={1}>
                  {titleOf(item)}
                </Text>
                <Text style={styles.movieMeta}>{Number(item.vote_average ?? 0).toFixed(1)} / 10</Text>
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#04070F',
  },
  header: {
    paddingTop: 58,
    paddingHorizontal: 14,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  headerText: {
    flex: 1,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 21,
    fontWeight: '800',
  },
  subtitle: {
    marginTop: 2,
    color: 'rgba(211,221,236,0.78)',
    fontSize: 12,
  },
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  errorText: {
    color: '#FFB4B4',
    textAlign: 'center',
  },
  listContent: {
    paddingHorizontal: 14,
    paddingBottom: 120,
    gap: 12,
  },
  row: {
    gap: 12,
  },
  card: {
    width: '48%',
  },
  poster: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  posterFallback: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  movieTitle: {
    marginTop: 6,
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 13,
  },
  movieMeta: {
    marginTop: 1,
    color: 'rgba(212,222,238,0.76)',
    fontSize: 11,
  },
});

