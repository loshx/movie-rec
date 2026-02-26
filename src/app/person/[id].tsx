import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from '@react-navigation/native';

import { GlassView } from '@/components/glass-view';
import { useAuth } from '@/contexts/AuthContext';
import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { isFavoriteActor, isFavoriteDirector, toggleFavoriteActor, toggleFavoriteDirector } from '@/db/user-movies';
import { ingestMlInteractionsBatch, MlInteractionEvent } from '@/lib/ml-recommendations';
import {
  getPersonById,
  getPersonCombinedCredits,
  posterUrl,
  TmdbPerson,
  TmdbPersonCredit,
} from '@/lib/tmdb';

export default function PersonDetailsScreen() {
  const theme = useTheme();
  const { user } = useAuth();
  const params = useLocalSearchParams();
  const personId = Number(params.id ?? 0);
  const roleParam = String(params.role ?? '').toLowerCase();
  const favoriteKind: 'actor' | 'director' = roleParam === 'director' ? 'director' : 'actor';

  const [loading, setLoading] = useState(true);
  const [person, setPerson] = useState<TmdbPerson | null>(null);
  const [credits, setCredits] = useState<TmdbPersonCredit[]>([]);
  const [isFav, setIsFav] = useState(false);
  const [bioExpanded, setBioExpanded] = useState(false);
  const scrollRef = useRef<ScrollView | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setLoading(true);
        const [personRes, creditsRes] = await Promise.all([
          getPersonById(personId),
          getPersonCombinedCredits(personId),
        ]);
        if (!mounted) return;
        const source =
          favoriteKind === 'director'
            ? (creditsRes.crew ?? []).filter(
                (item) =>
                  (item.media_type === 'movie' || item.media_type === 'tv') &&
                  (String(item.job || '').toLowerCase() === 'director' ||
                    String(item.department || '').toLowerCase() === 'directing')
              )
            : (creditsRes.cast ?? []);

        const sorted = source
          .filter((item) => !!item.poster_path && item.vote_average > 0)
          .sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0));
        setPerson(personRes);
        setCredits(sorted);
      } catch {
        if (!mounted) return;
        setPerson(null);
        setCredits([]);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [favoriteKind, personId]);

  useEffect(() => {
    setBioExpanded(false);
  }, [personId]);

  useFocusEffect(
    useCallback(() => {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ y: 0, animated: false });
      });
    }, [])
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!user) {
        if (mounted) setIsFav(false);
        return;
      }
      const fav =
        favoriteKind === 'director'
          ? await isFavoriteDirector(user.id, personId)
          : await isFavoriteActor(user.id, personId);
      if (mounted) setIsFav(fav);
    })();
    return () => {
      mounted = false;
    };
  }, [favoriteKind, personId, user]);

  const topImage = useMemo(() => {
    if (!person) return undefined;
    return posterUrl(person.profile_path, 'w500') ?? undefined;
  }, [person]);

  if (loading) {
    return (
      <View style={[styles.loader, { backgroundColor: theme.background }]}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  if (!person) {
    return (
      <View style={[styles.loader, { backgroundColor: theme.background }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={20} color="#fff" />
        </Pressable>
        <Text style={styles.emptyText}>Person data is unavailable.</Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          {topImage ? <Image source={{ uri: topImage }} style={styles.heroImage} contentFit="cover" /> : null}
          <LinearGradient
            colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.35)', 'rgba(0,0,0,0.82)']}
            style={styles.heroFade}
          />
          <Pressable onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="chevron-back" size={20} color="#fff" />
          </Pressable>
        </View>

        <View style={styles.metaCard}>
          <View style={styles.metaHeader}>
            <View style={styles.metaTextWrap}>
              <Text style={styles.name}>{person.name}</Text>
              <Text style={styles.sub}>
                {favoriteKind === 'director' ? 'Director' : person.known_for_department || 'Acting'}
              </Text>
            </View>
            {user ? (
              <Pressable
                style={styles.favoriteBtn}
                onPress={async () => {
                  const next =
                    favoriteKind === 'director'
                      ? await toggleFavoriteDirector(user.id, personId)
                      : await toggleFavoriteActor(user.id, personId);
                  setIsFav(next);
                  if (next) {
                    const now = new Date().toISOString();
                    const payload: MlInteractionEvent[] = credits
                      .filter((item) => (item.media_type === 'movie' || item.media_type === 'tv') && item.id > 0)
                      .sort((a, b) => (b.vote_average ?? 0) - (a.vote_average ?? 0))
                      .slice(0, 24)
                      .map((item) => ({
                        user_id: user.id,
                        tmdb_id: item.id,
                        media_type: item.media_type,
                        event_type: 'favorite_actor',
                        event_value: item.vote_average ?? null,
                        occurred_at: now,
                      }));
                    void ingestMlInteractionsBatch(payload).catch(() => {});
                  }
                }}>
                <Ionicons name={isFav ? 'heart' : 'heart-outline'} size={18} color={isFav ? '#EF4444' : '#fff'} />
              </Pressable>
            ) : null}
          </View>

          {person.biography ? (
            <View style={styles.bioBlock}>
              <Text style={styles.bio} numberOfLines={bioExpanded ? undefined : 5}>
                {person.biography}
              </Text>
              <Pressable style={styles.bioToggle} onPress={() => setBioExpanded((prev) => !prev)}>
                <Text style={styles.bioToggleText}>{bioExpanded ? 'Show less' : 'Show more'}</Text>
                <Ionicons name={bioExpanded ? 'chevron-up' : 'chevron-down'} size={14} color="rgba(255,255,255,0.9)" />
              </Pressable>
            </View>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>TOP MOVIES AND TV SERIES</Text>
          {credits.length === 0 ? (
            <Text style={styles.emptyText}>No rated credits available.</Text>
          ) : (
            <View style={styles.grid}>
              {credits.map((item, idx) => {
                const title = item.media_type === 'movie' ? item.title : item.name;
                const year = (item.release_date ?? item.first_air_date ?? '').slice(0, 4);
                return (
                  <Pressable
                    key={`${item.media_type}-${item.id}-${idx}`}
                    style={styles.card}
                    onPress={() =>
                      router.push({
                        pathname: '/movie/[id]',
                        params: { id: String(item.id), type: item.media_type },
                      })
                    }>
                    <Image source={{ uri: posterUrl(item.poster_path, 'w342') ?? undefined }} style={styles.poster} contentFit="cover" />
                    <GlassView intensity={24} tint="dark" style={styles.cardGlass}>
                      <Text style={styles.cardRating}>{item.vote_average.toFixed(1)}</Text>
                    </GlassView>
                    <Text style={styles.cardTitle} numberOfLines={1}>
                      {title || 'Unknown'}
                    </Text>
                    <Text style={styles.cardMeta} numberOfLines={1}>
                      {(item.media_type === 'movie' ? 'Movie' : 'TV') + (year ? ` • ${year}` : '')}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  loader: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  scroll: { paddingBottom: 24 },
  hero: {
    height: 340,
    backgroundColor: 'rgba(255,255,255,0.06)',
    overflow: 'hidden',
  },
  heroImage: {
    width: '100%',
    height: '100%',
  },
  heroFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 180,
  },
  backBtn: {
    position: 'absolute',
    top: 48,
    left: 16,
    width: 38,
    height: 38,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  metaCard: {
    paddingHorizontal: Spacing.four,
    marginTop: -48,
    marginHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(0,0,0,0.58)',
  },
  metaHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  metaTextWrap: {
    flex: 1,
  },
  name: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 30,
  },
  sub: {
    color: 'rgba(255,255,255,0.72)',
    fontFamily: Fonts.mono,
    fontSize: 12,
  },
  bio: {
    color: 'rgba(255,255,255,0.76)',
    fontFamily: Fonts.serif,
    fontSize: 13,
    marginTop: 10,
  },
  bioBlock: {
    marginTop: 10,
  },
  bioToggle: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
  },
  bioToggleText: {
    color: 'rgba(255,255,255,0.9)',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  favoriteBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  section: {
    marginTop: Spacing.four,
    paddingHorizontal: Spacing.four,
  },
  sectionTitle: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 18,
    marginBottom: Spacing.two,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: 12,
  },
  card: {
    width: '23.2%',
    borderRadius: 10,
  },
  poster: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  cardGlass: {
    position: 'absolute',
    right: 4,
    top: 4,
    borderRadius: 8,
    paddingVertical: 3,
    paddingHorizontal: 6,
    backgroundColor: 'rgba(0,0,0,0.32)',
  },
  cardRating: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  cardTitle: {
    marginTop: 6,
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 11,
  },
  cardMeta: {
    marginTop: 1,
    color: 'rgba(255,255,255,0.76)',
    fontFamily: Fonts.mono,
    fontSize: 9,
  },
  emptyText: {
    color: 'rgba(255,255,255,0.66)',
    fontFamily: Fonts.serif,
    fontSize: 13,
  },
});
