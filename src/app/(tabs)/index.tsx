import { Image } from 'expo-image';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Easing,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { GlassView } from '@/components/glass-view';

import { useAuth } from '@/contexts/AuthContext';
import { getCinemaEventByStatusNow, type CinemaEvent } from '@/db/cinema';
import { getFeaturedMovie } from '@/db/featured';
import {
  backdropUrl,
  getMoviesByGenre,
  getMovieById,
  getNewEpisodes,
  getNewMovies,
  getPopularMovies,
  getSimilarMovies,
  posterUrl,
  searchMulti,
  Movie,
  SearchMediaResult,
  TvShow,
} from '@/lib/tmdb';
import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  getMovieEngagementCounts,
  getUserFavorites,
  getUserRatings,
  getUserWatchlist,
  getUserWatched,
} from '@/db/user-movies';
import { getMlRecommendations, hasMlApi, syncMlFollowingGraph } from '@/lib/ml-recommendations';
import { getFollowingProfiles } from '@/lib/social-backend';
import { getSearchClickHistory, upsertSearchClickHistory } from '@/db/search-click-history';

type FeaturedDisplay = {
  tmdb_id: number | null;
  title: string | null;
  overview: string | null;
  backdrop_path: string | null;
  poster_path: string | null;
};

type HomeSnapshot = {
  userId: number | null;
  featured: FeaturedDisplay | null;
  popular: Movie[];
  newMovies: Movie[];
  newMoviesTitle: string;
  newMoviesSubtitle: string | null;
  forYouMovies: Movie[];
  todayDramaMovies: Movie[];
  trackedEpisodes: TvShow[];
  newEpisodes: TvShow[];
  watchedIds: number[];
  popularPage: number;
  popularTotalPages: number;
  newMoviesPage: number;
  newMoviesTotalPages: number;
  newEpisodesPage: number;
  newEpisodesTotalPages: number;
};

let homeSnapshot: HomeSnapshot | null = null;

const GENRES = [
  { id: 27, name: 'Horror' },
  { id: 16, name: 'Anime' },
  { id: 35, name: 'Comedy' },
  { id: 28, name: 'Action' },
  { id: 18, name: 'Drama' },
  { id: 10749, name: 'Romance' },
  { id: 878, name: 'Sciâ€‘Fi' },
  { id: 53, name: 'Thriller' },
  { id: 14, name: 'Fantasy' },
  { id: 99, name: 'Documentary' },
];

function mapMovieToFeatured(movie: Movie): FeaturedDisplay {
  return {
    tmdb_id: movie.id,
    title: movie.title,
    overview: movie.overview,
    backdrop_path: movie.backdrop_path,
    poster_path: movie.poster_path,
  };
}

function hasListData(item: { poster_path: string | null; vote_average: number; overview: string }) {
  return !!item.poster_path && (item.vote_average ?? 0) > 0 && !!item.overview?.trim();
}

function excludeWatched<T extends { id: number }>(items: T[], watchedIdSet: Set<number>) {
  return items.filter((item) => !watchedIdSet.has(item.id));
}

function randomStartPage(max = 5) {
  return Math.max(1, Math.floor(Math.random() * max) + 1);
}

type SearchResultItem = Movie | TvShow | SearchMediaResult;

type SearchTasteSignals = {
  watchlistIds: number[];
  favoriteIds: number[];
  watchedIds: number[];
  ratingsById: Record<number, number>;
  mlMovieIds: number[];
  mlTvIds: number[];
};

type HeroSlide = {
  id: string;
  tmdbId?: number | null;
  title: string;
  subtitle?: string;
  image: string | null;
};

function isTvItem(item: SearchResultItem) {
  if ('media_type' in item) return item.media_type === 'tv';
  return 'name' in item && !('title' in item);
}

function toTitle(item: SearchResultItem) {
  if ('title' in item && item.title) return item.title;
  if ('name' in item && item.name) return item.name;
  return '';
}

function rankByTaste(items: SearchResultItem[], signals: SearchTasteSignals): SearchResultItem[] {
  const watchlist = new Set(signals.watchlistIds);
  const favorites = new Set(signals.favoriteIds);
  const watched = new Set(signals.watchedIds);
  const mlMovies = new Set(signals.mlMovieIds);
  const mlTv = new Set(signals.mlTvIds);
  const ratings = signals.ratingsById;

  return [...items]
    .map((item, idx) => {
      const id = Number(item.id ?? 0);
      const mediaType = isTvItem(item) ? 'tv' : 'movie';
      const ratingSignal = Number(ratings[id] ?? 0);
      const vote = Number(item.vote_average ?? 0);
      let score = vote * 0.08;
      if (favorites.has(id)) score += 2.4;
      if (watchlist.has(id)) score += 1.4;
      if (watched.has(id)) score -= 3.0;
      if (ratingSignal > 0) score += ratingSignal / 5;
      if (mediaType === 'movie' && mlMovies.has(id)) score += 3.2;
      if (mediaType === 'tv' && mlTv.has(id)) score += 3.2;
      return { item, idx, score };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.idx - b.idx;
    })
    .map((x) => x.item);
}

