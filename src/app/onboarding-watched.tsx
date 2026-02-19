import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';

import { useAuth } from '@/contexts/AuthContext';
import { Fonts, Spacing } from '@/constants/theme';
import {
  getPopularMovies,
  getPopularTv,
  getSimilarMovies,
  getSimilarTv,
  getTopRatedMovies,
  getTopRatedTv,
  Movie,
  TvShow,
  posterUrl,
} from '@/lib/tmdb';
import { setWatched } from '@/db/user-movies';

const INITIAL_GRID_COUNT = 24;
const PERSONALIZED_BATCH_COUNT = 12;
const SELECTION_STEP_FOR_MORE = 3;

type OnboardingItem = {
  id: number;
  mediaType: 'movie' | 'tv';
  title: string;
  overview: string;
  poster_path: string | null;
  vote_average: number;
  vote_count?: number;
  popularity?: number;
};

const CURATED_START_KEYS = new Set([
  'movie:157336', // Interstellar
  'movie:329865', // Arrival
  'movie:286217', // The Martian
  'movie:27205', // Inception
  'movie:550', // Fight Club
  'movie:13', // Forrest Gump
  'movie:155', // The Dark Knight
  'movie:278', // The Shawshank Redemption
  'movie:603', // The Matrix
  'movie:680', // Pulp Fiction
  'tv:1396', // Breaking Bad
  'tv:1399', // Game of Thrones
  'tv:66732', // Stranger Things
  'tv:94997', // House of the Dragon
  'tv:71912', // The Witcher
]);

function toItemKey(item: Pick<OnboardingItem, 'id' | 'mediaType'>) {
  return `${item.mediaType}:${item.id}`;
}

function normalizeMovie(m: Movie): OnboardingItem {
  return {
    id: m.id,
    mediaType: 'movie',
    title: m.title,
    overview: m.overview,
    poster_path: m.poster_path,
    vote_average: m.vote_average,
    vote_count: m.vote_count,
    popularity: m.popularity,
  };
}

function normalizeTv(t: TvShow): OnboardingItem {
  return {
    id: t.id,
    mediaType: 'tv',
    title: t.name,
    overview: t.overview,
    poster_path: t.poster_path,
    vote_average: t.vote_average,
    vote_count: t.vote_count,
    popularity: t.popularity,
  };
}

function isGoodStarterItem(item: OnboardingItem) {
  const votes = item.vote_count ?? 0;
  const minVotes = item.mediaType === 'movie' ? 600 : 300;
  return (
    !!item.poster_path &&
    !!item.overview?.trim() &&
    (item.vote_average ?? 0) >= 6.7 &&
    votes >= minVotes
  );
}

function isGoodPersonalizedItem(item: OnboardingItem) {
  const votes = item.vote_count ?? 0;
  return !!item.poster_path && !!item.overview?.trim() && (item.vote_average ?? 0) >= 6.2 && votes >= 60;
}

function qualityScore(item: OnboardingItem) {
  const votes = Math.max(0, item.vote_count ?? 0);
  const rating = Math.max(0, item.vote_average ?? 0);
  const popularity = Math.max(0, item.popularity ?? 0);
  const curatedBonus = CURATED_START_KEYS.has(toItemKey(item)) ? 1000 : 0;
  return curatedBonus + rating * 14 + Math.log10(votes + 1) * 24 + popularity * 0.06;
}

