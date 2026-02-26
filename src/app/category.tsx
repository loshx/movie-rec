import { Image } from 'expo-image';
import { useLocalSearchParams, router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { getMoviesByGenre, posterUrl, Movie, type GenreDiscoverOptions } from '@/lib/tmdb';
import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

const SORT_OPTIONS: { key: NonNullable<GenreDiscoverOptions['sortBy']>; label: string }[] = [
  { key: 'popularity.desc', label: 'Popular' },
  { key: 'vote_average.desc', label: 'Ranking' },
  { key: 'primary_release_date.desc', label: 'Newest' },
  { key: 'primary_release_date.asc', label: 'Oldest' },
];

function parseYearOrNull(raw: string) {
  const clean = String(raw || '').trim();
  if (!clean) return null;
  if (!/^\d{4}$/.test(clean)) return null;
  const year = Number(clean);
  if (!Number.isFinite(year) || year < 1900 || year > 2100) return null;
  return year;
}

export default function CategoryScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams();
  const genreId = Number(params.genreId ?? 0);
  const genreName = (params.genreName as string) || 'Category';

  const [movies, setMovies] = useState<Movie[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sortBy, setSortBy] = useState<NonNullable<GenreDiscoverOptions['sortBy']>>('popularity.desc');
  const [yearInput, setYearInput] = useState('');
  const [yearFilter, setYearFilter] = useState<number | null>(null);
  const [yearError, setYearError] = useState<string | null>(null);

  const loadGenrePage = useCallback(
    async (targetPage: number, replace: boolean) => {
      if (replace) setLoading(true);
      else setLoadingMore(true);

      try {
        const res = await getMoviesByGenre(genreId, targetPage, {
          sortBy,
          year: yearFilter,
        });
        const nextItems = (res.results ?? []).filter((item) => !!item.poster_path && !!item.title?.trim());

        if (replace) {
          setMovies(nextItems);
        } else {
          setMovies((prev) => {
            const seen = new Set(prev.map((x) => x.id));
            const append = nextItems.filter((x) => !seen.has(x.id));
            return [...prev, ...append];
          });
        }
        setPage(targetPage);
        setTotalPages(Math.max(1, Number(res.total_pages ?? 1)));
      } finally {
        if (replace) setLoading(false);
        else setLoadingMore(false);
      }
    },
    [genreId, sortBy, yearFilter]
  );

  useEffect(() => {
    let active = true;
    (async () => {
      if (!active) return;
      await loadGenrePage(1, true);
    })();
    return () => {
      active = false;
    };
  }, [loadGenrePage]);

  const applyYearFilter = useCallback(() => {
    const parsed = parseYearOrNull(yearInput);
    if (yearInput.trim() && parsed === null) {
      setYearError('Year must be 4 digits (e.g. 2023).');
      return;
    }
    setYearError(null);
    setYearFilter(parsed);
  }, [yearInput]);

  const clearYearFilter = useCallback(() => {
    setYearInput('');
    setYearFilter(null);
    setYearError(null);
  }, []);

  const activeSortLabel = useMemo(
    () => SORT_OPTIONS.find((opt) => opt.key === sortBy)?.label ?? 'Popular',
    [sortBy]
  );

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.replace('/(tabs)')} style={styles.backBtn}>
          <Ionicons name="home" size={18} color="#fff" />
        </Pressable>
        <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
          {genreName}
        </Text>
        <View style={{ width: 34 }} />
      </View>

      <View style={styles.filters}>
        <Text style={styles.filterTitle}>Sort</Text>
        <View style={styles.sortRow}>
          {SORT_OPTIONS.map((option) => (
            <Pressable
              key={option.key}
              onPress={() => setSortBy(option.key)}
              style={[styles.sortChip, sortBy === option.key ? styles.sortChipActive : null]}>
              <Text style={styles.sortChipText}>{option.label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.yearRow}>
          <TextInput
            value={yearInput}
            onChangeText={setYearInput}
            placeholder="Year (e.g. 2023)"
            placeholderTextColor="rgba(255,255,255,0.6)"
            keyboardType="number-pad"
            style={styles.yearInput}
            maxLength={4}
          />
          <Pressable onPress={applyYearFilter} style={styles.yearBtn}>
            <Text style={styles.yearBtnText}>Apply</Text>
          </Pressable>
          <Pressable onPress={clearYearFilter} style={[styles.yearBtn, styles.yearBtnGhost]}>
            <Text style={styles.yearBtnText}>Clear</Text>
          </Pressable>
        </View>
        <Text style={styles.filterMeta}>
          {`Sort: ${activeSortLabel}${yearFilter ? ` - Year: ${yearFilter}` : ''}`}
        </Text>
        {yearError ? <Text style={styles.filterError}>{yearError}</Text> : null}
      </View>

      {loading ? (
        <View style={styles.loader}>
          <ActivityIndicator color="#fff" />
        </View>
      ) : (
        <FlatList
          data={movies}
          keyExtractor={(item, idx) => `${item.id}-${idx}`}
          numColumns={4}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.gridList}
          columnWrapperStyle={styles.gridRow}
          renderItem={({ item }) => (
            <Pressable style={styles.card} onPress={() => router.push(`/movie/${item.id}`)}>
              <Image source={{ uri: posterUrl(item.poster_path, 'w342') ?? undefined }} style={styles.poster} />
            </Pressable>
          )}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyText}>No titles found for these filters.</Text>
            </View>
          }
          ListFooterComponent={
            page < totalPages ? (
              <Pressable
                onPress={() => {
                  if (loadingMore) return;
                  void loadGenrePage(page + 1, false);
                }}
                style={styles.loadMore}>
                {loadingMore ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.loadMoreText}>Load more</Text>
                )}
              </Pressable>
            ) : null
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.five,
    paddingBottom: Spacing.two,
    gap: Spacing.two,
  },
  backBtn: {
    width: 34,
    height: 34,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontFamily: Fonts.serif,
    fontSize: 18,
  },
  filters: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.two,
    gap: 8,
  },
  filterTitle: {
    color: 'rgba(255,255,255,0.9)',
    fontFamily: Fonts.mono,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  sortRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  sortChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  sortChipActive: {
    borderColor: 'rgba(255,255,255,0.62)',
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  sortChipText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  yearRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  yearInput: {
    flex: 1,
    height: 42,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(0,0,0,0.28)',
    paddingHorizontal: 12,
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 12,
  },
  yearBtn: {
    height: 42,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  yearBtnGhost: {
    backgroundColor: 'rgba(0,0,0,0.22)',
  },
  yearBtnText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  filterMeta: {
    color: 'rgba(255,255,255,0.68)',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  filterError: {
    color: '#ffb4b4',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  loader: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridList: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.six,
  },
  gridRow: {
    justifyContent: 'space-between',
    marginBottom: Spacing.two,
  },
  card: {
    width: '23.5%',
  },
  poster: {
    width: '100%',
    height: 128,
    borderRadius: 10,
  },
  emptyWrap: {
    paddingVertical: Spacing.five,
  },
  emptyText: {
    color: 'rgba(255,255,255,0.7)',
    fontFamily: Fonts.mono,
    fontSize: 12,
  },
  loadMore: {
    marginTop: Spacing.two,
    width: '100%',
    paddingVertical: Spacing.three,
    borderRadius: 16,
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