export default function HomeScreen() {
  const { user } = useAuth();
  const theme = useTheme();

  const [featured, setFeatured] = useState<FeaturedDisplay | null>(null);
  const [popular, setPopular] = useState<Movie[]>([]);
  const [newMovies, setNewMovies] = useState<Movie[]>([]);
  const [newMoviesTitle, setNewMoviesTitle] = useState('New Movies');
  const [newMoviesSubtitle, setNewMoviesSubtitle] = useState<string | null>(null);
  const [forYouMovies, setForYouMovies] = useState<Movie[]>([]);
  const [todayDramaMovies, setTodayDramaMovies] = useState<Movie[]>([]);
  const [trackedEpisodes, setTrackedEpisodes] = useState<TvShow[]>([]);
  const [newEpisodes, setNewEpisodes] = useState<TvShow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [minDelayDone, setMinDelayDone] = useState(false);

  const [popularPage, setPopularPage] = useState(1);
  const [popularTotalPages, setPopularTotalPages] = useState(1);
  const [newMoviesPage, setNewMoviesPage] = useState(1);
  const [newMoviesTotalPages, setNewMoviesTotalPages] = useState(1);
  const [newEpisodesPage, setNewEpisodesPage] = useState(1);
  const [newEpisodesTotalPages, setNewEpisodesTotalPages] = useState(1);
  const [loadingMore, setLoadingMore] = useState<null | 'popular' | 'newMovies' | 'newEpisodes'>(
    null
  );
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [searchClickedHistory, setSearchClickedHistory] = useState<SearchResultItem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [watchedIds, setWatchedIds] = useState<number[]>([]);
  const [searchTasteSignals, setSearchTasteSignals] = useState<SearchTasteSignals>({
    watchlistIds: [],
    favoriteIds: [],
    watchedIds: [],
    ratingsById: {},
    mlMovieIds: [],
    mlTvIds: [],
  });
  const [cinemaEvent, setCinemaEvent] = useState<CinemaEvent | null>(null);
  const [cinemaNowIso, setCinemaNowIso] = useState(new Date().toISOString());
  const [cinemaNotifyArmed, setCinemaNotifyArmed] = useState(false);
  const [heroStats, setHeroStats] = useState({ favorites: 0, watched: 0, rated: 0 });
  const [heroIndex, setHeroIndex] = useState(0);
  const [heroSlideWidth, setHeroSlideWidth] = useState(0);
  const heroScrollRef = useRef<ScrollView | null>(null);
  const refreshTokenRef = useRef(0);
  const firstLoadDoneRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const shouldRefreshOnActiveRef = useRef(false);
  const prevCinemaPhaseRef = useRef<'upcoming' | 'live' | 'ended' | 'none'>('none');

  const rememberClickedSearchItem = useCallback(
    (item: SearchResultItem) => {
      const title = toTitle(item);
      if (!title) return;
      const mediaType: 'movie' | 'tv' = isTvItem(item) ? 'tv' : 'movie';
      const clickedAsResult: SearchMediaResult = {
        id: item.id,
        media_type: mediaType,
        title: mediaType === 'movie' ? title : undefined,
        name: mediaType === 'tv' ? title : undefined,
        overview: item.overview ?? '',
        poster_path: item.poster_path ?? null,
        backdrop_path: item.backdrop_path ?? null,
        vote_average: item.vote_average ?? 0,
        release_date: 'release_date' in item ? item.release_date : undefined,
        first_air_date: 'first_air_date' in item ? item.first_air_date : undefined,
      };
      setSearchClickedHistory((prev) => {
        const next = [clickedAsResult, ...prev.filter((x) => x.id !== item.id || isTvItem(x) !== isTvItem(item))];
        return next.slice(0, 12);
      });
      if (user?.id) {
        void upsertSearchClickHistory(user.id, {
          tmdbId: item.id,
          mediaType,
          title,
          posterPath: item.poster_path ?? null,
          voteAverage: item.vote_average ?? 0,
        }).catch(() => {});
      }
    },
    [user?.id]
  );

  const loadHome = useCallback(
    async ({ randomizePages, silent }: { randomizePages: boolean; silent: boolean }) => {
      const token = ++refreshTokenRef.current;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const watchedRows = user ? await getUserWatched(user.id) : [];
        const watchedIdSet = new Set(watchedRows.map((row) => row.tmdbId));
        if (token !== refreshTokenRef.current) return;
        setWatchedIds(Array.from(watchedIdSet));

        const popularStartPage = randomizePages ? randomStartPage(5) : 1;
        const newMoviesStartPage = randomizePages ? randomStartPage(5) : 1;
        const newEpisodesStartPage = randomizePages ? randomStartPage(5) : 1;
        const todayDramaPage = randomizePages ? randomStartPage(4) : 1;

        const [featuredDb, popularRes, newMovieRes, newEpisodeRes, todayDramaRes] = await Promise.all([
          getFeaturedMovie(),
          getPopularMovies(popularStartPage),
          getNewMovies(newMoviesStartPage),
          getNewEpisodes(newEpisodesStartPage),
          getMoviesByGenre(18, todayDramaPage),
        ]);

        if (token !== refreshTokenRef.current) return;

        const popularMovies = excludeWatched((popularRes.results ?? []).filter(hasListData), watchedIdSet);
        setPopular(popularMovies);
        setPopularPage(popularStartPage);
        setPopularTotalPages(popularRes.total_pages ?? 1);
        let nextNewMovies = excludeWatched((newMovieRes.results ?? []).filter(hasListData), watchedIdSet);
        let nextNewMoviesTitle = 'New Movies';
        let nextNewMoviesSubtitle: string | null = null;
        let nextForYouMovies: Movie[] = [];
        const nextTodayDramaMovies = excludeWatched(
          (todayDramaRes.results ?? []).filter(hasListData),
          watchedIdSet
        ).slice(0, 20);
        setNewMoviesPage(newMoviesStartPage);
        setNewMoviesTotalPages(newMovieRes.total_pages ?? 1);
        const cleanOnTheAir = excludeWatched((newEpisodeRes.results ?? []).filter(hasListData), watchedIdSet);
        let nextTrackedEpisodes: TvShow[] = [];
        setNewEpisodes(cleanOnTheAir);
        setNewEpisodesPage(newEpisodesStartPage);
        setNewEpisodesTotalPages(newEpisodeRes.total_pages ?? 1);

        if (user) {
          try {
            const [watchlistRows, favoriteRows, ratingRows] = await Promise.all([
              getUserWatchlist(user.id),
              getUserFavorites(user.id),
              getUserRatings(user.id),
            ]);
            const watchedIds = new Set(watchedRows.map((row) => row.tmdbId));
            const seedMovieIds = Array.from(
              new Set([
                ...ratingRows
                  .filter((row) => row.mediaType !== 'tv' && typeof row.rating === 'number')
                  .sort((a, b) => Number(b.rating ?? 0) - Number(a.rating ?? 0))
                  .map((row) => row.tmdbId),
                ...favoriteRows.filter((row) => row.mediaType !== 'tv').map((row) => row.tmdbId),
                ...watchlistRows.filter((row) => row.mediaType !== 'tv').map((row) => row.tmdbId),
                ...watchedRows.filter((row) => row.mediaType !== 'tv').map((row) => row.tmdbId),
              ].filter((id) => Number.isFinite(id) && id > 0))
            );
            const trackedTvIds = new Set<number>();
            [...watchlistRows, ...favoriteRows].forEach((row) => {
              if (row.mediaType === 'tv' && !watchedIds.has(row.tmdbId)) {
                trackedTvIds.add(row.tmdbId);
              }
            });
            if (trackedTvIds.size > 0) {
              nextTrackedEpisodes = cleanOnTheAir.filter((tv) => trackedTvIds.has(tv.id)).slice(0, 20);
            }
            const genreCount: Record<number, number> = {};
            const candidateMovieIds = new Set<number>([
              ...((popularRes.results ?? []).map((item) => item.id)),
              ...((newMovieRes.results ?? []).map((item) => item.id)),
            ]);

            if (hasMlApi()) {
              try {
                const followingProfiles = await getFollowingProfiles(user.id);
                await syncMlFollowingGraph(
                  user.id,
                  followingProfiles.map((p) => p.user_id)
                );
                const mlIds = await getMlRecommendations(user.id, { mediaType: 'movie', topN: 24 });
                if (mlIds.length > 0) {
                  const details = await Promise.all(
                    mlIds.map(async (row) => {
                      try {
                        return await getMovieById(row.tmdb_id);
                      } catch {
                        return null;
                      }
                    })
                  );
                  const mlMovies = details
                    .filter((item): item is Movie => !!item)
                    .filter((item) => !watchedIds.has(item.id))
                    .filter(hasListData);
                  if (mlMovies.length > 0) {
                    nextForYouMovies = mlMovies.slice(0, 20);
                    nextNewMovies = mlMovies;
                    nextNewMoviesTitle = 'For You (ML)';
                    const seedMovieId = seedMovieIds[0] ?? null;
                    if (seedMovieId) {
                      try {
                        const seedMovie = await getMovieById(seedMovieId);
                        const recoTop = mlMovies[0];
                        if (seedMovie?.title && recoTop?.title) {
                          nextNewMoviesSubtitle = `You loved ${seedMovie.title}, we think you'll love ${recoTop.title}`;
                        }
                      } catch {
                      }
                    }
                    if (!nextNewMoviesSubtitle) {
                      const reason = String(mlIds[0]?.reason ?? '').trim();
                      nextNewMoviesSubtitle = reason || null;
                    }
                  }
                }
              } catch {
              }
            }

            if (nextForYouMovies.length === 0 && seedMovieIds.length > 0) {
              try {
                const similarBatches = await Promise.all(
                  seedMovieIds.slice(0, 4).map((tmdbId) => getSimilarMovies(tmdbId, 1).catch(() => ({ results: [] as Movie[] })))
                );
                const merged: Movie[] = [];
                const seen = new Set<number>();
                for (const batch of similarBatches) {
                  for (const item of batch.results ?? []) {
                    if (seen.has(item.id)) continue;
                    if (watchedIds.has(item.id)) continue;
                    if (!hasListData(item)) continue;
                    seen.add(item.id);
                    merged.push(item);
                  }
                }
                nextForYouMovies = merged.slice(0, 20);
              } catch {
              }
            }

            if (nextNewMoviesTitle === 'For You (ML)') {
              if (token !== refreshTokenRef.current) return;
              setNewMovies(nextNewMovies);
              setNewMoviesTitle(nextNewMoviesTitle);
              setNewMoviesSubtitle(nextNewMoviesSubtitle);
            }

            await Promise.all(
              watchedRows
                .slice(0, 12)
                .filter((row) => candidateMovieIds.has(row.tmdbId))
                .map(async (row) => {
                try {
                  const detail = await getMovieById(row.tmdbId);
                  const genres = (detail as any)?.genres as { id: number }[] | undefined;
                  genres?.forEach((g) => {
                    if (!g?.id) return;
                    genreCount[g.id] = (genreCount[g.id] ?? 0) + 1;
                  });
                } catch {
                }
              })
            );

            const topGenreIds = Object.entries(genreCount)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 2)
              .map(([id]) => Number(id));

            if (topGenreIds.length > 0 && nextNewMoviesTitle !== 'For You (ML)') {
              const genrePage = randomizePages ? randomStartPage(3) : 1;
              const genreBatches = await Promise.all(
                topGenreIds.map((id) => getMoviesByGenre(id, genrePage))
              );
              const merged: Movie[] = [];
              const seen = new Set<number>();
              genreBatches.forEach((batch) => {
                (batch.results ?? []).forEach((movie) => {
                  if (seen.has(movie.id)) return;
                  if (watchedIds.has(movie.id)) return;
                  if (!hasListData(movie)) return;
                  seen.add(movie.id);
                  merged.push(movie);
                });
              });
              if (merged.length > 0) {
                nextNewMovies = merged;
                nextNewMoviesTitle = 'For You';
              }
            }
          } catch {
          }
        }

        if (token !== refreshTokenRef.current) return;
        setForYouMovies(nextForYouMovies);
        setTodayDramaMovies(nextTodayDramaMovies);
        setTrackedEpisodes(nextTrackedEpisodes);
        setNewMovies(nextNewMovies);
        setNewMoviesTitle(nextNewMoviesTitle);
        setNewMoviesSubtitle(nextNewMoviesSubtitle);

        if (featuredDb && (featuredDb.title || featuredDb.backdrop_path)) {
          if (!featuredDb.tmdb_id || !watchedIdSet.has(featuredDb.tmdb_id)) {
            setFeatured({
              tmdb_id: featuredDb.tmdb_id,
              title: featuredDb.title,
              overview: featuredDb.overview,
              backdrop_path: featuredDb.backdrop_path,
              poster_path: featuredDb.poster_path,
            });
          } else if (popularMovies.length > 0) {
            setFeatured(mapMovieToFeatured(popularMovies[0]));
          } else {
            setFeatured(null);
          }
        } else if (popularMovies.length > 0) {
          setFeatured(mapMovieToFeatured(popularMovies[0]));
        } else {
          setFeatured(null);
        }

        homeSnapshot = {
          userId: user?.id ?? null,
          featured:
            featuredDb && (featuredDb.title || featuredDb.backdrop_path)
              ? (!featuredDb.tmdb_id || !watchedIdSet.has(featuredDb.tmdb_id)
                  ? {
                      tmdb_id: featuredDb.tmdb_id,
                      title: featuredDb.title,
                      overview: featuredDb.overview,
                      backdrop_path: featuredDb.backdrop_path,
                      poster_path: featuredDb.poster_path,
                    }
                  : popularMovies.length > 0
                    ? mapMovieToFeatured(popularMovies[0])
                    : null)
              : popularMovies.length > 0
                ? mapMovieToFeatured(popularMovies[0])
                : null,
          popular: popularMovies,
          newMovies: nextNewMovies,
          newMoviesTitle: nextNewMoviesTitle,
          newMoviesSubtitle: nextNewMoviesSubtitle,
          forYouMovies: nextForYouMovies,
          todayDramaMovies: nextTodayDramaMovies,
          trackedEpisodes: nextTrackedEpisodes,
          newEpisodes: cleanOnTheAir,
          watchedIds: Array.from(watchedIdSet),
          popularPage: popularStartPage,
          popularTotalPages: popularRes.total_pages ?? 1,
          newMoviesPage: newMoviesStartPage,
          newMoviesTotalPages: newMovieRes.total_pages ?? 1,
          newEpisodesPage: newEpisodesStartPage,
          newEpisodesTotalPages: newEpisodeRes.total_pages ?? 1,
        };
      } catch (err) {
        if (token === refreshTokenRef.current) setError((err as Error).message);
      } finally {
        if (!silent && token === refreshTokenRef.current) setLoading(false);
      }
    },
    [user]
  );

  const watchedDepsKey = useMemo(() => watchedIds.join(','), [watchedIds]);

  useEffect(() => {
    if (homeSnapshot && homeSnapshot.userId === (user?.id ?? null)) {
      setFeatured(homeSnapshot.featured);
      setPopular(homeSnapshot.popular);
      setNewMovies(homeSnapshot.newMovies);
      setNewMoviesTitle(homeSnapshot.newMoviesTitle);
      setNewMoviesSubtitle(homeSnapshot.newMoviesSubtitle);
      setForYouMovies(homeSnapshot.forYouMovies);
      setTodayDramaMovies(homeSnapshot.todayDramaMovies);
      setTrackedEpisodes(homeSnapshot.trackedEpisodes);
      setNewEpisodes(homeSnapshot.newEpisodes);
      setWatchedIds(homeSnapshot.watchedIds);
      setPopularPage(homeSnapshot.popularPage);
      setPopularTotalPages(homeSnapshot.popularTotalPages);
      setNewMoviesPage(homeSnapshot.newMoviesPage);
      setNewMoviesTotalPages(homeSnapshot.newMoviesTotalPages);
      setNewEpisodesPage(homeSnapshot.newEpisodesPage);
      setNewEpisodesTotalPages(homeSnapshot.newEpisodesTotalPages);
      setLoading(false);
      firstLoadDoneRef.current = true;
      return;
    }
    void loadHome({ randomizePages: true, silent: false }).finally(() => {
      firstLoadDoneRef.current = true;
    });
  }, [loadHome, user?.id]);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!user?.id) {
        if (active) setSearchClickedHistory([]);
        return;
      }
      try {
        const rows = await getSearchClickHistory(user.id, 12);
        if (!active) return;
        const mapped: SearchMediaResult[] = rows.map((row) => ({
          id: row.tmdbId,
          media_type: row.mediaType,
          title: row.mediaType === 'movie' ? row.title : undefined,
          name: row.mediaType === 'tv' ? row.title : undefined,
          overview: '',
          poster_path: row.posterPath ?? null,
          backdrop_path: null,
          vote_average: row.voteAverage ?? 0,
        }));
        setSearchClickedHistory(mapped);
      } catch {
        if (active) setSearchClickedHistory([]);
      }
    })();
    return () => {
      active = false;
    };
  }, [user?.id]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;

      if (prev === 'active' && (nextState === 'inactive' || nextState === 'background')) {
        shouldRefreshOnActiveRef.current = true;
        return;
      }
      if (nextState === 'active' && shouldRefreshOnActiveRef.current && firstLoadDoneRef.current) {
        shouldRefreshOnActiveRef.current = false;
        void loadHome({ randomizePages: true, silent: true });
      }
    });
    return () => sub.remove();
  }, [loadHome]);

  useEffect(() => {
    const t = setTimeout(() => setMinDelayDone(true), 300);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadCinemaEvent = async () => {
      try {
        const next = await getCinemaEventByStatusNow();
        if (!mounted) return;
        setCinemaEvent(next);
      } catch {
      }
    };
    void loadCinemaEvent();
    const poll = setInterval(() => {
      void loadCinemaEvent();
    }, 5000);
    return () => {
      mounted = false;
      clearInterval(poll);
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setCinemaNowIso(new Date().toISOString()), 1000);
    return () => clearInterval(t);
  }, []);

  const scrollY = useRef(new Animated.Value(0)).current;
  const categoriesX = useRef(new Animated.Value(-320)).current;
  const searchX = useRef(new Animated.Value(420)).current;
  const overlayOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(categoriesX, {
      toValue: categoriesOpen ? 0 : -320,
      duration: 420,
      easing: categoriesOpen ? Easing.out(Easing.elastic(1)) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [categoriesOpen, categoriesX]);

  useEffect(() => {
    Animated.timing(searchX, {
      toValue: searchOpen ? 0 : 420,
      duration: 360,
      easing: searchOpen ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [searchOpen, searchX]);

  useEffect(() => {
    const visible = categoriesOpen || searchOpen;
    Animated.timing(overlayOpacity, {
      toValue: visible ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [categoriesOpen, searchOpen, overlayOpacity]);

  useEffect(() => {
    if (!searchOpen) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const q = searchQuery.trim();
      setSearchLoading(true);
      try {
        const res = q ? await searchMulti(q, 1) : await getPopularMovies(1);
        if (!cancelled) {
          const watchedIdSet = new Set(watchedIds);
          const cleaned = q
            ? (res.results ?? []).filter(
                (item) =>
                  (item as SearchMediaResult).media_type === 'movie' ||
                  ((item as SearchMediaResult).media_type === 'tv' && hasListData(item))
              )
            : (res.results ?? []).filter(hasListData);
          const filtered = excludeWatched(cleaned.filter(hasListData), watchedIdSet);
          setSearchResults(rankByTaste(filtered as SearchResultItem[], searchTasteSignals));
        }
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [searchOpen, searchQuery, watchedIds, searchTasteSignals]);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!user?.id) {
        if (active) {
          setSearchTasteSignals({
            watchlistIds: [],
            favoriteIds: [],
            watchedIds: [],
            ratingsById: {},
            mlMovieIds: [],
            mlTvIds: [],
          });
        }
        return;
      }
      try {
        const [watchlistRows, favoriteRows, watchedRows, ratingRows, mlMovie, mlTv] = await Promise.all([
          getUserWatchlist(user.id),
          getUserFavorites(user.id),
          getUserWatched(user.id),
          getUserRatings(user.id),
          hasMlApi()
            ? getMlRecommendations(user.id, { mediaType: 'movie', topN: 120 }).catch(() => [])
            : Promise.resolve([]),
          hasMlApi()
            ? getMlRecommendations(user.id, { mediaType: 'tv', topN: 120 }).catch(() => [])
            : Promise.resolve([]),
        ]);
        if (!active) return;
        const ratingsById: Record<number, number> = {};
        for (const row of ratingRows) {
          if (typeof row.rating === 'number') ratingsById[row.tmdbId] = row.rating;
        }
        setSearchTasteSignals({
          watchlistIds: watchlistRows.map((r) => r.tmdbId),
          favoriteIds: favoriteRows.map((r) => r.tmdbId),
          watchedIds: watchedRows.map((r) => r.tmdbId),
          ratingsById,
          mlMovieIds: mlMovie.map((x) => x.tmdb_id),
          mlTvIds: mlTv.map((x) => x.tmdb_id),
        });
      } catch {
      }
    })();
    return () => {
      active = false;
    };
  }, [user?.id, watchedDepsKey]);

  const searchPopularItems = useMemo(
    () => rankByTaste(popular as SearchResultItem[], searchTasteSignals),
    [popular, searchTasteSignals]
  );
  const searchLatestItems = useMemo(
    () => rankByTaste(newMovies as SearchResultItem[], searchTasteSignals),
    [newMovies, searchTasteSignals]
  );
  const cinemaPhase = useMemo<'upcoming' | 'live' | 'ended' | 'none'>(() => {
    if (!cinemaEvent) return 'none';
    const now = Date.parse(cinemaNowIso);
    const start = Date.parse(cinemaEvent.start_at);
    const end = Date.parse(cinemaEvent.end_at);
    if (now < start) return 'upcoming';
    if (now <= end) return 'live';
    return 'ended';
  }, [cinemaEvent, cinemaNowIso]);

  useEffect(() => {
    const prev = prevCinemaPhaseRef.current;
    if (cinemaNotifyArmed && prev === 'upcoming' && cinemaPhase === 'live' && cinemaEvent?.title) {
      Alert.alert('Cinema is live', `${cinemaEvent.title} just started.`, [
        { text: 'Later', style: 'cancel' },
        {
          text: 'Go to live',
          onPress: () => router.push('/cinema'),
        },
      ]);
      setCinemaNotifyArmed(false);
    }
    prevCinemaPhaseRef.current = cinemaPhase;
  }, [cinemaEvent?.title, cinemaNotifyArmed, cinemaPhase]);

  const heroSlides = useMemo<HeroSlide[]>(() => {
    const items = [featured, ...popular.slice(0, 8)]
      .filter((item): item is FeaturedDisplay | Movie => !!item)
      .map((item) => {
        const tmdbId = Number((item as any).tmdb_id ?? (item as any).id ?? 0) || null;
        const title = String((item as any).title ?? '').trim();
        const image =
          backdropUrl((item as any).backdrop_path ?? null, 'w1280') ||
          posterUrl((item as any).poster_path ?? null, 'w500') ||
          null;
        return {
          id: String(tmdbId ?? title),
          tmdbId,
          title: title || 'Movie',
          subtitle: 'Recommended for you',
          image,
        };
      });

    const dedup = new Map<string, HeroSlide>();
    for (const it of items) {
      if (!it.image) continue;
      if (!dedup.has(it.id)) dedup.set(it.id, it);
    }
    return Array.from(dedup.values()).slice(0, 8);
  }, [featured, popular]);

  useEffect(() => {
    setHeroIndex(0);
    requestAnimationFrame(() => {
      heroScrollRef.current?.scrollTo({ x: 0, y: 0, animated: false });
    });
  }, [heroSlides.length, cinemaPhase]);

  const heroPrimarySlide = heroSlides[heroIndex] ?? heroSlides[0] ?? null;
  const heroTopImage =
    cinemaPhase === 'none'
      ? heroPrimarySlide?.image || null
      : cinemaEvent?.poster_url?.trim() || backdropUrl(featured?.backdrop_path, 'w1280');
  const heroTopTitle = cinemaPhase === 'none' ? '' : cinemaEvent?.title || featured?.title || '';
  const heroSubtitle =
    cinemaPhase === 'none'
      ? ''
      : cinemaPhase === 'upcoming'
        ? 'Starts soon on Cinema'
        : cinemaPhase === 'live'
          ? 'Streaming now'
          : cinemaPhase === 'ended'
            ? 'Ended'
            : '';

  useEffect(() => {
    let active = true;
    (async () => {
      if (cinemaPhase !== 'none') {
        if (active) setHeroStats({ favorites: 0, watched: 0, rated: 0 });
        return;
      }
      const tmdbId = Number(heroPrimarySlide?.tmdbId ?? 0);
      if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
        if (active) setHeroStats({ favorites: 0, watched: 0, rated: 0 });
        return;
      }
      try {
        const counts = await getMovieEngagementCounts(tmdbId, 'movie');
        if (!active) return;
        setHeroStats(counts);
      } catch {
        if (active) setHeroStats({ favorites: 0, watched: 0, rated: 0 });
      }
    })();
    return () => {
      active = false;
    };
  }, [cinemaPhase, heroPrimarySlide?.tmdbId]);

  const formatHeroCount = useCallback((n: number) => {
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n < 1000) return String(Math.trunc(n));
    const value = n / 1000;
    const fixed = value >= 10 ? value.toFixed(0) : value.toFixed(1);
    return `${fixed}k`;
  }, []);
  const isWeb = Platform.OS === 'web';
  const heroCardGap = 12;
  const heroInnerPadding = 14;
  const heroItemWidth = heroSlideWidth > 0 ? Math.max(240, heroSlideWidth - 56) : 300;
  const heroSnapInterval = heroItemWidth + heroCardGap;

  const dailyForYouMovies = useMemo(() => {
    if (forYouMovies.length > 0) return forYouMovies.slice(0, 5);
    return newMovies.slice(0, 5);
  }, [forYouMovies, newMovies]);

  const hasData = popular.length > 0 || newMovies.length > 0 || newEpisodes.length > 0;
  if ((loading && !hasData) || !minDelayDone) {
    return (
      <View style={[styles.loaderScreen, { backgroundColor: theme.background }]}>
        <View style={styles.loaderRing} />
        <ActivityIndicator size="large" color="#C1121F" style={styles.loaderSpinner} />
      </View>
    );
  }

  const blurActiveElement = () => {
    if (typeof document === 'undefined') return;
    const el = document.activeElement as HTMLElement | null;
    if (el && typeof el.blur === 'function') el.blur();
  };

  const closePanels = () => {
    blurActiveElement();
    setCategoriesOpen(false);
    setSearchOpen(false);
  };

  const loadMorePopular = async () => {
    if (loadingMore || popularPage >= popularTotalPages) return;
    setLoadingMore('popular');
    try {
      const nextPage = popularPage + 1;
      const res = await getPopularMovies(nextPage);
      const watchedIdSet = new Set(watchedIds);
      setPopular((prev) => [...prev, ...excludeWatched((res.results ?? []).filter(hasListData), watchedIdSet)]);
      setPopularPage(nextPage);
      setPopularTotalPages(res.total_pages ?? popularTotalPages);
    } finally {
      setLoadingMore(null);
    }
  };

  const loadMoreNewMovies = async () => {
    if (loadingMore || newMoviesPage >= newMoviesTotalPages) return;
    setLoadingMore('newMovies');
    try {
      const nextPage = newMoviesPage + 1;
      const res = await getNewMovies(nextPage);
      const watchedIdSet = new Set(watchedIds);
      setNewMovies((prev) => [...prev, ...excludeWatched((res.results ?? []).filter(hasListData), watchedIdSet)]);
      setNewMoviesPage(nextPage);
      setNewMoviesTotalPages(res.total_pages ?? newMoviesTotalPages);
    } finally {
      setLoadingMore(null);
    }
  };

  const loadMoreNewEpisodes = async () => {
    if (loadingMore || newEpisodesPage >= newEpisodesTotalPages) return;
    setLoadingMore('newEpisodes');
    try {
      const nextPage = newEpisodesPage + 1;
      const res = await getNewEpisodes(nextPage);
      const watchedIdSet = new Set(watchedIds);
      setNewEpisodes((prev) => [...prev, ...excludeWatched((res.results ?? []).filter(hasListData), watchedIdSet)]);
      setNewEpisodesPage(nextPage);
      setNewEpisodesTotalPages(res.total_pages ?? newEpisodesTotalPages);
    } finally {
      setLoadingMore(null);
    }
  };

  return (
    <Animated.View style={[styles.root, { backgroundColor: theme.background }]}>
      <Animated.ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        decelerationRate="fast"
        nestedScrollEnabled
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
          useNativeDriver: true,
        })}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Pressable onPress={() => setCategoriesOpen(true)} style={styles.headerIconBtn}>
              <Ionicons name="menu" size={18} color="#fff" />
            </Pressable>
          </View>
          <Pressable onPress={() => setSearchOpen(true)} style={styles.headerIconBtn}>
            <Ionicons name="search" size={18} color="#fff" />
          </Pressable>
        </View>

        <View style={styles.heroWrap}>
          <View style={styles.heroGlow} pointerEvents="none">
            {heroTopImage ? (
              <Image source={{ uri: heroTopImage }} style={styles.heroGlowImage} blurRadius={64} />
            ) : (
              <View style={[styles.heroGlowImage, { backgroundColor: theme.backgroundSelected }]} />
            )}
            <LinearGradient
              colors={['rgba(0,0,0,0)', theme.background]}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={styles.heroGlowFade}
            />
          </View>
          <View
            style={[styles.heroCard, cinemaPhase === 'none' && styles.heroCardCarousel]}
            onLayout={(e) => {
              const next = Math.round(e.nativeEvent.layout.width);
              if (next > 0 && next !== heroSlideWidth) setHeroSlideWidth(next);
            }}>
            {cinemaPhase === 'none' ? (
              <ScrollView
                ref={heroScrollRef}
                horizontal
                pagingEnabled={isWeb}
                snapToInterval={isWeb ? undefined : heroSnapInterval}
                decelerationRate={isWeb ? 'normal' : 'fast'}
                disableIntervalMomentum={!isWeb}
                showsHorizontalScrollIndicator={false}
                nestedScrollEnabled
                onMomentumScrollEnd={(e) => {
                  const step = isWeb
                    ? Math.max(1, heroSlideWidth || e.nativeEvent.layoutMeasurement.width || 1)
                    : heroSnapInterval;
                  const next = Math.round(e.nativeEvent.contentOffset.x / step);
                  setHeroIndex(Math.max(0, Math.min(heroSlides.length - 1, next)));
                }}
                contentContainerStyle={[
                  styles.heroSlideTrackContent,
                  isWeb
                    ? styles.heroSlideTrackContentWeb
                    : { paddingHorizontal: heroInnerPadding, gap: heroCardGap },
                ]}
                style={styles.heroSlideTrack}>
                {heroSlides.length > 0 ? (
                  heroSlides.map((slide) => (
                    <Pressable
                      key={slide.id}
                      style={[
                        styles.heroSlidePage,
                        isWeb && styles.heroSlidePageWeb,
                        { width: isWeb ? Math.max(1, heroSlideWidth || 1) : heroItemWidth },
                      ]}
                      onPress={() => {
                        const id = Number(slide.tmdbId ?? 0);
                        if (!Number.isFinite(id) || id <= 0) return;
                        router.push({ pathname: '/movie/[id]', params: { id: String(id), type: 'movie' } });
                      }}>
                      {slide.image ? (
                        <Image
                          source={{ uri: slide.image }}
                          style={styles.heroSlideImage}
                          contentFit="cover"
                          contentPosition="center"
                        />
                      ) : (
                        <View style={[styles.heroSlideImage, { backgroundColor: theme.backgroundSelected }]} />
                      )}
                    </Pressable>
                  ))
                ) : (
                  <View
                    style={[
                      styles.heroSlidePage,
                      isWeb && styles.heroSlidePageWeb,
                      { width: isWeb ? Math.max(1, heroSlideWidth || 1) : heroItemWidth },
                    ]}>
                    <View style={[styles.heroSlideImage, { backgroundColor: theme.backgroundSelected }]} />
                  </View>
                )}
              </ScrollView>
            ) : heroTopImage ? (
              <Image
                source={{ uri: heroTopImage }}
                style={styles.heroImage}
                contentFit="cover"
                contentPosition="center"
              />
            ) : (
              <View style={[styles.heroImage, { backgroundColor: theme.backgroundSelected }]} />
            )}
            {(heroTopTitle || cinemaPhase !== 'none' || (cinemaPhase === 'none' && !!heroPrimarySlide)) && (
              <View style={styles.heroOverlay}>
                <GlassView
                  intensity={38}
                  tint="dark"
                  style={
                    cinemaPhase === 'none'
                      ? styles.heroOverlayGlassCentered
                      : styles.heroOverlayGlass
                  }>
                  {heroTopTitle ? (
                    <Text style={styles.heroTitle} numberOfLines={1}>
                      {heroTopTitle}
                    </Text>
                  ) : null}
                  {heroSubtitle ? (
                    <Text style={styles.heroOverview} numberOfLines={1}>
                      {heroSubtitle}
                    </Text>
                  ) : null}
                  {cinemaPhase === 'none' && heroPrimarySlide ? (
                    <View style={styles.heroStatsGlass}>
                    <View style={styles.heroStatsRow}>
                      <View style={styles.heroStat}>
                        <Ionicons name="heart-outline" size={18} color="#fff" />
                        <Text style={styles.heroStatText}>{formatHeroCount(heroStats.favorites)}</Text>
                      </View>
                      <View style={styles.heroStat}>
                        <Ionicons name="eye-outline" size={18} color="#fff" />
                        <Text style={styles.heroStatText}>{formatHeroCount(heroStats.watched)}</Text>
                      </View>
                      <View style={styles.heroStat}>
                        <Ionicons name="star-outline" size={18} color="#fff" />
                        <Text style={styles.heroStatText}>{formatHeroCount(heroStats.rated)}</Text>
                      </View>
                    </View>
                    </View>
                  ) : null}
                  {cinemaPhase === 'upcoming' ? (
                    <Pressable
                      style={[styles.cinemaCta, cinemaNotifyArmed && styles.cinemaCtaArmed]}
                      onPress={() => {
                        setCinemaNotifyArmed(true);
                        Alert.alert('Notifications enabled', 'You will be alerted when the live stream starts.');
                      }}>
                      <Text style={styles.cinemaCtaText}>Notify me</Text>
                    </Pressable>
                  ) : null}
                  {cinemaPhase === 'live' ? (
                    <Pressable style={styles.cinemaCta} onPress={() => router.push('/cinema')}>
                      <Text style={styles.cinemaCtaText}>Go to live</Text>
                    </Pressable>
                  ) : null}
                  {cinemaPhase === 'ended' ? <Text style={styles.cinemaEndedText}>Ended</Text> : null}
                </GlassView>
              </View>
            )}
            {cinemaPhase === 'none' && heroSlides.length > 1 ? (
              <View style={styles.heroDotsRow}>
                {heroSlides.map((slide, idx) => (
                  <View key={slide.id} style={[styles.heroDot, idx === heroIndex && styles.heroDotActive]} />
                ))}
              </View>
            ) : null}
          </View>
        </View>

        {error ? (
          <Text style={[styles.errorText, { color: theme.text }]}>{error}</Text>
        ) : null}

        <Section
          title="Popular Movies"
          items={popular}
          onLoadMore={loadMorePopular}
          hasMore={popularPage < popularTotalPages}
          loadingMore={loadingMore === 'popular'}
        />
        <Section
          title="New Episodes"
          items={newEpisodes}
          isTv
          onLoadMore={loadMoreNewEpisodes}
          hasMore={newEpisodesPage < newEpisodesTotalPages}
          loadingMore={loadingMore === 'newEpisodes'}
        />
        {dailyForYouMovies.length > 0 ? (
          <Section
            title="For You"
            subtitle={newMoviesSubtitle ?? "Based on your favorites and watch history"}
            items={dailyForYouMovies}
          />
        ) : null}
        {trackedEpisodes.length > 0 ? (
          <Section
            title="From your shows"
            subtitle="New episodes from titles you interact with"
            items={trackedEpisodes}
            isTv
          />
        ) : null}
        {todayDramaMovies.length > 0 ? (
          <Section
            title="Today Drama"
            subtitle="Daily drama picks"
            items={todayDramaMovies}
          />
        ) : null}
        <Section
          title={newMoviesTitle}
          subtitle={forYouMovies.length > 0 ? undefined : newMoviesSubtitle ?? undefined}
          items={newMovies}
          onLoadMore={loadMoreNewMovies}
          hasMore={newMoviesPage < newMoviesTotalPages}
          loadingMore={loadingMore === 'newMovies'}
        />
      </Animated.ScrollView>

      <Animated.View
        style={[
          styles.topFloatingBar,
          {
            opacity: scrollY.interpolate({
              inputRange: [0, 80, 140],
              outputRange: [0, 0.6, 1],
              extrapolate: 'clamp',
            }),
          },
        ]}>
        <Pressable onPress={() => setCategoriesOpen(true)} style={styles.headerIconBtn}>
          <Ionicons name="menu" size={18} color="#fff" />
        </Pressable>
        <Pressable onPress={() => setSearchOpen(true)} style={styles.headerIconBtn}>
          <Ionicons name="search" size={18} color="#fff" />
        </Pressable>
      </Animated.View>

      {(categoriesOpen || searchOpen) && (
        <Animated.View style={[styles.scrim, { opacity: overlayOpacity }]}>
          <Pressable style={styles.scrim} onPress={closePanels} />
        </Animated.View>
      )}

      <Animated.View style={[styles.categoryPanel, { transform: [{ translateX: categoriesX }] }]}>
        <Text style={styles.panelTitle}>Categories</Text>
        {GENRES.map((g) => (
          <Pressable
            key={g.id}
            style={styles.panelItem}
            onPress={() => {
              closePanels();
              router.push({ pathname: '/category', params: { genreId: String(g.id), genreName: g.name } });
            }}>
            <Text style={styles.panelItemText}>{g.name}</Text>
          </Pressable>
        ))}
      </Animated.View>

      <Animated.View style={[styles.searchPanel, { transform: [{ translateX: searchX }] }]}>
        <View style={styles.searchHeader}>
          <Text style={styles.panelTitle}>Search</Text>
          <Pressable onPress={closePanels} style={styles.headerIconBtn}>
            <Ionicons name="close" size={18} color="#fff" />
          </Pressable>
        </View>
        <TextInput
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search movies or series..."
          placeholderTextColor="rgba(255,255,255,0.6)"
          style={styles.searchInput}
        />
        {searchLoading ? (
          <View style={styles.searchLoading}>
            <ActivityIndicator color="#fff" />
          </View>
        ) : (
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.searchResults}>
            {searchQuery.trim() ? (
              <SearchSection
                title="Results"
                items={searchResults}
                onItemPress={rememberClickedSearchItem}
              />
            ) : (
              <>
                <SearchSection
                  title="Popular"
                  items={searchPopularItems}
                  onItemPress={rememberClickedSearchItem}
                />
                <SearchSection
                  title="Latest"
                  items={searchLatestItems}
                  onItemPress={rememberClickedSearchItem}
                />
                <View style={styles.searchSection}>
                  <Text style={styles.searchSectionTitle}>History</Text>
                  {searchClickedHistory.length === 0 ? (
                    <Text style={styles.historyEmpty}>No clicked titles yet</Text>
                  ) : (
                    <SearchSection
                      title=""
                      items={searchClickedHistory}
                      onItemPress={rememberClickedSearchItem}
                    />
                  )}
                </View>
              </>
            )}
          </ScrollView>
        )}
      </Animated.View>

    </Animated.View>
  );
}

