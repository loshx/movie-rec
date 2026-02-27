import { Image } from 'expo-image';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  Easing,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/contexts/AuthContext';
import { getCinemaEventByStatusNow, type CinemaEvent } from '@/db/cinema';
import { getFeaturedMovie } from '@/db/featured';
import {
  backdropUrl,
  getMoviesByGenre,
  getMovieById,
  getMovieRecommendations,
  getNewEpisodes,
  getNewMovies,
  getPopularMovies,
  getPopularTv,
  getSimilarMovies,
  getTvById,
  posterUrl,
  searchMulti,
  Movie,
  SearchMediaResult,
  TvShow,
} from '@/lib/tmdb';
import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import {
  getUserFavorites,
  getUserRatings,
  getUserWatchlist,
  getUserWatched,
} from '@/db/user-movies';
import { getMlRecommendations, hasMlApi, syncMlFollowingGraph } from '@/lib/ml-recommendations';
import { getFollowingProfiles } from '@/lib/social-backend';
import { getSearchClickHistory, upsertSearchClickHistory } from '@/db/search-click-history';
import { getCinemaEventMeta, type CinemaEventMeta } from '@/lib/cinema-event-meta';
import { useNotifications } from '@/contexts/NotificationsContext';

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
  forYouSubtitle: string | null;
  forYouMovies: Movie[];
  forYouShows: TvShow[];
  dailyGenreTitle: string;
  dailyGenreMovies: Movie[];
  newEpisodes: TvShow[];
  similarSeedTitle: string | null;
  similarMovies: Movie[];
  watchedIds: number[];
  popularPage: number;
  popularTotalPages: number;
  newMoviesPage: number;
  newMoviesTotalPages: number;
  newEpisodesPage: number;
  newEpisodesTotalPages: number;
  loadedAt: number;
};

let homeSnapshot: HomeSnapshot | null = null;

const GENRES = [
  { id: 27, name: 'Horror' },
  { id: 16, name: 'Anime' },
  { id: 35, name: 'Comedy' },
  { id: 28, name: 'Action' },
  { id: 18, name: 'Drama' },
  { id: 10749, name: 'Romance' },
  { id: 878, name: 'Sci-Fi' },
  { id: 53, name: 'Thriller' },
  { id: 14, name: 'Fantasy' },
  { id: 99, name: 'Documentary' },
];

const CINEMA_POLL_MS = 60 * 1000;
const CINEMA_CLOCK_MS = 1000;
const HOME_DETAIL_FETCH_LIMIT = 6;
const HOME_DETAIL_FETCH_CONCURRENCY = 3;
const ML_MIN_SIGNAL_INTERACTIONS = 10;
const FOR_YOU_MIN_VOTE_COUNT = 150;
const FOR_YOU_STRICT_MIN_VOTE_COUNT = 250;
const FOR_YOU_STRICT_MIN_VOTE_AVERAGE = 6.1;
const HOME_SNAPSHOT_FRESH_MS = 90 * 1000;
const HOME_ACTIVE_REFRESH_MIN_MS = 2 * 60 * 1000;
const ML_GRAPH_SYNC_MIN_MS = 10 * 60 * 1000;
const GENRE_ANIMATION = 16;
const GENRE_FAMILY_MOVIE = 10751;
const GENRE_KIDS_TV = 10762;

type ForYouTastePolicy = {
  allowAnimation: boolean;
  allowKids: boolean;
  allowTv: boolean;
  minVoteCount: number;
  minVoteAverage: number;
};

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
) {
  if (items.length === 0) return [] as R[];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const slots = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: slots }).map(async () => {
      while (true) {
        const current = nextIndex;
        if (current >= items.length) return;
        nextIndex += 1;
        results[current] = await worker(items[current], current);
      }
    })
  );
  return results;
}

function mapMovieToFeatured(movie: Movie): FeaturedDisplay {
  return {
    tmdb_id: movie.id,
    title: movie.title,
    overview: movie.overview,
    backdrop_path: movie.backdrop_path,
    poster_path: movie.poster_path,
  };
}

function hasListData(item: {
  poster_path: string | null;
  vote_average: number;
  overview: string;
  title?: string;
  name?: string;
}) {
  const title = String((item as any)?.title ?? (item as any)?.name ?? '').trim();
  return !!item.poster_path && title.length > 0;
}

function excludeWatched<T extends { id: number }>(items: T[], watchedIdSet: Set<number>) {
  return items.filter((item) => !watchedIdSet.has(item.id));
}

function getMediaGenreIds(item: Movie | TvShow | null | undefined): number[] {
  const genres = (item as any)?.genres;
  if (Array.isArray(genres) && genres.length > 0) {
    return genres
      .map((row: any) => Number(row?.id))
      .filter((id: number) => Number.isFinite(id) && id > 0);
  }
  const genreIds = (item as any)?.genre_ids;
  if (Array.isArray(genreIds) && genreIds.length > 0) {
    return genreIds
      .map((id: any) => Number(id))
      .filter((id: number) => Number.isFinite(id) && id > 0);
  }
  return [];
}

function buildSeedGenreWeights(seedMovies: (Movie | TvShow)[]) {
  const weights = new Map<number, number>();
  for (const movie of seedMovies) {
    const genreIds = getMediaGenreIds(movie);
    for (const genreId of genreIds) {
      weights.set(genreId, (weights.get(genreId) ?? 0) + 1);
    }
  }
  return weights;
}

function rankRecommendationCandidates(candidates: Movie[], seedGenreWeights: Map<number, number>) {
  return [...candidates]
    .map((movie, idx) => {
      const voteAverage = Number(movie.vote_average ?? 0);
      const voteCount = Number((movie as any).vote_count ?? 0);
      const popularity = Number((movie as any).popularity ?? 0);
      let score = voteAverage * 0.45 + Math.log1p(Math.max(0, voteCount)) * 0.42 + Math.log1p(Math.max(0, popularity)) * 0.13;
      const genreIds = getMediaGenreIds(movie);
      let overlapScore = 0;
      for (const genreId of genreIds) {
        overlapScore += seedGenreWeights.get(genreId) ?? 0;
      }
      if (overlapScore > 0) {
        score += 1.1 + Math.min(4, overlapScore * 0.4);
      } else if (seedGenreWeights.size > 0) {
        score -= 0.6;
      }
      if (voteCount > 0 && voteCount < FOR_YOU_MIN_VOTE_COUNT) {
        score -= 0.8;
      }
      return { movie, idx, score };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.idx - b.idx;
    })
    .map((row) => row.movie);
}

function rankTvRecommendationCandidates(candidates: TvShow[]) {
  return [...candidates]
    .map((show, idx) => {
      const voteAverage = Number(show.vote_average ?? 0);
      const voteCount = Number((show as any).vote_count ?? 0);
      const popularity = Number((show as any).popularity ?? 0);
      let score = voteAverage * 0.5 + Math.log1p(Math.max(0, voteCount)) * 0.35 + Math.log1p(Math.max(0, popularity)) * 0.15;
      if (voteCount > 0 && voteCount < FOR_YOU_MIN_VOTE_COUNT) {
        score -= 0.6;
      }
      return { show, idx, score };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.idx - b.idx;
    })
    .map((row) => row.show);
}

function filterForYouByPolicy<T extends Movie | TvShow>(items: T[], policy: ForYouTastePolicy): T[] {
  if (items.length === 0) return items;
  return items.filter((item) => {
    const genreIds = getMediaGenreIds(item);
    const voteCount = Number((item as any)?.vote_count ?? 0);
    const voteAverage = Number((item as any)?.vote_average ?? 0);

    if (!policy.allowAnimation && genreIds.includes(GENRE_ANIMATION)) return false;
    if (!policy.allowKids && (genreIds.includes(GENRE_FAMILY_MOVIE) || genreIds.includes(GENRE_KIDS_TV))) {
      return false;
    }
    if (voteCount > 0 && voteCount < policy.minVoteCount) return false;
    if (voteAverage > 0 && voteAverage < policy.minVoteAverage) return false;
    return true;
  });
}

