import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';

import { Fonts, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import { getMovieById, getPersonById, getTvById, posterUrl } from '@/lib/tmdb';
import { getUserFavoriteGallery, type GalleryItem } from '@/db/gallery';
import {
  getUserFavoriteActors,
  getUserFavoriteDirectors,
  getUserFavorites,
  getUserRatings,
  getUserWatchlist,
  getUserWatched,
  UserActorListItem,
  UserListItem,
} from '@/db/user-movies';
import { getFollowingProfiles, getPublicProfile, type PublicProfile } from '@/lib/social-backend';

type ProfileMovieItem = {
  tmdbId: number;
  title: string;
  poster: string | null;
  mediaType: 'movie' | 'tv';
  rating?: number;
};

type ProfileActorItem = {
  personId: number;
  name: string;
  profile: string | null;
};

type ProfileGalleryItem = Pick<GalleryItem, 'id' | 'title' | 'image'>;
type ProfileSectionKey =
  | 'watchlist'
  | 'favorites'
  | 'actors'
  | 'directors'
  | 'shots'
  | 'watched'
  | 'rated'
  | 'following';

const PROFILE_LIST_LIMIT = 36;
const PROFILE_FETCH_CONCURRENCY = 4;

const PROFILE_SECTION_ORDER: ProfileSectionKey[] = [
  'favorites',
  'watchlist',
  'watched',
  'rated',
  'actors',
  'directors',
  'shots',
  'following',
];
const PUBLIC_SECTION_ORDER: ProfileSectionKey[] = [
  'favorites',
  'watchlist',
  'watched',
  'rated',
  'actors',
  'directors',
];

function isSectionKey(value: string | string[] | undefined): value is ProfileSectionKey {
  const raw = Array.isArray(value) ? value[0] : value;
  return !!raw && PROFILE_SECTION_ORDER.includes(raw as ProfileSectionKey);
}

function toPublicMovieItem(item: any): ProfileMovieItem | null {
  const tmdbId = Number(item?.tmdbId ?? item?.tmdb_id ?? 0);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return null;
  const mediaType = String(item?.mediaType ?? item?.media_type ?? '').toLowerCase() === 'tv' ? 'tv' : 'movie';
  const rating = Number(item?.rating);
  return {
    tmdbId,
    title: String(item?.title ?? item?.name ?? `TMDB #${tmdbId}`),
    poster: String(item?.poster ?? item?.poster_path ?? '').trim() || null,
    mediaType,
    rating: Number.isFinite(rating) ? rating : undefined,
  };
}

function toPublicActorItem(item: any): ProfileActorItem | null {
  const personId = Number(item?.personId ?? item?.person_id ?? 0);
  if (!Number.isFinite(personId) || personId <= 0) return null;
  return {
    personId,
    name: String(item?.name ?? `Person #${personId}`),
    profile: String(item?.profile ?? item?.avatar_url ?? item?.poster ?? '').trim() || null,
  };
}

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

export default function ProfileListsScreen() {
  const { user } = useAuth();
  const params = useLocalSearchParams<{ section?: string; userId?: string }>();
  const requestedSection = isSectionKey(params.section) ? params.section : 'favorites';
  const currentUserId = Number(user?.id ?? 0);
  const requestedUserId = Number(params.userId ?? 0);
  const isPublicView = Number.isFinite(requestedUserId) && requestedUserId > 0 && requestedUserId !== currentUserId;
  const viewUserId = isPublicView ? requestedUserId : currentUserId;

  const [activeSection, setActiveSection] = useState<ProfileSectionKey>(requestedSection);
  const [loading, setLoading] = useState(false);
  const [watchlistItems, setWatchlistItems] = useState<ProfileMovieItem[]>([]);
  const [favoriteItems, setFavoriteItems] = useState<ProfileMovieItem[]>([]);
  const [favoriteActorItems, setFavoriteActorItems] = useState<ProfileActorItem[]>([]);
  const [favoriteDirectorItems, setFavoriteDirectorItems] = useState<ProfileActorItem[]>([]);
  const [favoriteGalleryItems, setFavoriteGalleryItems] = useState<ProfileGalleryItem[]>([]);
  const [watchedItems, setWatchedItems] = useState<ProfileMovieItem[]>([]);
  const [ratedItems, setRatedItems] = useState<ProfileMovieItem[]>([]);
  const [followingTaste, setFollowingTaste] = useState<PublicProfile[]>([]);

  const detailsCacheRef = useRef<Map<string, ProfileMovieItem>>(new Map());
  const inFlightRef = useRef<Map<string, Promise<ProfileMovieItem | null>>>(new Map());
  const invalidKeysRef = useRef<Set<string>>(new Set());
  const actorCacheRef = useRef<Map<number, ProfileActorItem>>(new Map());
  const actorInFlightRef = useRef<Map<number, Promise<ProfileActorItem | null>>>(new Map());
  const activeUserIdRef = useRef<number | null>(null);
  const sectionOrder = isPublicView ? PUBLIC_SECTION_ORDER : PROFILE_SECTION_ORDER;

  useEffect(() => {
    if (isSectionKey(params.section)) {
      setActiveSection(params.section);
    }
  }, [params.section]);

  useEffect(() => {
    activeUserIdRef.current = viewUserId > 0 ? viewUserId : null;
  }, [viewUserId]);

  useEffect(() => {
    if (!isPublicView) return;
    if (!PUBLIC_SECTION_ORDER.includes(activeSection)) {
      setActiveSection('favorites');
    }
  }, [activeSection, isPublicView]);

  const sectionMeta = useMemo(
    () => ({
      watchlist: { title: 'Watchlist', count: watchlistItems.length, icon: 'bookmark' as const },
      favorites: { title: 'Favorites', count: favoriteItems.length, icon: 'heart' as const },
      actors: { title: 'Actors', count: favoriteActorItems.length, icon: 'people' as const },
      directors: { title: 'Directors', count: favoriteDirectorItems.length, icon: 'film' as const },
      shots: { title: 'Shots', count: favoriteGalleryItems.length, icon: 'aperture' as const },
      watched: { title: 'Watched', count: watchedItems.length, icon: 'checkmark-circle' as const },
      rated: { title: 'Rated', count: ratedItems.length, icon: 'star' as const },
      following: { title: 'Following', count: followingTaste.length, icon: 'person-add' as const },
    }),
    [
      favoriteActorItems.length,
      favoriteDirectorItems.length,
      favoriteGalleryItems.length,
      favoriteItems.length,
      followingTaste.length,
      ratedItems.length,
      watchedItems.length,
      watchlistItems.length,
    ]
  );

  const resolveMovieItem = useCallback(async (row: UserListItem): Promise<ProfileMovieItem | null> => {
    const preferredType = row.mediaType === 'tv' ? 'tv' : 'movie';
    const key = `${preferredType}:${row.tmdbId}`;
    if (invalidKeysRef.current.has(key)) return null;

    const cached = detailsCacheRef.current.get(key);
    if (cached) return { ...cached, rating: row.rating };

    const inFlight = inFlightRef.current.get(key);
    if (inFlight) {
      const resolved = await inFlight;
      return resolved ? { ...resolved, rating: row.rating } : null;
    }

    const task = (async (): Promise<ProfileMovieItem | null> => {
      try {
        if (preferredType === 'tv') {
          const tv = await getTvById(row.tmdbId);
          const resolved = {
            tmdbId: row.tmdbId,
            title: tv.name,
            poster: posterUrl(tv.poster_path, 'w185'),
            mediaType: 'tv' as const,
            rating: row.rating,
          };
          detailsCacheRef.current.set(key, resolved);
          return resolved;
        }
        const movie = await getMovieById(row.tmdbId);
        const resolved = {
          tmdbId: row.tmdbId,
          title: movie.title,
          poster: posterUrl(movie.poster_path, 'w185'),
          mediaType: 'movie' as const,
          rating: row.rating,
        };
        detailsCacheRef.current.set(key, resolved);
        return resolved;
      } catch {
        try {
          const fallback =
            preferredType === 'tv' ? await getMovieById(row.tmdbId) : await getTvById(row.tmdbId);
          const resolved = {
            tmdbId: row.tmdbId,
            title: 'title' in fallback ? fallback.title : fallback.name,
            poster: posterUrl(fallback.poster_path, 'w185'),
            mediaType: 'title' in fallback ? ('movie' as const) : ('tv' as const),
            rating: row.rating,
          };
          detailsCacheRef.current.set(`${resolved.mediaType}:${row.tmdbId}`, resolved);
          return resolved;
        } catch {
          invalidKeysRef.current.add(key);
          return null;
        }
      }
    })();

    inFlightRef.current.set(key, task);
    try {
      const resolved = await task;
      return resolved ? { ...resolved, rating: row.rating } : null;
    } finally {
      inFlightRef.current.delete(key);
    }
  }, []);

  const resolveActorItem = useCallback(async (row: UserActorListItem): Promise<ProfileActorItem | null> => {
    const cached = actorCacheRef.current.get(row.personId);
    if (cached) return cached;

    const inFlight = actorInFlightRef.current.get(row.personId);
    if (inFlight) return inFlight;

    const task = (async (): Promise<ProfileActorItem | null> => {
      try {
        const person = await getPersonById(row.personId);
        const resolved = {
          personId: row.personId,
          name: person.name || `Person #${row.personId}`,
          profile: posterUrl(person.profile_path, 'w185'),
        };
        actorCacheRef.current.set(row.personId, resolved);
        return resolved;
      } catch {
        return null;
      }
    })();

    actorInFlightRef.current.set(row.personId, task);
    try {
      return await task;
    } finally {
      actorInFlightRef.current.delete(row.personId);
    }
  }, []);

  const loadLists = useCallback(
    async (options?: { silent?: boolean }) => {
      const targetUserId = Number(viewUserId);
      if (!Number.isFinite(targetUserId) || targetUserId <= 0) return;
      const silent = !!options?.silent;

      if (!silent) setLoading(true);
      try {
        if (isPublicView) {
          const publicProfile = await getPublicProfile(targetUserId);
          if (activeUserIdRef.current !== targetUserId) return;

          if (!publicProfile) {
            setWatchlistItems([]);
            setFavoriteItems([]);
            setFavoriteActorItems([]);
            setFavoriteDirectorItems([]);
            setFavoriteGalleryItems([]);
            setWatchedItems([]);
            setRatedItems([]);
            setFollowingTaste([]);
            return;
          }

          setWatchlistItems((publicProfile.watchlist ?? []).map(toPublicMovieItem).filter((item): item is ProfileMovieItem => !!item));
          setFavoriteItems((publicProfile.favorites ?? []).map(toPublicMovieItem).filter((item): item is ProfileMovieItem => !!item));
          setFavoriteActorItems((publicProfile.favorite_actors ?? []).map(toPublicActorItem).filter((item): item is ProfileActorItem => !!item));
          setFavoriteDirectorItems((publicProfile.favorite_directors ?? []).map(toPublicActorItem).filter((item): item is ProfileActorItem => !!item));
          setFavoriteGalleryItems([]);
          setWatchedItems((publicProfile.watched ?? []).map(toPublicMovieItem).filter((item): item is ProfileMovieItem => !!item));
          setRatedItems((publicProfile.rated ?? []).map(toPublicMovieItem).filter((item): item is ProfileMovieItem => !!item));
          setFollowingTaste([]);
          return;
        }

        const followingPromise = getFollowingProfiles(targetUserId).catch(() => []);
        const [watchRows, favRows, actorRows, directorRows, watchedRows, ratedRows, galleryRows] =
          await Promise.all([
            getUserWatchlist(targetUserId),
            getUserFavorites(targetUserId),
            getUserFavoriteActors(targetUserId),
            getUserFavoriteDirectors(targetUserId),
            getUserWatched(targetUserId),
            getUserRatings(targetUserId),
            getUserFavoriteGallery(targetUserId),
          ]);

        const limitedWatchRows = watchRows.slice(0, PROFILE_LIST_LIMIT);
        const limitedFavRows = favRows.slice(0, PROFILE_LIST_LIMIT);
        const limitedActorRows = actorRows.slice(0, PROFILE_LIST_LIMIT);
        const limitedDirectorRows = directorRows.slice(0, PROFILE_LIST_LIMIT);
        const limitedWatchedRows = watchedRows.slice(0, PROFILE_LIST_LIMIT);
        const limitedRatedRows = ratedRows.slice(0, PROFILE_LIST_LIMIT);

        const [watchData, favData, actorData, directorData, watchedData, ratedData] = await Promise.all([
          mapWithConcurrency(limitedWatchRows, PROFILE_FETCH_CONCURRENCY, (row) => resolveMovieItem(row)),
          mapWithConcurrency(limitedFavRows, PROFILE_FETCH_CONCURRENCY, (row) => resolveMovieItem(row)),
          mapWithConcurrency(limitedActorRows, PROFILE_FETCH_CONCURRENCY, (row) => resolveActorItem(row)),
          mapWithConcurrency(limitedDirectorRows, PROFILE_FETCH_CONCURRENCY, (row) => resolveActorItem(row)),
          mapWithConcurrency(limitedWatchedRows, PROFILE_FETCH_CONCURRENCY, (row) => resolveMovieItem(row)),
          mapWithConcurrency(limitedRatedRows, PROFILE_FETCH_CONCURRENCY, (row) => resolveMovieItem(row)),
        ]);

        if (activeUserIdRef.current !== targetUserId) return;

        setWatchlistItems(watchData.filter((item): item is ProfileMovieItem => !!item));
        setFavoriteItems(favData.filter((item): item is ProfileMovieItem => !!item));
        setFavoriteActorItems(actorData.filter((item): item is ProfileActorItem => !!item));
        setFavoriteDirectorItems(directorData.filter((item): item is ProfileActorItem => !!item));
        setFavoriteGalleryItems(galleryRows.map((item) => ({ id: item.id, title: item.title, image: item.image })));
        setWatchedItems(watchedData.filter((item): item is ProfileMovieItem => !!item));
        setRatedItems(ratedData.filter((item): item is ProfileMovieItem => !!item));
        const following = await followingPromise;
        if (activeUserIdRef.current !== targetUserId) return;
        setFollowingTaste(following);
      } catch {
        if (activeUserIdRef.current !== targetUserId) return;
        setWatchlistItems([]);
        setFavoriteItems([]);
        setFavoriteActorItems([]);
        setFavoriteDirectorItems([]);
        setFavoriteGalleryItems([]);
        setWatchedItems([]);
        setRatedItems([]);
        setFollowingTaste([]);
      } finally {
        if (activeUserIdRef.current === targetUserId && !silent) {
          setLoading(false);
        }
      }
    },
    [isPublicView, resolveActorItem, resolveMovieItem, viewUserId]
  );

  useEffect(() => {
    setWatchlistItems([]);
    setFavoriteItems([]);
    setFavoriteActorItems([]);
    setFavoriteDirectorItems([]);
    setFavoriteGalleryItems([]);
    setWatchedItems([]);
    setRatedItems([]);
    setFollowingTaste([]);
    if (viewUserId > 0) {
      void loadLists();
    } else {
      setLoading(false);
    }
  }, [loadLists, viewUserId]);

  useFocusEffect(
    useCallback(() => {
      if (viewUserId > 0) {
        void loadLists({ silent: true });
      }
    }, [loadLists, viewUserId])
  );

  const activeMovieItems = useMemo(() => {
    if (activeSection === 'favorites') return favoriteItems;
    if (activeSection === 'watchlist') return watchlistItems;
    if (activeSection === 'watched') return watchedItems;
    if (activeSection === 'rated') return ratedItems;
    return [];
  }, [activeSection, favoriteItems, watchlistItems, watchedItems, ratedItems]);

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={['#05060A', '#090E16', '#06070A']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.bg}
      />

      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={18} color="#fff" />
        </Pressable>
        <Text style={styles.headerTitle}>{sectionMeta[activeSection].title}</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipsRow}>
          {sectionOrder.map((key) => (
            <Pressable
              key={key}
              onPress={() => setActiveSection(key)}
              style={[styles.chip, activeSection === key ? styles.chipActive : null]}>
              <Ionicons
                name={sectionMeta[key].icon}
                size={14}
                color={activeSection === key ? '#FFFFFF' : 'rgba(255,255,255,0.8)'}
              />
              <Text style={styles.chipText}>{sectionMeta[key].title}</Text>
              <Text style={styles.chipCount}>{sectionMeta[key].count}</Text>
            </Pressable>
          ))}
        </ScrollView>

        {loading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator color="#fff" />
          </View>
        ) : null}

        {!loading &&
        (activeSection === 'favorites' ||
          activeSection === 'watchlist' ||
          activeSection === 'watched' ||
          activeSection === 'rated') ? (
          <>
            {activeMovieItems.length === 0 ? (
              <Text style={styles.emptyText}>No movies yet.</Text>
            ) : (
              <View style={styles.movieGrid}>
                {activeMovieItems.map((item) => (
                  <Pressable
                    key={`${activeSection}-${item.tmdbId}`}
                    style={styles.movieCard}
                    onPress={() =>
                      router.push({
                        pathname: '/movie/[id]',
                        params: { id: String(item.tmdbId), type: item.mediaType },
                      })
                    }>
                    {item.poster ? (
                      <Image source={{ uri: item.poster }} style={styles.moviePoster} />
                    ) : (
                      <View style={styles.moviePosterFallback} />
                    )}
                    <Text style={styles.movieTitle} numberOfLines={2}>
                      {item.title}
                    </Text>
                    {typeof item.rating === 'number' ? (
                      <Text style={styles.movieMeta}>{item.rating}/10</Text>
                    ) : null}
                  </Pressable>
                ))}
              </View>
            )}
          </>
        ) : null}

        {!loading && (activeSection === 'actors' || activeSection === 'directors') ? (
          <>
            {(activeSection === 'actors' ? favoriteActorItems : favoriteDirectorItems).length === 0 ? (
              <Text style={styles.emptyText}>No people saved yet.</Text>
            ) : (
              <View style={styles.actorGrid}>
                {(activeSection === 'actors' ? favoriteActorItems : favoriteDirectorItems).map((item) => (
                  <Pressable
                    key={`${activeSection}-${item.personId}`}
                    style={styles.actorCard}
                    onPress={() =>
                      router.push({
                        pathname: '/person/[id]',
                        params: {
                          id: String(item.personId),
                          role: activeSection === 'actors' ? 'actor' : 'director',
                        },
                      })
                    }>
                    {item.profile ? (
                      <Image source={{ uri: item.profile }} style={styles.actorImage} />
                    ) : (
                      <View style={styles.actorFallback} />
                    )}
                    <Text style={styles.actorName} numberOfLines={2}>
                      {item.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </>
        ) : null}

        {!loading && activeSection === 'shots' ? (
          <>
            {favoriteGalleryItems.length === 0 ? (
              <Text style={styles.emptyText}>No saved shots yet.</Text>
            ) : (
              <View style={styles.shotGrid}>
                {favoriteGalleryItems.map((item) => (
                  <Pressable
                    key={`shot-${item.id}`}
                    style={styles.shotCard}
                    onPress={() =>
                      router.push({
                        pathname: '/gallery',
                        params: { open: String(item.id) },
                      })
                    }>
                    <Image source={{ uri: item.image }} style={styles.shotImage} />
                    <Text style={styles.shotTitle} numberOfLines={2}>
                      {item.title}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </>
        ) : null}

        {!loading && activeSection === 'following' ? (
          <>
            {followingTaste.length === 0 ? (
              <Text style={styles.emptyText}>You do not follow anyone yet.</Text>
            ) : (
              <View style={styles.followList}>
                {followingTaste.map((item) => (
                  <Pressable
                    key={`follow-${item.user_id}`}
                    style={styles.followRow}
                    onPress={() => router.push(`/user/${item.user_id}` as any)}>
                    {item.avatar_url ? (
                      <Image source={{ uri: item.avatar_url }} style={styles.followAvatar} />
                    ) : (
                      <View style={styles.followAvatarFallback}>
                        <Text style={styles.followAvatarFallbackText}>?</Text>
                      </View>
                    )}
                    <View style={styles.followMeta}>
                      <Text style={styles.followName}>@{item.nickname}</Text>
                      <Text style={styles.followSub}>{item.followers} followers</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={15} color="rgba(255,255,255,0.8)" />
                  </Pressable>
                ))}
              </View>
            )}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#05070C',
  },
  bg: {
    ...StyleSheet.absoluteFillObject,
  },
  header: {
    paddingTop: 58,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.26)',
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 15,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  headerSpacer: {
    width: 38,
    height: 38,
  },
  content: {
    paddingHorizontal: Spacing.three,
    paddingBottom: 120,
    gap: 12,
  },
  chipsRow: {
    gap: 8,
    paddingRight: 6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(10,14,20,0.8)',
    paddingVertical: 8,
    paddingHorizontal: 11,
  },
  chipActive: {
    borderColor: 'rgba(226,230,255,0.68)',
    backgroundColor: 'rgba(37,47,70,0.86)',
  },
  chipText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  chipCount: {
    color: 'rgba(255,255,255,0.84)',
    fontFamily: Fonts.mono,
    fontSize: 9,
  },
  loadingWrap: {
    paddingVertical: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    marginTop: 6,
    color: 'rgba(255,255,255,0.68)',
    fontFamily: Fonts.serif,
    fontSize: 13,
  },
  movieGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 9,
  },
  movieCard: {
    width: '31.5%',
  },
  moviePoster: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: 9,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  moviePosterFallback: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: 9,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  movieTitle: {
    marginTop: 5,
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 12,
    lineHeight: 14,
  },
  movieMeta: {
    marginTop: 2,
    color: 'rgba(255,255,255,0.72)',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  actorGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  actorCard: {
    width: '23%',
    alignItems: 'center',
  },
  actorImage: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  actorFallback: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  actorName: {
    marginTop: 6,
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 10,
    textAlign: 'center',
  },
  shotGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  shotCard: {
    width: '48.5%',
  },
  shotImage: {
    width: '100%',
    height: 150,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  shotTitle: {
    marginTop: 6,
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 12,
  },
  followList: {
    gap: 8,
  },
  followRow: {
    borderRadius: 13,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(11,14,21,0.78)',
    minHeight: 56,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  followAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  followAvatarFallback: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  followAvatarFallbackText: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 18,
  },
  followMeta: {
    flex: 1,
  },
  followName: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 12,
  },
  followSub: {
    marginTop: 2,
    color: 'rgba(255,255,255,0.72)',
    fontFamily: Fonts.serif,
    fontSize: 12,
  },
});