function Section({
  title,
  subtitle,
  items,
  isTv,
  onLoadMore,
  hasMore,
  loadingMore,
}: {
  title: string;
  subtitle?: string;
  items: Movie[] | TvShow[];
  isTv?: boolean;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
}) {
  const theme = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const [forYouIndex, setForYouIndex] = useState(0);
  const safeItems = items.filter((item) => hasListData(item));
  const isForYou = false;
  const forYouCardWidth = Math.max(260, screenWidth - Spacing.four * 2);

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={[styles.sectionTitle, { color: theme.text }]}>{title}</Text>
        {subtitle ? (
          <Text style={styles.sectionSubtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <ScrollView
        horizontal
        pagingEnabled={isForYou}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={isForYou ? styles.forYouRowScroll : styles.rowScroll}
        scrollEventThrottle={16}
        decelerationRate="fast"
        nestedScrollEnabled
        onMomentumScrollEnd={
          isForYou
            ? (e) => {
                const w = e.nativeEvent.layoutMeasurement.width || 1;
                const next = Math.round(e.nativeEvent.contentOffset.x / w);
                setForYouIndex(Math.max(0, Math.min(safeItems.length - 1, next)));
              }
            : undefined
        }>
        {safeItems.map((item, idx) => (
          <Pressable
            key={`${item.id}-${idx}`}
            style={[styles.card, isForYou && { width: forYouCardWidth }, isForYou && styles.forYouCard]}
            onPress={() =>
              router.push({
                pathname: '/movie/[id]',
                params: { id: String(item.id), type: isTv ? 'tv' : 'movie' },
              })
            }>
            <Image
              source={{ uri: posterUrl(item.poster_path, 'w500') ?? undefined }}
              style={[styles.cardImage, isForYou && styles.forYouCardImage]}
            />
            <GlassView intensity={28} tint="dark" style={isForYou ? [styles.cardGlass, styles.forYouCardGlass] : styles.cardGlass}>
              <Text style={[styles.cardTitle, isForYou && styles.forYouCardTitle]} numberOfLines={1}>
                {'title' in item ? item.title : item.name}
              </Text>
              <Text style={[styles.cardMeta, isForYou && styles.forYouCardMeta]} numberOfLines={1}>
                {isTv ? 'TV' : 'Movie'} • {item.vote_average.toFixed(1)}
              </Text>
            </GlassView>
          </Pressable>
        ))}
        {!isForYou && hasMore ? (
          <Pressable onPress={onLoadMore} style={styles.loadMoreCard}>
            {loadingMore ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.loadMoreText}>Load more</Text>
            )}
          </Pressable>
        ) : null}
      </ScrollView>
      {isForYou && safeItems.length > 1 ? (
        <View style={styles.forYouDotsRow}>
          {safeItems.map((item, idx) => (
            <View key={`${item.id}-dot`} style={[styles.forYouDot, idx === forYouIndex && styles.forYouDotActive]} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function SearchSection({
  title,
  items,
  onItemPress,
}: {
  title: string;
  items: SearchResultItem[];
  onItemPress?: (item: SearchResultItem) => void;
}) {
  const safeItems = items.filter((item) => !!item.poster_path);
  if (safeItems.length === 0) return null;
  return (
    <View style={styles.searchSection}>
      {title ? <Text style={styles.searchSectionTitle}>{title}</Text> : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.searchRow}>
        {safeItems.map((item, idx) => (
          <Pressable
            key={`${item.id}-${idx}`}
            style={styles.searchCard}
            onPress={() =>
              {
                onItemPress?.(item);
                router.push({
                  pathname: '/movie/[id]',
                  params: { id: String(item.id), type: isTvItem(item) ? 'tv' : 'movie' },
                });
              }
            }>
            <Image source={{ uri: posterUrl(item.poster_path, 'w342') ?? undefined }} style={styles.searchCardImage} />
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    overflow: 'hidden',
  },
  scrollContent: {
    paddingBottom: Spacing.six,
    width: '100%',
  },
  header: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerLeft: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  headerIconBtn: {
    width: 34,
    height: 34,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  heroWrap: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.four,
    position: 'relative',
    marginTop: -Spacing.two,
  },
  heroGlow: {
    position: 'absolute',
    left: Spacing.four - 24,
    right: Spacing.four - 24,
    top: -64,
    height: 380,
    borderRadius: Spacing.three,
    overflow: 'hidden',
    opacity: 0.9,
    transform: [{ scale: 1.12 }],
  },
  heroGlowFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 140,
  },
  heroGlowImage: {
    width: '100%',
    height: '100%',
  },
  heroCard: {
    borderRadius: Spacing.three,
    overflow: 'hidden',
    minHeight: 250,
    backgroundColor: '#000000',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)',
  },
  heroCardCarousel: {
    minHeight: 336,
  },
  heroImage: {
    width: '100%',
    height: 336,
  },
  heroSlideTrack: {
    width: '100%',
    height: 336,
  },
  heroSlideTrackContent: {
    alignItems: 'center',
  },
  heroSlideTrackContentWeb: {
    alignItems: 'stretch',
    paddingHorizontal: 0,
    gap: 0,
  },
  heroSlidePage: {
    height: 312,
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: '#0c0c0c',
    marginTop: 12,
  },
  heroSlidePageWeb: {
    height: 336,
    borderRadius: 0,
    borderWidth: 0,
    marginTop: 0,
  },
  heroSlideImage: {
    width: '100%',
    height: '100%',
  },
  heroStatsGlass: {
    marginTop: 14,
    alignSelf: 'center',
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.28)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  heroStatsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  heroStat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  heroStatText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 15,
  },
  heroCarousel: {
    marginTop: 10,
  },
  heroCarouselContent: {
    gap: 12,
  },
  heroMiniCard: {
    height: 132,
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: '#0d0d0d',
  },
  heroMiniImage: {
    width: '100%',
    height: '100%',
  },
  heroMiniShade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 66,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  heroMiniTitle: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 10,
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 14,
  },
  heroDotsRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  heroDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  heroDotActive: {
    width: 18,
    backgroundColor: '#fff',
  },
  topFloatingBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    top: 8,
    height: 44,
    borderRadius: 18,
    backgroundColor: 'rgba(8,8,8,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    zIndex: 900,
  },
  categoryPanel: {
    position: 'absolute',
    top: 64,
    left: 12,
    width: 220,
    padding: 16,
    borderRadius: 22,
    backgroundColor: 'rgba(10,10,10,0.95)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    zIndex: 1000,
  },
  panelTitle: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 18,
    marginBottom: 12,
  },
  panelItem: {
    paddingVertical: 10,
  },
  panelItemText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 13,
  },
  searchPanel: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    paddingTop: 48,
    paddingHorizontal: 20,
    backgroundColor: 'rgba(0,0,0,0.92)',
    zIndex: 1000,
  },
  searchHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  searchInput: {
    height: 44,
    borderRadius: 14,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(255,255,255,0.08)',
    color: '#fff',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    marginBottom: 12,
  },
  searchResults: {
    paddingBottom: 80,
    gap: 12,
  },
  searchLoading: {
    paddingTop: 16,
  },
  searchSection: {
    marginBottom: Spacing.three,
  },
  searchSectionTitle: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 16,
    marginBottom: 8,
  },
  searchRow: {
    gap: Spacing.two,
  },
  searchCard: {
    width: 120,
    height: 170,
    borderRadius: 16,
    overflow: 'hidden',
  },
  searchCardImage: {
    width: '100%',
    height: '100%',
  },
  historyRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  historyChip: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  historyChipText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  historyEmpty: {
    color: 'rgba(255,255,255,0.6)',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  heroOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.two,
    paddingBottom: Spacing.two,
  },
  heroOverlayGlass: {
    borderRadius: 18,
    overflow: 'hidden',
    minHeight: 118,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    justifyContent: 'center',
    backgroundColor: 'rgba(6,8,12,0.42)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  heroOverlayGlassCentered: {
    borderRadius: 18,
    overflow: 'hidden',
    minHeight: 118,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    justifyContent: 'center',
    backgroundColor: 'rgba(6,8,12,0.42)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
  },
  heroTitle: {
    fontSize: 20,
    fontFamily: Fonts.serif,
    marginBottom: Spacing.one,
  },
  heroOverview: {
    fontFamily: Fonts.serif,
    fontSize: 12,
    color: 'rgba(255,255,255,0.85)',
  },
  cinemaCta: {
    marginTop: 10,
    alignSelf: 'flex-start',
    borderRadius: 999,
    backgroundColor: '#C1121F',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  cinemaCtaArmed: {
    backgroundColor: '#8F0D16',
  },
  cinemaCtaText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 11,
    letterSpacing: 0.5,
  },
  cinemaEndedText: {
    marginTop: 10,
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 11,
    opacity: 0.86,
  },
  loadingWrap: {
    paddingVertical: Spacing.four,
  },
  loaderScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loaderRing: {
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 2,
    borderColor: 'rgba(193,18,31,0.35)',
    position: 'absolute',
  },
  loaderSpinner: {
    transform: [{ scale: 1.2 }],
  },
  errorText: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
  },
  section: {
    marginTop: Spacing.four,
  },
  sectionHeader: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.two,
  },
  sectionTitle: {
    fontSize: 18,
    fontFamily: Fonts.serif,
  },
  sectionSubtitle: {
    marginTop: 4,
    color: 'rgba(255,255,255,0.72)',
    fontFamily: Fonts.mono,
    fontSize: 11,
    lineHeight: 16,
  },
  rowScroll: {
    paddingHorizontal: Spacing.four,
    gap: Spacing.two,
  },
  forYouRowScroll: {
    paddingHorizontal: Spacing.four,
  },
  card: {
    width: 150,
    height: 220,
    borderRadius: Spacing.three,
    overflow: 'hidden',
  },
  forYouCard: {
    height: 240,
    borderRadius: 18,
    marginRight: Spacing.two,
  },
  cardImage: {
    width: '100%',
    height: '100%',
  },
  forYouCardImage: {
    borderRadius: 18,
  },
  cardGlass: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  forYouCardGlass: {
    left: 10,
    right: 10,
    bottom: 10,
    paddingVertical: 10,
    borderRadius: 14,
  },
  cardTitle: {
    fontFamily: Fonts.serif,
    fontSize: 12,
    color: '#fff',
  },
  forYouCardTitle: {
    fontSize: 15,
  },
  cardMeta: {
    fontFamily: Fonts.mono,
    fontSize: 10,
    color: 'rgba(255,255,255,0.85)',
    marginTop: 2,
  },
  forYouCardMeta: {
    fontSize: 11,
    marginTop: 4,
  },
  forYouDotsRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  forYouDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  forYouDotActive: {
    width: 16,
    backgroundColor: '#fff',
  },
  loadMoreCard: {
    width: 150,
    height: 220,
    borderRadius: Spacing.three,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadMoreText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 12,
  },
});