function buildFallbackForYouMovies(options: {
  primary: Movie[];
  secondary: Movie[];
  tertiary?: Movie[];
  watchedIdSet: Set<number>;
  limit?: number;
}) {
  const { primary, secondary, tertiary = [], watchedIdSet, limit = 20 } = options;
  const dedup = new Map<number, Movie>();
  for (const item of [...primary, ...secondary, ...tertiary]) {
    if (!item || watchedIdSet.has(item.id) || !hasListData(item)) continue;
    if (!dedup.has(item.id)) dedup.set(item.id, item);
  }
  return rankRecommendationCandidates(Array.from(dedup.values()), new Map<number, number>()).slice(0, limit);
}

function buildFallbackForYouShows(options: {
  primary: TvShow[];
  secondary: TvShow[];
  watchedIdSet: Set<number>;
  limit?: number;
}) {
  const { primary, secondary, watchedIdSet, limit = 20 } = options;
  const dedup = new Map<number, TvShow>();
  for (const item of [...primary, ...secondary]) {
    if (!item || watchedIdSet.has(item.id) || !hasListData(item)) continue;
    if (!dedup.has(item.id)) dedup.set(item.id, item);
  }
  return rankTvRecommendationCandidates(Array.from(dedup.values())).slice(0, limit);
}

function shuffleItems<T>(items: T[]) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function blendById<T extends { id: number }>(options: {
  personalized: T[];
  fallback: T[];
  limit?: number;
  minPersonalized?: number;
}) {
  const { personalized, fallback, limit = 20, minPersonalized = 6 } = options;

  const uniquePersonalized = Array.from(new Map(personalized.map((x) => [x.id, x])).values());
  const personalizedIds = new Set(uniquePersonalized.map((x) => x.id));
  const uniqueFallback = Array.from(
    new Map(fallback.filter((x) => !personalizedIds.has(x.id)).map((x) => [x.id, x])).values()
  );

  const personalPool = shuffleItems(uniquePersonalized);
  const fallbackPool = shuffleItems(uniqueFallback);

  const out: T[] = [];
  const personalizedTarget = Math.min(
    personalPool.length,
    Math.max(minPersonalized, Math.ceil(limit * 0.55))
  );

  let p = 0;
  let f = 0;
  while (out.length < limit && (p < personalizedTarget || f < fallbackPool.length)) {
    if (p < personalizedTarget) out.push(personalPool[p++]);
    if (out.length >= limit) break;
    if (f < fallbackPool.length) out.push(fallbackPool[f++]);
  }
  while (out.length < limit && p < personalPool.length) out.push(personalPool[p++]);
  while (out.length < limit && f < fallbackPool.length) out.push(fallbackPool[f++]);
  return out.slice(0, limit);
}

function getLocalDaySeed(date = new Date()) {
  const localMidnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor(localMidnight.getTime() / 86400000);
}

