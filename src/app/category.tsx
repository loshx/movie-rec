import { Image } from 'expo-image';
import { useLocalSearchParams, router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { getMoviesByGenre, posterUrl, Movie } from '@/lib/tmdb';
import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

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

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setLoading(true);
        const res = await getMoviesByGenre(genreId, 1);
        if (mounted) {
          setMovies(res.results ?? []);
          setPage(1);
          setTotalPages(res.total_pages ?? 1);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [genreId]);

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.replace('/(tabs)')} style={styles.backBtn}>
          <Ionicons name="home" size={18} color="#fff" />
        </Pressable>
        <Text style={[styles.title, { color: theme.text }]}>{genreName}</Text>
        <View style={{ width: 34 }} />
      </View>
      {loading ? (
        <View style={styles.loader}>
          <ActivityIndicator color="#fff" />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.grid} showsVerticalScrollIndicator={false}>
          {movies.map((movie, idx) => (
            <Pressable
              key={`${movie.id}-${idx}`}
              style={styles.card}
              onPress={() => router.push(`/movie/${movie.id}`)}>
              <Image source={{ uri: posterUrl(movie.poster_path, 'w342') ?? undefined }} style={styles.poster} />
            </Pressable>
          ))}
          {page < totalPages ? (
            <Pressable
              onPress={async () => {
                if (loadingMore) return;
                setLoadingMore(true);
                try {
                  const nextPage = page + 1;
                  const res = await getMoviesByGenre(genreId, nextPage);
                  setMovies((prev) => [...prev, ...(res.results ?? [])]);
                  setPage(nextPage);
                  setTotalPages(res.total_pages ?? totalPages);
                } finally {
                  setLoadingMore(false);
                }
              }}
              style={styles.loadMore}>
              {loadingMore ? <ActivityIndicator color="#fff" /> : <Text style={styles.loadMoreText}>Load more</Text>}
            </Pressable>
          ) : null}
        </ScrollView>
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
    fontFamily: Fonts.serif,
    fontSize: 18,
  },
  loader: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grid: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.six,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  card: {
    width: '47%',
    marginBottom: Spacing.two,
  },
  poster: {
    width: '100%',
    height: 220,
    borderRadius: 16,
  },
  loadMore: {
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