function uniqueByKey(items: OnboardingItem[]) {
  const seen = new Set<string>();
  const out: OnboardingItem[] = [];
  for (const item of items) {
    const key = toItemKey(item);
    if (!item?.id || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export default function OnboardingWatchedScreen() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadingMorePicks, setLoadingMorePicks] = useState(false);
  const [items, setItems] = useState<OnboardingItem[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const fillPoolRef = useRef<OnboardingItem[]>([]);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      try {
        setLoading(true);
        const [popular1, popular2, popular3, topRated1, topRated2, popularTv1, popularTv2, topRatedTv1] = await Promise.all([
          getPopularMovies(1),
          getPopularMovies(2),
          getPopularMovies(3),
          getTopRatedMovies(1),
          getTopRatedMovies(2),
          getPopularTv(1),
          getPopularTv(2),
          getTopRatedTv(1),
        ]);
        const merged = uniqueByKey([
          ...(popular1.results ?? []).map(normalizeMovie),
          ...(popular2.results ?? []).map(normalizeMovie),
          ...(popular3.results ?? []).map(normalizeMovie),
          ...(topRated1.results ?? []).map(normalizeMovie),
          ...(topRated2.results ?? []).map(normalizeMovie),
          ...(popularTv1.results ?? []).map(normalizeTv),
          ...(popularTv2.results ?? []).map(normalizeTv),
          ...(topRatedTv1.results ?? []).map(normalizeTv),
        ]);
        const ranked = merged.filter(isGoodStarterItem).sort((a, b) => qualityScore(b) - qualityScore(a));
        if (mountedRef.current) {
          setItems(ranked.slice(0, INITIAL_GRID_COUNT));
          fillPoolRef.current = ranked.slice(INITIAL_GRID_COUNT);
        }
      } catch {
        if (mountedRef.current) setItems([]);
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    })();

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const selectedCount = useMemo(
    () => Object.values(selected).filter(Boolean).length,
    [selected]
  );

  const appendFromPool = (count: number) => {
    const next = fillPoolRef.current.slice(0, count);
    fillPoolRef.current = fillPoolRef.current.slice(count);
    if (next.length > 0) {
      setItems((prev) => uniqueByKey([...prev, ...next]));
    }
  };

  const loadPersonalizedBatch = async (seeds: OnboardingItem[]) => {
    if (inFlightRef.current || seeds.length === 0) return;
    inFlightRef.current = true;
    setLoadingMorePicks(true);
    try {
      const recentSeeds = seeds.slice(-3).reverse();
      const batches = await Promise.all(
        recentSeeds.map((seed) =>
          seed.mediaType === 'movie'
            ? getSimilarMovies(seed.id, 1)
                .then((res) => (res.results ?? []).map(normalizeMovie))
                .catch(() => [] as OnboardingItem[])
            : getSimilarTv(seed.id, 1)
                .then((res) => (res.results ?? []).map(normalizeTv))
                .catch(() => [] as OnboardingItem[])
        )
      );
      const currentKeys = new Set(items.map((item) => toItemKey(item)));
      const merged = uniqueByKey(batches.flat())
        .filter(isGoodPersonalizedItem)
        .filter((item) => !currentKeys.has(toItemKey(item)))
        .sort((a, b) => qualityScore(b) - qualityScore(a))
        .slice(0, PERSONALIZED_BATCH_COUNT);

      if (mountedRef.current && merged.length > 0) {
        setItems((prev) => uniqueByKey([...prev, ...merged]));
      }

      if (merged.length < PERSONALIZED_BATCH_COUNT) {
        appendFromPool(PERSONALIZED_BATCH_COUNT - merged.length);
      }
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) setLoadingMorePicks(false);
    }
  };

  const onToggle = (item: OnboardingItem) => {
    const key = toItemKey(item);
    setSelected((prev) => {
      const nextValue = !prev[key];
      const next = { ...prev, [key]: nextValue };
      const nextSelectedItems = items.filter((it) => !!next[toItemKey(it)]);

      // Every few picks, expand list with similar titles to learn taste faster.
      if (
        nextValue &&
        nextSelectedItems.length >= 2 &&
        nextSelectedItems.length % SELECTION_STEP_FOR_MORE === 0
      ) {
        void loadPersonalizedBatch(nextSelectedItems);
      }
      return next;
    });
  };

  const onContinue = async () => {
    if (!user) {
      router.replace('/login');
      return;
    }

    setSaving(true);
    try {
      const selectedItems = items.filter((item) => !!selected[toItemKey(item)]);
      await Promise.all(
        selectedItems.map((item) => setWatched(user.id, item.id, true, item.mediaType))
      );
      router.replace('/(tabs)');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Movies & series already watched</Text>
      <Text style={styles.subtitle}>Choose what you watched. We will personalize Home based on your selection.</Text>

      {loading ? (
        <View style={styles.loaderWrap}>
          <ActivityIndicator color="#fff" />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.grid} showsVerticalScrollIndicator={false}>
          {items.map((item) => {
            const active = !!selected[toItemKey(item)];
            return (
              <Pressable
                key={toItemKey(item)}
                style={[styles.card, active && styles.cardActive]}
                onPress={() => onToggle(item)}>
                <Image
                  source={{ uri: posterUrl(item.poster_path, 'w342') ?? undefined }}
                  style={styles.poster}
                  contentFit="cover"
                />
                {active ? (
                  <View style={styles.check}>
                    <Ionicons name="checkmark" size={16} color="#fff" />
                  </View>
                ) : null}
              </Pressable>
            );
          })}
          {loadingMorePicks ? (
            <View style={styles.inlineLoader}>
              <ActivityIndicator color="#fff" />
              <Text style={styles.inlineLoaderText}>Loading more picks based on your taste...</Text>
            </View>
          ) : null}
        </ScrollView>
      )}

      <View style={styles.footer}>
        <Text style={styles.counter}>{selectedCount} selected</Text>
      </View>

      <Pressable onPress={onContinue} style={styles.nextBtn} disabled={saving}>
        {saving ? <ActivityIndicator color="#fff" /> : <Ionicons name="arrow-forward" size={22} color="#fff" />}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.five,
  },
  title: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 28,
  },
  subtitle: {
    color: 'rgba(255,255,255,0.7)',
    fontFamily: Fonts.serif,
    fontSize: 13,
    marginTop: Spacing.one,
    marginBottom: Spacing.three,
  },
  loaderWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingBottom: 120,
  },
  inlineLoader: {
    width: '100%',
    marginTop: 10,
    marginBottom: 6,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  inlineLoaderText: {
    color: 'rgba(255,255,255,0.72)',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  card: {
    width: '31%',
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  cardActive: {
    borderColor: '#C1121F',
  },
  poster: {
    width: '100%',
    aspectRatio: 2 / 3,
    backgroundColor: '#111',
  },
  check: {
    position: 'absolute',
    right: 6,
    top: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#C1121F',
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: {
    position: 'absolute',
    left: Spacing.three,
    bottom: 36,
  },
  counter: {
    color: 'rgba(255,255,255,0.75)',
    fontFamily: Fonts.mono,
    fontSize: 12,
  },
  nextBtn: {
    position: 'absolute',
    right: 24,
    bottom: 24,
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