function pickDailyItem<T>(items: T[], salt = 0): T | null {
  if (!items.length) return null;
  const daySeed = getLocalDaySeed();
  const idx = Math.abs(daySeed + salt) % items.length;
  return items[idx] ?? null;
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

type SectionRowItem =
  | {
      kind: 'media';
      key: string;
      item: Movie | TvShow;
    }
  | {
      kind: 'loadMore';
      key: string;
    };

function isTvItem(item: SearchResultItem) {
  if ('media_type' in item) return item.media_type === 'tv';
  return 'name' in item && !('title' in item);
}

function isPersonItem(item: SearchResultItem): item is SearchMediaResult {
  return 'media_type' in item && item.media_type === 'person';
}

function resolveSearchImagePath(item: SearchResultItem) {
  if (isPersonItem(item)) {
    return item.profile_path ?? item.poster_path ?? null;
  }
  return item.poster_path ?? null;
}

function resolvePersonRole(item: SearchResultItem): 'actor' | 'director' {
  if (!isPersonItem(item)) return 'actor';
  const department = String(item.known_for_department ?? '').trim().toLowerCase();
  return department === 'directing' ? 'director' : 'actor';
}

function toTitle(item: SearchResultItem) {
  if ('title' in item && item.title) return item.title;
  if ('name' in item && item.name) return item.name;
  return '';
}

function hasSearchCardData(item: SearchResultItem) {
  const title = toTitle(item).trim();
  return !!resolveSearchImagePath(item) && title.length > 0;
}

function rankByQueryMatch(items: SearchResultItem[], query: string): SearchResultItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return [...items]
    .map((item, idx) => {
      const title = toTitle(item).toLowerCase();
      const voteAverage = Number((item as any).vote_average ?? 0);
      const voteCount = Number((item as any).vote_count ?? 0);
      let textScore = 0;
      if (title === q) textScore = 3;
      else if (title.startsWith(q)) textScore = 2;
      else if (title.includes(q)) textScore = 1;
      const qualityScore = voteAverage * 0.12 + Math.log1p(Math.max(0, voteCount)) * 0.08;
      return { item, idx, score: textScore * 100 + qualityScore };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.idx - b.idx;
    })
    .map((x) => x.item);
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
  const {
    unreadCount,
    armCinemaLiveReminder,
    disarmCinemaLiveReminder,
    isCinemaLiveReminderArmed,
  } = useNotifications();
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const [featured, setFeatured] = useState<FeaturedDisplay | null>(null);
  const [popular, setPopular] = useState<Movie[]>([]);
  const [newMovies, setNewMovies] = useState<Movie[]>([]);
  const [forYouSubtitle, setForYouSubtitle] = useState<string | null>(null);
  const [forYouMovies, setForYouMovies] = useState<Movie[]>([]);
  const [forYouShows, setForYouShows] = useState<TvShow[]>([]);
  const [dailyGenreTitle, setDailyGenreTitle] = useState('Today Drama');
  const [dailyGenreMovies, setDailyGenreMovies] = useState<Movie[]>([]);
  const [newEpisodes, setNewEpisodes] = useState<TvShow[]>([]);
  const [similarSeedTitle, setSimilarSeedTitle] = useState<string | null>(null);
  const [similarMovies, setSimilarMovies] = useState<Movie[]>([]);
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
  const [cinemaMeta, setCinemaMeta] = useState<CinemaEventMeta | null>(null);
  const [heroIndex, setHeroIndex] = useState(0);
  const [heroSlideWidth, setHeroSlideWidth] = useState(0);
  const heroScrollRef = useRef<ScrollView | null>(null);
  const heroScrollX = useRef(new Animated.Value(0)).current;
  const refreshTokenRef = useRef(0);
  const lastHomeLoadAtRef = useRef(0);
  const lastMlGraphSyncAtRef = useRef(0);
  const firstLoadDoneRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const shouldRefreshOnActiveRef = useRef(false);
  const watchedIdsRef = useRef<number[]>([]);
  const searchTasteSignalsRef = useRef<SearchTasteSignals>(searchTasteSignals);

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

  useEffect(() => {
    watchedIdsRef.current = watchedIds;
  }, [watchedIds]);

  useEffect(() => {
    searchTasteSignalsRef.current = searchTasteSignals;
  }, [searchTasteSignals]);

  const loadHome = useCallback(
    async ({ randomizePages, silent }: { randomizePages: boolean; silent: boolean }) => {
      const token = ++refreshTokenRef.current;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const popularStartPage = randomizePages ? randomStartPage(5) : 1;
        const newMoviesStartPage = randomizePages ? randomStartPage(5) : 1;
        const newEpisodesStartPage = randomizePages ? randomStartPage(5) : 1;
        const dailyGenre = pickDailyItem(GENRES, 0) ?? GENRES[4];
        const dailyGenrePage = randomizePages ? (Math.abs(getLocalDaySeed() + dailyGenre.id) % 4) + 1 : 1;

        const [
          watchedRows,
          featuredDb,
          popularRes,
          popularTvRes,
          newMovieRes,
          newEpisodeRes,
          dailyGenreRes,
        ] = await Promise.all([
          user ? getUserWatched(user.id) : Promise.resolve([]),
          getFeaturedMovie(),
          getPopularMovies(popularStartPage),
          getPopularTv(popularStartPage),
          getNewMovies(newMoviesStartPage),
          getNewEpisodes(newEpisodesStartPage),
          getMoviesByGenre(dailyGenre.id, dailyGenrePage),
        ]);

        if (token !== refreshTokenRef.current) return;
        const watchedIdSet = new Set(watchedRows.map((row) => row.tmdbId));
        setWatchedIds(Array.from(watchedIdSet));

        const popularMovies = excludeWatched((popularRes.results ?? []).filter(hasListData), watchedIdSet);
        const popularTvShows = excludeWatched((popularTvRes.results ?? []).filter(hasListData), watchedIdSet);
        const freshNewMovies = excludeWatched((newMovieRes.results ?? []).filter(hasListData), watchedIdSet);
        const cleanOnTheAir = excludeWatched((newEpisodeRes.results ?? []).filter(hasListData), watchedIdSet);
        const nextDailyGenreMovies = excludeWatched((dailyGenreRes.results ?? []).filter(hasListData), watchedIdSet).slice(0, 20);
        const quickFallbackForYou = buildFallbackForYouMovies({
          primary: freshNewMovies,
          secondary: popularMovies,
          tertiary: nextDailyGenreMovies,
          watchedIdSet,
          limit: 20,
        }).slice(0, 20);

        const baseFeatured =
          featuredDb && (featuredDb.title || featuredDb.backdrop_path)
            ? !featuredDb.tmdb_id || !watchedIdSet.has(featuredDb.tmdb_id)
              ? {
                  tmdb_id: featuredDb.tmdb_id,
                  title: featuredDb.title,
                  overview: featuredDb.overview,
                  backdrop_path: featuredDb.backdrop_path,
                  poster_path: featuredDb.poster_path,
                }
              : popularMovies.length > 0
                ? mapMovieToFeatured(popularMovies[0])
                : null
            : popularMovies.length > 0
              ? mapMovieToFeatured(popularMovies[0])
              : null;

        // Show Home sections immediately; personalization keeps loading in background.
        setPopular(popularMovies);
        setNewMovies(freshNewMovies);
        setDailyGenreTitle(`Today ${dailyGenre.name}`);
        setDailyGenreMovies(nextDailyGenreMovies);
        setNewEpisodes(cleanOnTheAir);
        setPopularPage(popularStartPage);
        setPopularTotalPages(popularRes.total_pages ?? 1);
        setNewMoviesPage(newMoviesStartPage);
        setNewMoviesTotalPages(newMovieRes.total_pages ?? 1);
        setNewEpisodesPage(newEpisodesStartPage);
        setNewEpisodesTotalPages(newEpisodeRes.total_pages ?? 1);
        setFeatured(baseFeatured);
        setForYouMovies((prev) => (prev.length > 0 ? prev : quickFallbackForYou));
        if (!user) {
          setForYouShows([]);
          setForYouSubtitle('Popular and fresh picks for now');
        } else {
          setForYouSubtitle((prev) => prev ?? 'Building personalized picks...');
        }

        homeSnapshot = {
          userId: user?.id ?? null,
          featured: baseFeatured,
          popular: popularMovies,
          newMovies: freshNewMovies,
          forYouSubtitle: user ? 'Building personalized picks...' : 'Popular and fresh picks for now',
          forYouMovies: quickFallbackForYou,
          forYouShows: [],
          dailyGenreTitle: `Today ${dailyGenre.name}`,
          dailyGenreMovies: nextDailyGenreMovies,
          newEpisodes: cleanOnTheAir,
          similarSeedTitle: null,
          similarMovies: [],
          watchedIds: Array.from(watchedIdSet),
          popularPage: popularStartPage,
          popularTotalPages: popularRes.total_pages ?? 1,
          newMoviesPage: newMoviesStartPage,
          newMoviesTotalPages: newMovieRes.total_pages ?? 1,
          newEpisodesPage: newEpisodesStartPage,
          newEpisodesTotalPages: newEpisodeRes.total_pages ?? 1,
          loadedAt: Date.now(),
        };
        lastHomeLoadAtRef.current = Date.now();

        let nextForYouMovies: Movie[] = [];
        let nextForYouShows: TvShow[] = [];
        let nextForYouSubtitle: string | null = null;
        let nextSimilarSeedTitle: string | null = null;
        let nextSimilarMovies: Movie[] = [];
        let similarForYouPool: Movie[] = [];
        let userMovieSignalCount = 0;
        let userTvSignalCount = 0;
        let forYouPolicy: ForYouTastePolicy = {
          allowAnimation: false,
          allowKids: false,
          allowTv: false,
          minVoteCount: FOR_YOU_STRICT_MIN_VOTE_COUNT,
          minVoteAverage: FOR_YOU_STRICT_MIN_VOTE_AVERAGE,
        };

        if (user) {
          try {
            const [watchlistRows, favoriteRows, ratingRows] = await Promise.all([
              getUserWatchlist(user.id),
              getUserFavorites(user.id),
              getUserRatings(user.id),
            ]);

            const watchedIds = new Set(watchedRows.map((row) => row.tmdbId));
            const movieSignalIds = new Set<number>([
              ...watchlistRows.filter((row) => row.mediaType !== 'tv').map((row) => row.tmdbId),
              ...favoriteRows.filter((row) => row.mediaType !== 'tv').map((row) => row.tmdbId),
              ...watchedRows.filter((row) => row.mediaType !== 'tv').map((row) => row.tmdbId),
              ...ratingRows.filter((row) => row.mediaType !== 'tv').map((row) => row.tmdbId),
            ]);
            userMovieSignalCount = movieSignalIds.size;
            const tvSignalIds = new Set<number>([
              ...watchlistRows.filter((row) => row.mediaType === 'tv').map((row) => row.tmdbId),
              ...favoriteRows.filter((row) => row.mediaType === 'tv').map((row) => row.tmdbId),
              ...watchedRows.filter((row) => row.mediaType === 'tv').map((row) => row.tmdbId),
              ...ratingRows.filter((row) => row.mediaType === 'tv').map((row) => row.tmdbId),
            ]);
            userTvSignalCount = tvSignalIds.size;

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

            const seedMovieDetails = await mapWithConcurrency(
              seedMovieIds.slice(0, HOME_DETAIL_FETCH_LIMIT),
              HOME_DETAIL_FETCH_CONCURRENCY,
              async (tmdbId) => {
                try {
                  return await getMovieById(tmdbId);
                } catch {
                  return null;
                }
              }
            );
            const seedTvDetails = await mapWithConcurrency(
              Array.from(tvSignalIds).slice(0, HOME_DETAIL_FETCH_LIMIT),
              HOME_DETAIL_FETCH_CONCURRENCY,
              async (tmdbId) => {
                try {
                  return await getTvById(tmdbId);
                } catch {
                  return null;
                }
              }
            );
            const seedGenreWeights = buildSeedGenreWeights(
              [
                ...seedMovieDetails.filter((movie): movie is Movie => !!movie),
                ...seedTvDetails.filter((show): show is TvShow => !!show),
              ]
            );
            const animationTasteWeight = seedGenreWeights.get(GENRE_ANIMATION) ?? 0;
            const kidsTasteWeight =
              (seedGenreWeights.get(GENRE_FAMILY_MOVIE) ?? 0) +
              (seedGenreWeights.get(GENRE_KIDS_TV) ?? 0);
            const hasAnySignal = userMovieSignalCount + userTvSignalCount > 0;
            forYouPolicy = {
              allowAnimation: animationTasteWeight > 0,
              allowKids: kidsTasteWeight > 0,
              allowTv: userTvSignalCount > 0,
              minVoteCount:
                hasAnySignal && userMovieSignalCount >= ML_MIN_SIGNAL_INTERACTIONS
                  ? FOR_YOU_MIN_VOTE_COUNT
                  : FOR_YOU_STRICT_MIN_VOTE_COUNT,
              minVoteAverage:
                hasAnySignal && userMovieSignalCount >= ML_MIN_SIGNAL_INTERACTIONS
                  ? 5.8
                  : FOR_YOU_STRICT_MIN_VOTE_AVERAGE,
            };

            if (hasMlApi()) {
              try {
                const followingProfiles = await getFollowingProfiles(user.id);
                const now = Date.now();
                if (now - lastMlGraphSyncAtRef.current > ML_GRAPH_SYNC_MIN_MS) {
                  await syncMlFollowingGraph(
                    user.id,
                    followingProfiles.map((p) => p.user_id)
                  );
                  lastMlGraphSyncAtRef.current = now;
                }
                const shouldUseMlPrimary =
                  movieSignalIds.size + tvSignalIds.size >= ML_MIN_SIGNAL_INTERACTIONS ||
                  followingProfiles.length > 0;
                if (shouldUseMlPrimary) {
                  const [mlMovieIds, mlTvIds] = await Promise.all([
                    getMlRecommendations(user.id, {
                      mediaType: 'movie',
                      topN: HOME_DETAIL_FETCH_LIMIT * 3,
                    }),
                    getMlRecommendations(user.id, {
                      mediaType: 'tv',
                      topN: HOME_DETAIL_FETCH_LIMIT * 3,
                    }),
                  ]);
                  const limitedMlIds = mlMovieIds.slice(0, HOME_DETAIL_FETCH_LIMIT * 3);
                  if (limitedMlIds.length > 0) {
                    const details = await mapWithConcurrency(
                      limitedMlIds,
                      HOME_DETAIL_FETCH_CONCURRENCY,
                      async (row) => {
                        try {
                          return await getMovieById(row.tmdb_id);
                        } catch {
                          return null;
                        }
                      }
                    );
                    const mlReasonById = new Map<number, string>(
                      limitedMlIds.map((row) => [
                        Number(row.tmdb_id),
                        String(row.reason ?? '').trim(),
                      ])
                    );
                    const mlMovies = rankRecommendationCandidates(
                      details
                        .filter((item): item is Movie => !!item)
                        .filter((item) => !watchedIds.has(item.id))
                        .filter(hasListData),
                      seedGenreWeights
                    );
                    const filteredMlMovies = filterForYouByPolicy(mlMovies, forYouPolicy);
                    if (filteredMlMovies.length > 0) {
                      nextForYouMovies = filteredMlMovies.slice(0, 20);
                      const seedMovie = seedMovieDetails.find((movie): movie is Movie => !!movie) ?? null;
                      const recoTop = filteredMlMovies[0] ?? null;
                      if (seedMovie?.title && recoTop?.title) {
                        nextForYouSubtitle = `You loved ${seedMovie.title}, we think you'll love ${recoTop.title}`;
                      }
                      if (!nextForYouSubtitle) {
                        const topReason = recoTop ? mlReasonById.get(recoTop.id) : '';
                        const reason = String(topReason ?? limitedMlIds[0]?.reason ?? '').trim();
                        nextForYouSubtitle = reason || null;
                      }
                    }
                  }
                  const limitedMlTvIds = mlTvIds.slice(0, HOME_DETAIL_FETCH_LIMIT * 3);
                  if (limitedMlTvIds.length > 0) {
                    const tvDetails = await mapWithConcurrency(
                      limitedMlTvIds,
                      HOME_DETAIL_FETCH_CONCURRENCY,
                      async (row) => {
                        try {
                          return await getTvById(row.tmdb_id);
                        } catch {
                          return null;
                        }
                      }
                    );
                    const rankedTv = rankTvRecommendationCandidates(
                      tvDetails
                        .filter((item): item is TvShow => !!item)
                        .filter((item) => !watchedIds.has(item.id))
                        .filter(hasListData)
                    );
                    nextForYouShows = filterForYouByPolicy(rankedTv, forYouPolicy).slice(0, 20);
                  }
                }
              } catch {
              }
            }

            if (seedMovieIds.length > 0) {
              try {
                const prioritizedSeedIds = seedMovieIds.slice(0, 3);
                const similarBatches = await Promise.all(
                  prioritizedSeedIds.map(async (tmdbId) => {
                    const [similarRes, recRes] = await Promise.all([
                      getSimilarMovies(tmdbId, 1).catch(() => ({ results: [] as Movie[] })),
                      getMovieRecommendations(tmdbId, 1).catch(() => ({ results: [] as Movie[] })),
                    ]);
                    return {
                      tmdbId,
                      items: [...(similarRes.results ?? []), ...(recRes.results ?? [])],
                    };
                  })
                );
                const merged: Movie[] = [];
                const seen = new Set<number>();
                for (const batch of similarBatches) {
                  for (const item of batch.items ?? []) {
                    if (seen.has(item.id)) continue;
                    if (watchedIds.has(item.id)) continue;
                    if (!hasListData(item)) continue;
                    seen.add(item.id);
                    merged.push(item);
                  }
                }
                similarForYouPool = filterForYouByPolicy(
                  rankRecommendationCandidates(merged, seedGenreWeights),
                  forYouPolicy
                ).slice(0, 24);

                if (similarForYouPool.length > 0) {
                  const primarySeedId = prioritizedSeedIds[0] ?? null;
                  const primarySeedTitle =
                    (primarySeedId
                      ? seedMovieDetails.find((movie): movie is Movie => !!movie && movie.id === primarySeedId)?.title
                      : null) ?? null;
                  if (!nextForYouSubtitle && primarySeedTitle) {
                    nextForYouSubtitle = `Because you liked ${primarySeedTitle}`;
                  }
                }
              } catch {
              }
            }

            const favoriteMovieRows = favoriteRows.filter(
              (row) => row.mediaType !== 'tv' && Number.isFinite(Number(row.tmdbId)) && Number(row.tmdbId) > 0
            );
            const dailyFavoriteRow = pickDailyItem(
              favoriteMovieRows,
              Number(user.id || 0) * 17 + 9
            );

            if (dailyFavoriteRow) {
              try {
                const [seedMovie, similarRes, recRes] = await Promise.all([
                  getMovieById(dailyFavoriteRow.tmdbId).catch(() => null),
                  getSimilarMovies(dailyFavoriteRow.tmdbId, 1).catch(() => ({ results: [] as Movie[] })),
                  getMovieRecommendations(dailyFavoriteRow.tmdbId, 1).catch(() => ({ results: [] as Movie[] })),
                ]);
                nextSimilarSeedTitle = seedMovie?.title ?? `TMDB #${dailyFavoriteRow.tmdbId}`;
                const pool = [...(similarRes.results ?? []), ...(recRes.results ?? [])];
                const dedup = new Map<number, Movie>();
                for (const item of pool) {
                  if (!item || watchedIds.has(item.id) || !hasListData(item)) continue;
                  if (!dedup.has(item.id)) dedup.set(item.id, item);
                }
                nextSimilarMovies = rankRecommendationCandidates(
                  Array.from(dedup.values()),
                  seedGenreWeights
                ).slice(0, 20);
              } catch {
              }
            }
          } catch {
          }
        }

        const fallbackForYou = filterForYouByPolicy(
          buildFallbackForYouMovies({
            primary: freshNewMovies,
            secondary: popularMovies,
            tertiary: nextDailyGenreMovies,
            watchedIdSet,
            limit: 40,
          }),
          forYouPolicy
        );
        const fallbackForYouShows = forYouPolicy.allowTv
          ? filterForYouByPolicy(
              buildFallbackForYouShows({
                primary: cleanOnTheAir,
                secondary: popularTvShows,
                watchedIdSet,
                limit: 30,
              }),
              forYouPolicy
            )
          : [];

        if (similarForYouPool.length > 0) {
          if (nextForYouMovies.length === 0) {
            nextForYouMovies = similarForYouPool.slice(0, 20);
          } else {
            nextForYouMovies = blendById({
              personalized: similarForYouPool,
              fallback: nextForYouMovies,
              limit: 20,
              minPersonalized: Math.max(8, Math.min(14, similarForYouPool.length)),
            });
          }
        }

        const shouldBlendFallback =
          nextForYouMovies.length < 10 || userMovieSignalCount < ML_MIN_SIGNAL_INTERACTIONS;

        if (nextForYouMovies.length === 0) {
          nextForYouMovies = fallbackForYou.slice(0, 20);
        } else if (shouldBlendFallback && similarForYouPool.length === 0) {
          nextForYouMovies = blendById({
            personalized: nextForYouMovies,
            fallback: fallbackForYou,
            limit: 20,
            minPersonalized: Math.max(3, Math.min(10, userMovieSignalCount)),
          });
        } else {
          nextForYouMovies = nextForYouMovies.slice(0, 20);
        }

        if (!forYouPolicy.allowTv) {
          nextForYouShows = [];
        } else if (nextForYouShows.length === 0) {
          nextForYouShows = shuffleItems(fallbackForYouShows).slice(0, 20);
        } else {
          nextForYouShows = blendById({
            personalized: nextForYouShows,
            fallback: fallbackForYouShows,
            limit: 20,
            minPersonalized: 5,
          });
        }
        nextForYouMovies = filterForYouByPolicy(nextForYouMovies, forYouPolicy).slice(0, 20);
        nextForYouShows = forYouPolicy.allowTv
          ? filterForYouByPolicy(nextForYouShows, forYouPolicy).slice(0, 20)
          : [];

        if (nextForYouMovies.length > 0 && !nextForYouSubtitle && userMovieSignalCount < ML_MIN_SIGNAL_INTERACTIONS) {
          nextForYouSubtitle = 'Popular and fresh picks while we learn your taste';
        }

        if (token !== refreshTokenRef.current) return;
        setForYouMovies(nextForYouMovies);
        setForYouShows(nextForYouShows);
        setForYouSubtitle(nextForYouSubtitle);
        setSimilarSeedTitle(nextSimilarSeedTitle);
        setSimilarMovies(nextSimilarMovies);

        homeSnapshot = {
          userId: user?.id ?? null,
          featured: baseFeatured,
          popular: popularMovies,
          newMovies: freshNewMovies,
          forYouSubtitle: nextForYouSubtitle,
          forYouMovies: nextForYouMovies,
          forYouShows: nextForYouShows,
          dailyGenreTitle: `Today ${dailyGenre.name}`,
          dailyGenreMovies: nextDailyGenreMovies,
          newEpisodes: cleanOnTheAir,
          similarSeedTitle: nextSimilarSeedTitle,
          similarMovies: nextSimilarMovies,
          watchedIds: Array.from(watchedIdSet),
          popularPage: popularStartPage,
          popularTotalPages: popularRes.total_pages ?? 1,
          newMoviesPage: newMoviesStartPage,
          newMoviesTotalPages: newMovieRes.total_pages ?? 1,
          newEpisodesPage: newEpisodesStartPage,
          newEpisodesTotalPages: newEpisodeRes.total_pages ?? 1,
          loadedAt: Date.now(),
        };
        lastHomeLoadAtRef.current = Date.now();
      } catch (err) {
        if (token === refreshTokenRef.current) setError((err as Error).message);
      } finally {
        if (!silent && token === refreshTokenRef.current) setLoading(false);
      }
    },
    [user]
  );

  useEffect(() => {
    if (homeSnapshot && homeSnapshot.userId === (user?.id ?? null)) {
      setFeatured(homeSnapshot.featured);
      setPopular(homeSnapshot.popular);
      setNewMovies(homeSnapshot.newMovies);
      setForYouSubtitle(homeSnapshot.forYouSubtitle);
      setForYouMovies(homeSnapshot.forYouMovies);
      setForYouShows(homeSnapshot.forYouShows ?? []);
      setDailyGenreTitle(homeSnapshot.dailyGenreTitle);
      setDailyGenreMovies(homeSnapshot.dailyGenreMovies);
      setNewEpisodes(homeSnapshot.newEpisodes);
      setSimilarSeedTitle(homeSnapshot.similarSeedTitle);
      setSimilarMovies(homeSnapshot.similarMovies);
      setWatchedIds(homeSnapshot.watchedIds);
      setPopularPage(homeSnapshot.popularPage);
      setPopularTotalPages(homeSnapshot.popularTotalPages);
      setNewMoviesPage(homeSnapshot.newMoviesPage);
      setNewMoviesTotalPages(homeSnapshot.newMoviesTotalPages);
      setNewEpisodesPage(homeSnapshot.newEpisodesPage);
      setNewEpisodesTotalPages(homeSnapshot.newEpisodesTotalPages);
      setLoading(false);
      firstLoadDoneRef.current = true;
      const snapshotLoadedAt = Number(homeSnapshot.loadedAt ?? Date.now());
      const isSnapshotFresh = Date.now() - snapshotLoadedAt < HOME_SNAPSHOT_FRESH_MS;
      lastHomeLoadAtRef.current = snapshotLoadedAt;
      if (!isSnapshotFresh) {
        void loadHome({ randomizePages: true, silent: true });
      }
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
        const elapsed = Date.now() - Number(lastHomeLoadAtRef.current || 0);
        if (elapsed < HOME_ACTIVE_REFRESH_MIN_MS) {
          shouldRefreshOnActiveRef.current = false;
          return;
        }
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
    }, CINEMA_POLL_MS);
    return () => {
      mounted = false;
      clearInterval(poll);
    };
  }, []);

  const cinemaEventId = cinemaEvent?.id ?? null;

  useEffect(() => {
    if (!cinemaEventId) return;
    const t = setInterval(() => setCinemaNowIso(new Date().toISOString()), CINEMA_CLOCK_MS);
    return () => clearInterval(t);
  }, [cinemaEventId]);

  useEffect(() => {
    let active = true;
    const tmdbId = Number(cinemaEvent?.tmdb_id ?? 0);
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
      setCinemaMeta(null);
      return;
    }
    (async () => {
      try {
        const meta = await getCinemaEventMeta(tmdbId);
        if (!active) return;
        setCinemaMeta(meta);
      } catch {
        if (!active) return;
        setCinemaMeta(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [cinemaEvent?.tmdb_id]);

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
          const watchedIdSet = new Set(watchedIdsRef.current);
          if (q) {
            const typed = (res.results ?? []) as SearchResultItem[];
            const withPoster = typed.filter(hasSearchCardData);
            setSearchResults(rankByQueryMatch(withPoster, q));
          } else {
            const cleaned = (res.results ?? []).filter(hasListData);
            const filtered = excludeWatched(cleaned.filter(hasListData), watchedIdSet);
            setSearchResults(rankByTaste(filtered as SearchResultItem[], searchTasteSignalsRef.current));
          }
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
  }, [searchOpen, searchQuery]);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!searchOpen) return;
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
            ? getMlRecommendations(user.id, { mediaType: 'movie', topN: 60 }).catch(() => [])
            : Promise.resolve([]),
          hasMlApi()
            ? getMlRecommendations(user.id, { mediaType: 'tv', topN: 60 }).catch(() => [])
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
  }, [searchOpen, user?.id]);

  const searchPopularItems = useMemo(
    () => rankByTaste(popular as SearchResultItem[], searchTasteSignals),
    [popular, searchTasteSignals]
  );
  const searchLatestItems = useMemo(
    () => rankByTaste(newMovies as SearchResultItem[], searchTasteSignals),
    [newMovies, searchTasteSignals]
  );
  const queryMovieResults = useMemo(
    () => searchResults.filter((item) => !isPersonItem(item) && !isTvItem(item)).slice(0, 24),
    [searchResults]
  );
  const querySeriesResults = useMemo(
    () => searchResults.filter((item) => !isPersonItem(item) && isTvItem(item)).slice(0, 24),
    [searchResults]
  );
  const queryActorResults = useMemo(
    () =>
      searchResults
        .filter(
          (item) =>
            isPersonItem(item) &&
            String(item.known_for_department ?? '')
              .trim()
              .toLowerCase() === 'acting'
        )
        .slice(0, 24),
    [searchResults]
  );
  const queryDirectorResults = useMemo(
    () =>
      searchResults
        .filter(
          (item) =>
            isPersonItem(item) &&
            String(item.known_for_department ?? '')
              .trim()
              .toLowerCase() === 'directing'
        )
        .slice(0, 24),
    [searchResults]
  );
  const queryPeopleOtherResults = useMemo(
    () =>
      searchResults
        .filter((item) => {
          if (!isPersonItem(item)) return false;
          const dept = String(item.known_for_department ?? '')
            .trim()
            .toLowerCase();
          return dept !== 'acting' && dept !== 'directing';
        })
        .slice(0, 24),
    [searchResults]
  );
  const hasQuerySections =
    queryMovieResults.length > 0 ||
    querySeriesResults.length > 0 ||
    queryActorResults.length > 0 ||
    queryDirectorResults.length > 0 ||
    queryPeopleOtherResults.length > 0;
  const cinemaPhase = useMemo<'upcoming' | 'live' | 'ended' | 'none'>(() => {
    if (!cinemaEvent) return 'none';
    const now = Date.parse(cinemaNowIso);
    const start = Date.parse(cinemaEvent.start_at);
    const end = Date.parse(cinemaEvent.end_at);
    if (now < start) return 'upcoming';
    if (now <= end) return 'live';
    return 'ended';
  }, [cinemaEvent, cinemaNowIso]);

  const cinemaReminderArmed =
    cinemaPhase === 'upcoming' ? isCinemaLiveReminderArmed(cinemaEvent) : false;

  const heroSlides = useMemo<HeroSlide[]>(() => {
    const candidates = [
      ...(featured ? [featured] : []),
      ...forYouMovies.slice(0, 16),
      ...newMovies.slice(0, 24),
      ...dailyGenreMovies.slice(0, 16),
      ...popular.slice(0, 24),
    ] as (FeaturedDisplay | Movie)[];

    const mapped = candidates.map((item) => {
      const tmdbId = Number((item as any).tmdb_id ?? (item as any).id ?? 0) || null;
      const title = String((item as any).title ?? '').trim();
      const image =
        posterUrl((item as any).poster_path ?? null, 'w500') ||
        backdropUrl((item as any).backdrop_path ?? null, 'w780') ||
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
    for (const it of mapped) {
      if (!it.image) continue;
      if (!dedup.has(it.id)) dedup.set(it.id, it);
    }

    // Keep top carousel stable when sections append data via "Load more".
    return Array.from(dedup.values()).slice(0, 8);
  }, [featured, forYouMovies, newMovies, dailyGenreMovies, popular]);

  const heroSlidesKey = useMemo(() => heroSlides.map((slide) => slide.id).join('|'), [heroSlides]);

  useEffect(() => {
    setHeroIndex(0);
    heroScrollX.setValue(0);
    requestAnimationFrame(() => {
      heroScrollRef.current?.scrollTo({ x: 0, y: 0, animated: false });
    });
  }, [cinemaPhase, heroScrollX, heroSlidesKey]);

  const heroPrimarySlide = heroSlides[heroIndex] ?? heroSlides[0] ?? null;
  const heroTopImage =
    cinemaPhase === 'none'
      ? heroPrimarySlide?.image || null
      : cinemaEvent?.poster_url?.trim() || cinemaMeta?.backdrop || cinemaMeta?.poster || backdropUrl(featured?.backdrop_path, 'w780');

  const isWeb = Platform.OS === 'web';
  const heroCardGap = 0;
  const heroItemWidth = heroSlideWidth > 0 ? Math.max(1, heroSlideWidth) : 320;
  const heroHorizontalInset = 0;
  const heroPosterHeight = isWeb ? 336 : Math.round(heroItemWidth * 1.48);
  const heroCarouselHeight = heroPosterHeight + 22;
  const heroStep = Math.max(1, heroSlideWidth || heroItemWidth || 1);
  const openCinemaPosterDetails = useCallback(() => {
    if (cinemaPhase === 'none') return;
    const tmdbId = Number(cinemaEvent?.tmdb_id ?? 0);
    if (Number.isFinite(tmdbId) && tmdbId > 0) {
      router.push({
        pathname: '/movie/[id]',
        params: { id: String(tmdbId), type: cinemaMeta?.mediaType ?? 'movie' },
      });
      return;
    }
    router.push('/cinema');
  }, [cinemaEvent?.tmdb_id, cinemaMeta?.mediaType, cinemaPhase]);

  const forYouSectionItems = useMemo<(Movie | TvShow)[]>(() => {
    const movieBase = forYouMovies.slice(0, 20);
    const tvBase = forYouShows.slice(0, 20);

    const mixed: (Movie | TvShow)[] = [];
    let i = 0;
    let j = 0;
    while (mixed.length < 20 && (i < movieBase.length || j < tvBase.length)) {
      if (i < movieBase.length) mixed.push(movieBase[i++]);
      if (mixed.length >= 20) break;
      if (j < tvBase.length) mixed.push(tvBase[j++]);
    }
    return mixed;
  }, [forYouMovies, forYouShows]);

  const similarSectionTitle = similarSeedTitle
    ? `We saw that you like ${similarSeedTitle}`
    : 'Similar Movies';

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
        <View style={[styles.header, { paddingTop: Math.max(8, insets.top + 8) }]}>
          <View style={styles.headerLeft}>
            <Pressable onPress={() => setCategoriesOpen(true)} style={styles.headerIconBtnPlain}>
              <Ionicons name="menu" size={22} color="#FFFFFF" />
            </Pressable>
          </View>
          <View style={styles.headerRight}>
            <Pressable onPress={() => setSearchOpen(true)} style={styles.headerIconBtnPlain}>
              <Ionicons name="search" size={22} color="#FFFFFF" />
            </Pressable>
            <Pressable onPress={() => router.push('/notifications' as any)} style={styles.headerIconBtnPlain}>
              <Ionicons name="notifications-outline" size={22} color="#FFFFFF" />
              {unreadCount > 0 ? (
                <View style={styles.headerIconBadge}>
                  <Text style={styles.headerIconBadgeText}>{Math.min(99, unreadCount)}</Text>
                </View>
              ) : null}
            </Pressable>
          </View>
        </View>

        <View style={styles.heroWrap}>
          {heroTopImage ? (
            <View style={styles.heroGlow} pointerEvents="none">
              <Image
                source={{ uri: heroTopImage }}
                style={styles.heroGlowImage}
                contentFit="cover"
                transition={120}
                cachePolicy="memory-disk"
                blurRadius={Platform.OS === 'android' ? 24 : 36}
              />
              <LinearGradient
                colors={['rgba(0,0,0,0.05)', 'rgba(0,0,0,0.35)', theme.background, theme.background]}
                locations={[0, 0.42, 0.82, 1]}
                start={{ x: 0.5, y: 0 }}
                end={{ x: 0.5, y: 1 }}
                style={styles.heroGlowFade}
              />
            </View>
          ) : null}
          <View
            style={[
              styles.heroCard,
              cinemaPhase === 'none' ? styles.heroCardCarousel : styles.heroCardFrame,
              cinemaPhase === 'none' ? { minHeight: heroCarouselHeight } : null,
            ]}
            onLayout={(e) => {
              const next = Math.round(e.nativeEvent.layout.width);
              if (next > 0 && next !== heroSlideWidth) setHeroSlideWidth(next);
            }}>
            {cinemaPhase === 'none' ? (
              <Animated.ScrollView
                ref={heroScrollRef}
                horizontal
                pagingEnabled
                decelerationRate="fast"
                disableIntervalMomentum
                showsHorizontalScrollIndicator={false}
                nestedScrollEnabled
                scrollEventThrottle={16}
                onScroll={Animated.event(
                  [{ nativeEvent: { contentOffset: { x: heroScrollX } } }],
                  { useNativeDriver: true }
                )}
                onMomentumScrollEnd={(e) => {
                  const fallbackStep = Math.max(1, heroSlideWidth || e.nativeEvent.layoutMeasurement.width || 1);
                  const step = heroStep > 0 ? heroStep : fallbackStep;
                  const next = Math.round(e.nativeEvent.contentOffset.x / step);
                  setHeroIndex(Math.max(0, Math.min(heroSlides.length - 1, next)));
                }}
                contentContainerStyle={[
                  styles.heroSlideTrackContent,
                  { paddingHorizontal: heroHorizontalInset, gap: heroCardGap },
                ]}
                style={[
                  styles.heroSlideTrack,
                  { height: heroCarouselHeight },
                ]}>
                {heroSlides.length > 0 ? (
                  heroSlides.map((slide, idx) => {
                    const inputRange = [
                      (idx - 1) * heroStep,
                      idx * heroStep,
                      (idx + 1) * heroStep,
                    ];
                    const animatedScale = heroScrollX.interpolate({
                      inputRange,
                      outputRange: [0.95, 1, 0.95],
                      extrapolate: 'clamp',
                    });
                    const animatedOpacity = heroScrollX.interpolate({
                      inputRange,
                      outputRange: [0.78, 1, 0.78],
                      extrapolate: 'clamp',
                    });
                    const animatedTranslateY = heroScrollX.interpolate({
                      inputRange,
                      outputRange: [6, 0, 6],
                      extrapolate: 'clamp',
                    });
                    return (
                      <Animated.View
                        key={slide.id}
                        style={[
                          styles.heroSlideMotion,
                          {
                            opacity: animatedOpacity,
                            transform: [{ translateY: animatedTranslateY }, { scale: animatedScale }],
                          },
                        ]}>
                        <Pressable
                          style={[
                            styles.heroSlidePage,
                            isWeb && styles.heroSlidePageWeb,
                            {
                              width: heroItemWidth,
                              height: heroPosterHeight,
                            },
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
                              transition={140}
                              cachePolicy="memory-disk"
                            />
                          ) : (
                            <View style={[styles.heroSlideImage, { backgroundColor: theme.backgroundSelected }]} />
                          )}
                        </Pressable>
                      </Animated.View>
                    );
                  })
                ) : (
                  <View
                    style={[
                      styles.heroSlidePage,
                      isWeb && styles.heroSlidePageWeb,
                      {
                        width: heroItemWidth,
                        height: heroPosterHeight,
                      },
                    ]}>
                    <View style={[styles.heroSlideImage, { backgroundColor: theme.backgroundSelected }]} />
                  </View>
                )}
              </Animated.ScrollView>
            ) : heroTopImage ? (
              <Pressable style={styles.heroCinemaPosterTap} onPress={openCinemaPosterDetails}>
                <Image
                  source={{ uri: heroTopImage }}
                  style={styles.heroImage}
                  contentFit="contain"
                  contentPosition="center"
                  transition={140}
                  cachePolicy="memory-disk"
                />
              </Pressable>
            ) : (
              <Pressable style={styles.heroCinemaPosterTap} onPress={openCinemaPosterDetails}>
                <View style={[styles.heroImage, { backgroundColor: theme.backgroundSelected }]} />
              </Pressable>
            )}
            {cinemaPhase === 'none' && heroSlides.length > 1 ? (
              <View style={styles.heroDotsRow}>
                {heroSlides.map((slide, idx) => (
                  <View key={slide.id} style={[styles.heroDot, idx === heroIndex && styles.heroDotActive]} />
                ))}
              </View>
            ) : null}
          </View>
          {cinemaPhase !== 'none' ? (
            <View style={styles.cinemaHeroFooter}>
              {cinemaPhase === 'upcoming' ? (
                <Pressable
                  style={[styles.cinemaHeroNotifyBtn, cinemaReminderArmed && styles.cinemaHeroNotifyBtnArmed]}
                  onPress={() => {
                    if (cinemaReminderArmed) {
                      void disarmCinemaLiveReminder(cinemaEvent);
                    } else {
                      void armCinemaLiveReminder(cinemaEvent);
                    }
                  }}>
                  <Ionicons name="notifications-outline" size={18} color="#fff" />
                  <Text style={styles.cinemaHeroNotifyText}>
                    {cinemaReminderArmed ? 'Reminder on' : 'Notify me'}
                  </Text>
                </Pressable>
              ) : cinemaPhase === 'live' ? (
                <Pressable style={styles.cinemaHeroNotifyBtn} onPress={() => router.push('/cinema')}>
                  <Ionicons name="radio-outline" size={18} color="#fff" />
                  <Text style={styles.cinemaHeroNotifyText}>Go to live</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>

        {error ? (
          <Text style={[styles.errorText, { color: theme.text }]}>{error}</Text>
        ) : null}

        <Section
          title="New Movies"
          subtitle="Now playing and fresh releases"
          items={newMovies}
          onLoadMore={loadMoreNewMovies}
          hasMore={newMoviesPage < newMoviesTotalPages}
          loadingMore={loadingMore === 'newMovies'}
        />
        <Section
          title="New Episodes"
          items={newEpisodes}
          isTv
          onLoadMore={loadMoreNewEpisodes}
          hasMore={newEpisodesPage < newEpisodesTotalPages}
          loadingMore={loadingMore === 'newEpisodes'}
        />
        {dailyGenreMovies.length > 0 ? (
          <Section
            title={dailyGenreTitle}
            subtitle="Daily category spotlight"
            items={dailyGenreMovies}
          />
        ) : null}
        {forYouSectionItems.length > 0 ? (
          <Section
            title="For You"
            subtitle={forYouSubtitle ?? 'Based on your favorites, watched, ratings, and series taste'}
            items={forYouSectionItems}
          />
        ) : null}
        <Section
          title="Popular Movies"
          subtitle="Top picks regardless of release year"
          items={popular}
          onLoadMore={loadMorePopular}
          hasMore={popularPage < popularTotalPages}
          loadingMore={loadingMore === 'popular'}
        />
        {similarMovies.length > 0 ? (
          <Section
            title={similarSectionTitle}
            subtitle="Similar picks based on one of your favorites"
            items={similarMovies}
          />
        ) : null}
      </Animated.ScrollView>

      <Animated.View
        style={[
          styles.topFloatingBar,
          {
            top: Math.max(8, insets.top + 8),
            opacity: scrollY.interpolate({
              inputRange: [0, 60, 120],
              outputRange: [0, 0.55, 1],
              extrapolate: 'clamp',
            }),
          },
        ]}>
        <Pressable onPress={() => setCategoriesOpen(true)} style={styles.headerIconBtn}>
          <Ionicons name="menu" size={18} color="#0D1117" />
        </Pressable>
        <View style={styles.headerRight}>
          <Pressable onPress={() => setSearchOpen(true)} style={styles.headerIconBtn}>
            <Ionicons name="search" size={18} color="#0D1117" />
          </Pressable>
          <Pressable onPress={() => router.push('/notifications' as any)} style={styles.headerIconBtn}>
            <Ionicons name="notifications-outline" size={18} color="#0D1117" />
            {unreadCount > 0 ? (
              <View style={styles.headerIconBadgeLight}>
                <Text style={styles.headerIconBadgeLightText}>{Math.min(99, unreadCount)}</Text>
              </View>
            ) : null}
          </Pressable>
        </View>
      </Animated.View>

      {(categoriesOpen || searchOpen) && (
        <Animated.View style={[styles.scrim, { opacity: overlayOpacity }]}>
          <Pressable style={styles.scrim} onPress={closePanels} />
        </Animated.View>
      )}

      <Animated.View
        style={[
          styles.categoryPanel,
          { top: Math.max(64, insets.top + 64), transform: [{ translateX: categoriesX }] },
        ]}>
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

      <Animated.View
        style={[
          styles.searchPanel,
          { paddingTop: Math.max(48, insets.top + 48), transform: [{ translateX: searchX }] },
        ]}>
        <View style={styles.searchHeader}>
          <Text style={styles.panelTitle}>Search</Text>
          <Pressable onPress={closePanels} style={styles.headerIconBtn}>
            <Ionicons name="close" size={18} color="#0D1117" />
          </Pressable>
        </View>
        <TextInput
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search movies, series, actors, directors..."
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
              <>
                <SearchSection title="Movies" items={queryMovieResults} onItemPress={rememberClickedSearchItem} />
                <SearchSection title="Series" items={querySeriesResults} onItemPress={rememberClickedSearchItem} />
                <SearchSection title="Actors" items={queryActorResults} onItemPress={rememberClickedSearchItem} />
                <SearchSection title="Directors" items={queryDirectorResults} onItemPress={rememberClickedSearchItem} />
                <SearchSection title="People" items={queryPeopleOtherResults} onItemPress={rememberClickedSearchItem} />
                {!hasQuerySections ? (
                  <View style={styles.searchSection}>
                    <Text style={styles.historyEmpty}>No results found for this query.</Text>
                  </View>
                ) : null}
              </>
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
  items: (Movie | TvShow)[];
  isTv?: boolean;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
}) {
  const theme = useTheme();
  const safeItems = useMemo(() => items.filter((item) => hasListData(item)), [items]);
  const listData = useMemo<SectionRowItem[]>(() => {
    const base: SectionRowItem[] = safeItems.map((item, idx) => ({
      kind: 'media',
      key: `${item.id}-${idx}`,
      item,
    }));
    if (hasMore) {
      base.push({ kind: 'loadMore', key: 'load-more' });
    }
    return base;
  }, [hasMore, safeItems]);

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
      <FlatList
        horizontal
        data={listData}
        keyExtractor={(entry) => entry.key}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.rowScroll}
        decelerationRate="fast"
        nestedScrollEnabled
        initialNumToRender={6}
        maxToRenderPerBatch={6}
        windowSize={5}
        removeClippedSubviews
        ItemSeparatorComponent={() => <View style={styles.rowSeparator} />}
        renderItem={({ item: entry }) => {
          if (entry.kind === 'loadMore') {
            return (
              <Pressable onPress={onLoadMore} style={styles.loadMoreCard}>
                {loadingMore ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.loadMoreText}>Load more</Text>
                )}
              </Pressable>
            );
          }
          return (
            <Pressable
              style={styles.card}
              onPress={() => {
                const mediaType =
                  typeof isTv === 'boolean'
                    ? (isTv ? 'tv' : 'movie')
                    : ('name' in (entry.item as any) && !('title' in (entry.item as any)) ? 'tv' : 'movie');
                router.push({
                  pathname: '/movie/[id]',
                  params: { id: String(entry.item.id), type: mediaType },
                });
              }}>
              <Image
                source={{ uri: posterUrl(entry.item.poster_path, 'w342') ?? undefined }}
                style={styles.cardImage}
                contentFit="cover"
                transition={120}
                cachePolicy="memory-disk"
              />
            </Pressable>
          );
        }}
      />
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
  const safeItems = useMemo(() => items.filter(hasSearchCardData).slice(0, 24), [items]);
  if (safeItems.length === 0) return null;
  return (
    <View style={styles.searchSection}>
      {title ? <Text style={styles.searchSectionTitle}>{title}</Text> : null}
      <FlatList
        horizontal
        data={safeItems}
        keyExtractor={(item, idx) => `${item.id}-${idx}`}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.searchRow}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={4}
        removeClippedSubviews
        ItemSeparatorComponent={() => <View style={styles.rowSeparator} />}
        renderItem={({ item }) => (
          <Pressable
            style={styles.searchCard}
            onPress={() => {
              if (isPersonItem(item)) {
                router.push({
                  pathname: '/person/[id]',
                  params: { id: String(item.id), role: resolvePersonRole(item) },
                });
                return;
              }
              onItemPress?.(item);
              router.push({
                pathname: '/movie/[id]',
                params: { id: String(item.id), type: isTvItem(item) ? 'tv' : 'movie' },
              });
            }}>
            <Image
              source={{ uri: posterUrl(resolveSearchImagePath(item), 'w185') ?? undefined }}
              style={styles.searchCardImage}
              contentFit="cover"
              transition={100}
              cachePolicy="memory-disk"
            />
          </Pressable>
        )}
      />
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
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  headerIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.2,
    borderColor: 'rgba(14,20,28,0.82)',
    backgroundColor: 'rgba(244,247,252,0.95)',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  headerIconBtnPlain: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    borderWidth: 0,
  },
  headerIconBadge: {
    position: 'absolute',
    right: 4,
    top: 5,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EF4444',
  },
  headerIconBadgeText: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '700',
  },
  headerIconBadgeLight: {
    position: 'absolute',
    right: 2,
    top: 3,
    minWidth: 14,
    height: 14,
    borderRadius: 7,
    paddingHorizontal: 3,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#DC2626',
  },
  headerIconBadgeLightText: {
    color: '#FFFFFF',
    fontSize: 8,
    fontWeight: '700',
  },
  heroWrap: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.four,
    position: 'relative',
    marginTop: -Spacing.one,
  },
  heroGlow: {
    position: 'absolute',
    left: -Spacing.four,
    right: -Spacing.four,
    top: -300,
    bottom: -120,
    borderRadius: 0,
    overflow: 'hidden',
    opacity: 0.98,
    transform: [{ scale: 1.2 }],
  },
  heroGlowFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 440,
  },
  heroGlowImage: {
    width: '100%',
    height: '100%',
  },
  heroCard: {
    borderRadius: Spacing.three,
    overflow: 'visible',
    minHeight: 250,
    backgroundColor: 'transparent',
  },
  heroCardFrame: {
    overflow: 'hidden',
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderColor: 'transparent',
  },
  heroCardCarousel: {
    minHeight: 340,
    overflow: 'hidden',
    borderWidth: 0,
    borderColor: 'transparent',
    backgroundColor: 'transparent',
  },
  heroImage: {
    width: '100%',
    aspectRatio: 3 / 4,
    backgroundColor: '#05070d',
  },
  heroCinemaPosterTap: {
    width: '100%',
  },
  cinemaHeroFooter: {
    marginTop: 12,
    alignItems: 'center',
  },
  cinemaHeroNotifyBtn: {
    minWidth: 178,
    borderRadius: 999,
    paddingHorizontal: 20,
    paddingVertical: 11,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#C1121F',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  cinemaHeroNotifyBtnArmed: {
    backgroundColor: '#8F0D16',
  },
  cinemaHeroNotifyText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 12,
    letterSpacing: 0.4,
  },
  heroSlideTrack: {
    width: '100%',
    height: 420,
  },
  heroSlideTrackContent: {
    alignItems: 'flex-start',
  },
  heroSlideTrackContentWeb: {
    alignItems: 'stretch',
    paddingHorizontal: 0,
    gap: 0,
  },
  heroSlidePage: {
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: '#0c0c0c',
    marginTop: 0,
  },
  heroSlideMotion: {
    transform: [{ translateY: 0 }, { scale: 1 }],
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
    width: 6,
    height: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.42)',
  },
  heroDotActive: {
    width: 20,
    backgroundColor: '#fff',
  },
  topFloatingBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    top: 8,
    height: 44,
    borderRadius: 18,
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderColor: 'transparent',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 0,
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
    paddingRight: Spacing.one,
  },
  rowSeparator: {
    width: Spacing.two,
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
    minHeight: 164,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    justifyContent: 'center',
    backgroundColor: 'rgba(7,10,14,0.9)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  heroOverlayGlassCentered: {
    borderRadius: 18,
    overflow: 'hidden',
    minHeight: 118,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    justifyContent: 'center',
    backgroundColor: 'rgba(7,10,14,0.9)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
  },
  heroTitle: {
    fontSize: 20,
    fontFamily: Fonts.serif,
    marginTop: 6,
    marginBottom: Spacing.one,
  },
  heroOverview: {
    fontFamily: Fonts.serif,
    fontSize: 12,
    color: 'rgba(255,255,255,0.85)',
  },
  heroCinemaKickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  heroCinemaBadge: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(253,230,138,0.6)',
    backgroundColor: 'rgba(120,53,15,0.45)',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  heroCinemaBadgeLive: {
    borderColor: 'rgba(248,113,113,0.66)',
    backgroundColor: 'rgba(153,27,27,0.45)',
  },
  heroCinemaBadgeText: {
    color: '#fef3c7',
    fontFamily: Fonts.mono,
    fontSize: 10,
    letterSpacing: 0.5,
  },
  heroCinemaStartText: {
    color: 'rgba(255,255,255,0.8)',
    fontFamily: Fonts.mono,
    fontSize: 10.5,
  },
  heroCinemaCountdown: {
    color: '#fb7185',
    fontFamily: Fonts.mono,
    fontSize: 18,
    lineHeight: 22,
    marginBottom: 1,
  },
  heroCinemaLoading: {
    marginTop: 2,
    alignSelf: 'flex-start',
  },
  heroCinemaDetail: {
    color: 'rgba(255,255,255,0.84)',
    fontFamily: Fonts.mono,
    fontSize: 10.5,
    lineHeight: 15,
    marginTop: 2,
  },
  heroCinemaGenres: {
    color: 'rgba(191,219,254,0.92)',
    fontFamily: Fonts.mono,
    fontSize: 10.5,
    lineHeight: 15,
    marginTop: 2,
  },
  heroCinemaActions: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cinemaCta: {
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
  cinemaCtaSecondary: {
    backgroundColor: 'rgba(15,23,42,0.82)',
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
  cardGlassAndroid: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
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


