import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { router } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '@/contexts/AuthContext';
import { GlassView } from '@/components/glass-view';
import { Fonts, Spacing } from '@/constants/theme';
import { getMovieById, getPersonById, getTvById, posterUrl } from '@/lib/tmdb';
import { getUserFavoriteGallery, type GalleryItem } from '@/db/gallery';
import {
  getUserListPrivacy,
  getUserFavoriteActors,
  getUserFavoriteDirectors,
  getUserFavorites,
  getUserRatings,
  getUserWatchlist,
  getUserWatched,
  UserActorListItem,
  UserListItem,
} from '@/db/user-movies';
import { getFollowingProfiles, syncPublicProfile, type PublicProfile } from '@/lib/social-backend';

type PrivacyState = {
  watchlist: boolean;
  favorites: boolean;
  watched: boolean;
  rated: boolean;
};

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
const PROFILE_SYNC_DEBOUNCE_MS = 1800;
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
const PROFILE_HERO_IMAGE_VERTICAL_SHIFT = 0;

function buildUnifiedPrivacy(isPublic: boolean): PrivacyState {
  return {
    watchlist: isPublic,
    favorites: isPublic,
    watched: isPublic,
    rated: isPublic,
  };
}

function normalizeUnifiedPrivacy(input: PrivacyState): PrivacyState {
  const isPublic = !!input.watchlist && !!input.favorites && !!input.watched && !!input.rated;
  return buildUnifiedPrivacy(isPublic);
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

export default function ProfileScreen() {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const heroTopOffset = useMemo(
    () => Math.max(8, Math.min(16, insets.top * 0.35)),
    [insets.top]
  );
  const detailsCacheRef = useRef<Map<string, ProfileMovieItem>>(new Map());
  const inFlightRef = useRef<Map<string, Promise<ProfileMovieItem | null>>>(new Map());
  const invalidKeysRef = useRef<Set<string>>(new Set());
  const actorCacheRef = useRef<Map<number, ProfileActorItem>>(new Map());
  const actorInFlightRef = useRef<Map<number, Promise<ProfileActorItem | null>>>(new Map());
  const activeUserIdRef = useRef<number | null>(null);
  const loadedUserIdRef = useRef<number | null>(null);
  const lastListsLoadAtRef = useRef(0);
  const lastSyncedSignatureRef = useRef('');
  const heroOpacity = useRef(new Animated.Value(0)).current;
  const heroTranslateY = useRef(new Animated.Value(16)).current;
  const bodyOpacity = useRef(new Animated.Value(0)).current;
  const bodyTranslateY = useRef(new Animated.Value(24)).current;
  const runEnterAnimation = useCallback(() => {
    heroOpacity.setValue(0);
    heroTranslateY.setValue(16);
    bodyOpacity.setValue(0);
    bodyTranslateY.setValue(24);
    Animated.sequence([
      Animated.parallel([
        Animated.timing(heroOpacity, {
          toValue: 1,
          duration: 280,
          useNativeDriver: true,
        }),
        Animated.timing(heroTranslateY, {
          toValue: 0,
          duration: 320,
          useNativeDriver: true,
        }),
      ]),
      Animated.parallel([
        Animated.timing(bodyOpacity, {
          toValue: 1,
          duration: 320,
          useNativeDriver: true,
        }),
        Animated.timing(bodyTranslateY, {
          toValue: 0,
          duration: 360,
          useNativeDriver: true,
        }),
      ]),
    ]).start();
  }, [bodyOpacity, bodyTranslateY, heroOpacity, heroTranslateY]);

  const [privacy, setPrivacy] = useState<PrivacyState>({
    watchlist: false,
    favorites: false,
    watched: false,
    rated: false,
  });
  const [loadingLists, setLoadingLists] = useState(false);
  const [watchlistItems, setWatchlistItems] = useState<ProfileMovieItem[]>([]);
  const [favoriteItems, setFavoriteItems] = useState<ProfileMovieItem[]>([]);
  const [favoriteActorItems, setFavoriteActorItems] = useState<ProfileActorItem[]>([]);
  const [favoriteDirectorItems, setFavoriteDirectorItems] = useState<ProfileActorItem[]>([]);
  const [favoriteGalleryItems, setFavoriteGalleryItems] = useState<ProfileGalleryItem[]>([]);
  const [watchedItems, setWatchedItems] = useState<ProfileMovieItem[]>([]);
  const [ratedItems, setRatedItems] = useState<ProfileMovieItem[]>([]);
  const [followingTaste, setFollowingTaste] = useState<PublicProfile[]>([]);
  const scrollRef = useRef<ScrollView | null>(null);
  const scrollY = useRef(new Animated.Value(0)).current;
  const heroScrollTranslateY = useMemo(
    () =>
      scrollY.interpolate({
        inputRange: [0, 260],
        outputRange: [0, -86],
        extrapolate: 'clamp',
      }),
    [scrollY]
  );
  const heroScrollScale = useMemo(
    () =>
      scrollY.interpolate({
        inputRange: [-160, 0],
        outputRange: [1.16, 1],
        extrapolate: 'clamp',
      }),
    [scrollY]
  );
  const heroScrollOpacity = useMemo(
    () =>
      scrollY.interpolate({
        inputRange: [0, 260],
        outputRange: [1, 0.72],
        extrapolate: 'clamp',
      }),
    [scrollY]
  );
  const nickname = user?.nickname ?? 'nickname';
  const bio = (user as any)?.bio ?? '';
  const avatarUrl = ((user as any)?.avatar_url ?? '').trim();
  const hasAvatar = !!avatarUrl;

  const fullName = useMemo(() => {
    const base = `${user?.name ?? ''}`.trim();
    return base.length ? base : 'User name';
  }, [user?.name]);

  const sectionMeta = useMemo(
    () => ({
      favorites: { title: 'Favorites', count: favoriteItems.length, icon: 'heart' as const, blurb: 'The titles that define your taste immediately.' },
      watchlist: { title: 'Watchlist', count: watchlistItems.length, icon: 'bookmark' as const, blurb: 'A queue of films and shows waiting for a night in.' },
      actors: { title: 'Actors', count: favoriteActorItems.length, icon: 'people' as const, blurb: 'Faces and performances you return to often.' },
      directors: { title: 'Directors', count: favoriteDirectorItems.length, icon: 'film' as const, blurb: 'Authors shaping the mood of your library.' },
      shots: { title: 'Shots', count: favoriteGalleryItems.length, icon: 'aperture' as const, blurb: 'Frames, stills and visuals saved for atmosphere.' },
      watched: { title: 'Watched', count: watchedItems.length, icon: 'checkmark-circle' as const, blurb: 'Your completed trail through movies and series.' },
      rated: { title: 'Rated', count: ratedItems.length, icon: 'star' as const, blurb: 'The opinions that teach the engine who you are.' },
      following: { title: 'Following', count: followingTaste.length, icon: 'person-add' as const, blurb: 'People whose taste keeps nudging your own.' },
    }),
    [
      favoriteActorItems.length,
      favoriteDirectorItems.length,
      favoriteGalleryItems.length,
      favoriteItems.length,
      followingTaste.length,
      watchlistItems.length,
      watchedItems.length,
      ratedItems.length,
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
          const fallback = preferredType === 'tv' ? await getMovieById(row.tmdbId) : await getTvById(row.tmdbId);
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
          name: person.name || `Actor #${row.personId}`,
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

  const loadLists = useCallback(async (options?: { silent?: boolean }) => {
    if (!user) return;
    const targetUserId = Number(user.id);
    if (!Number.isFinite(targetUserId) || targetUserId <= 0) return;
    const silent = !!options?.silent;

    if (!silent) setLoadingLists(true);
    loadedUserIdRef.current = null;
    try {
      const followingPromise = getFollowingProfiles(targetUserId).catch(() => []);
      const [watchRows, favRows, actorRows, directorRows, watchedRows, ratedRows, savedPrivacy, galleryRows] = await Promise.all([
        getUserWatchlist(targetUserId),
        getUserFavorites(targetUserId),
        getUserFavoriteActors(targetUserId),
        getUserFavoriteDirectors(targetUserId),
        getUserWatched(targetUserId),
        getUserRatings(targetUserId),
        getUserListPrivacy(targetUserId),
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
      setPrivacy(normalizeUnifiedPrivacy(savedPrivacy));
      const following = await followingPromise;
      if (activeUserIdRef.current !== targetUserId) return;
      setFollowingTaste(following);
      loadedUserIdRef.current = targetUserId;
      lastListsLoadAtRef.current = Date.now();
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
      setPrivacy(buildUnifiedPrivacy(false));
    } finally {
      if (activeUserIdRef.current === targetUserId && !silent) {
        setLoadingLists(false);
      }
    }
  }, [resolveActorItem, resolveMovieItem, user]);

  const isTastePublic = privacy.watchlist && privacy.favorites && privacy.watched && privacy.rated;

  const openListSection = useCallback((key: ProfileSectionKey) => {
    router.push({
      pathname: '/profile-lists' as any,
      params: { section: key },
    });
  }, []);

  useEffect(() => {
    activeUserIdRef.current = user?.id ?? null;
  }, [user?.id]);

  useEffect(() => {
    lastSyncedSignatureRef.current = '';
    loadedUserIdRef.current = null;
    lastListsLoadAtRef.current = 0;
    setWatchlistItems([]);
    setFavoriteItems([]);
    setFavoriteActorItems([]);
    setFavoriteDirectorItems([]);
    setFavoriteGalleryItems([]);
    setWatchedItems([]);
    setRatedItems([]);
    setFollowingTaste([]);
    setPrivacy(buildUnifiedPrivacy(false));
    if (user?.id) {
      void loadLists();
    } else {
      setLoadingLists(false);
    }
  }, [loadLists, user?.id]);

  useEffect(() => {
    if (!user || loadingLists) return;
    if (loadedUserIdRef.current !== user.id) return;
    const signature = JSON.stringify({
      user_id: user.id,
      privacy,
      watchlist: watchlistItems.map((item) => `${item.tmdbId}:${item.mediaType}`),
      favorites: favoriteItems.map((item) => `${item.tmdbId}:${item.mediaType}`),
      watched: watchedItems.map((item) => `${item.tmdbId}:${item.mediaType}`),
      rated: ratedItems.map((item) => `${item.tmdbId}:${item.rating ?? ''}:${item.mediaType}`),
      favorite_actors: favoriteActorItems.map((item) => item.personId),
      favorite_directors: favoriteDirectorItems.map((item) => item.personId),
    });
    if (signature === lastSyncedSignatureRef.current) return;

    const payload = {
      user_id: user.id,
      nickname: user.nickname,
      name: user.name,
      bio: (user as any)?.bio ?? null,
      avatar_url: (user as any)?.avatar_url ?? null,
      privacy: {
        watchlist: privacy.watchlist,
        favorites: privacy.favorites,
        watched: privacy.watched,
        rated: privacy.rated,
        favorite_actors: isTastePublic,
        favorite_directors: isTastePublic,
      },
      watchlist: watchlistItems,
      favorites: favoriteItems,
      watched: watchedItems,
      rated: ratedItems,
      favorite_actors: favoriteActorItems,
      favorite_directors: favoriteDirectorItems,
    };
    const timer = setTimeout(() => {
      lastSyncedSignatureRef.current = signature;
      void syncPublicProfile(payload).catch(() => {});
    }, PROFILE_SYNC_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    favoriteActorItems,
    favoriteDirectorItems,
    favoriteItems,
    isTastePublic,
    loadingLists,
    privacy,
    ratedItems,
    user,
    watchedItems,
    watchlistItems,
  ]);

  useFocusEffect(
    useCallback(() => {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ y: 0, animated: false });
      });
      runEnterAnimation();
      if (user?.id) {
        void loadLists({ silent: true });
      }
    }, [loadLists, runEnterAnimation, user?.id])
  );

  useEffect(() => {
    runEnterAnimation();
  }, [runEnterAnimation, user?.id]);

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={['#040507', '#06080D', '#08080A']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.screenGradient}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}>
        <Animated.ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.scroll}
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: true }
          )}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}>
          <Animated.View
            style={[
              styles.heroStage,
              { marginTop: heroTopOffset, opacity: heroOpacity, transform: [{ translateY: heroTranslateY }] },
            ]}>
            <Animated.View
              style={[
                styles.heroImageShell,
                {
                  transform: [{ translateY: heroScrollTranslateY }, { scale: heroScrollScale }],
                  opacity: heroScrollOpacity,
                },
              ]}>
              <View style={styles.heroImage}>
                {hasAvatar ? (
                  <Image source={{ uri: avatarUrl }} style={[styles.heroImageInner, styles.heroImageInnerShift]} />
                ) : (
                  <View style={styles.heroPlaceholder}>
                    <Text style={styles.heroPlaceholderText}>?</Text>
                  </View>
                )}
                <View style={[styles.heroTopActions, { top: insets.top + 12 }]}>
                  <Pressable
                    onPress={() => router.push('/profile-settings' as any)}
                    style={styles.settingsIconBtn}>
                    <Ionicons name="settings-outline" size={18} color="#fff" />
                  </Pressable>
                </View>
              </View>
            </Animated.View>

            <View style={styles.profileMetaBlock}>
              <LinearGradient
                colors={['rgba(255,255,255,0.05)', 'rgba(255,255,255,0)', 'rgba(126,24,43,0.1)']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.profileMetaSheen}
              />
              <View style={styles.profileMetaOrbLeft} pointerEvents="none" />
              <View style={styles.profileMetaOrbRight} pointerEvents="none" />
              <View style={styles.profileControlsRow}>
                <View
                  style={[
                    styles.visibilityToggle,
                    isTastePublic ? styles.visibilityTogglePublic : styles.visibilityTogglePrivate,
                  ]}>
                  <Ionicons
                    name={isTastePublic ? 'eye-outline' : 'lock-closed-outline'}
                    size={13}
                    color="#fff"
                  />
                  <Text style={styles.visibilityToggleText}>
                    {isTastePublic ? 'Taste public' : 'Taste private'}
                  </Text>
                </View>
                <Pressable onPress={() => router.push('/profile-edit')} style={styles.editBtn}>
                  <Ionicons name="create-outline" size={13} color="#fff" />
                  <Text style={styles.editBtnText}>Edit profile</Text>
                </Pressable>
              </View>
              <Text style={styles.profileKicker}>Curated identity</Text>
              <Text style={styles.name}>{fullName}</Text>
              <View style={styles.identityLine}>
                <Text style={styles.nickname}>@{nickname}</Text>
                <View style={styles.identityDivider} />
                <Text style={styles.identityTag}>taste journal</Text>
              </View>
              <Text style={styles.bio} numberOfLines={3}>
                {bio || 'Design your taste profile and share it with others.'}
              </Text>
              <View style={styles.statsRow}>
                <Pressable onPress={() => openListSection('favorites')} style={styles.statCard}>
                  <Text style={styles.statValue}>{favoriteItems.length}</Text>
                  <Text style={styles.statLabel}>Favorites</Text>
                </Pressable>
                <View style={styles.statsDivider} />
                <Pressable onPress={() => openListSection('watched')} style={styles.statCard}>
                  <Text style={styles.statValue}>{watchedItems.length}</Text>
                  <Text style={styles.statLabel}>Watched</Text>
                </Pressable>
                <View style={styles.statsDivider} />
                <Pressable onPress={() => openListSection('following')} style={styles.statCard}>
                  <Text style={styles.statValue}>{followingTaste.length}</Text>
                  <Text style={styles.statLabel}>Following</Text>
                </Pressable>
              </View>
            </View>
          </Animated.View>

          <Animated.View
            style={[
              styles.sectionRailWrap,
              { opacity: bodyOpacity, transform: [{ translateY: bodyTranslateY }] },
            ]}>
            <View style={styles.sectionRailHeader}>
              <Text style={styles.sectionRailTitle}>Your Lists</Text>
              <Text style={styles.sectionRailSubtitle}>
                Scroll through the lanes that define your current taste and social orbit.
              </Text>
            </View>
            <View style={styles.sectionGrid}>
              {PROFILE_SECTION_ORDER.map((key, index) => (
                <Pressable
                  key={key}
                  onPress={() => openListSection(key)}
                  style={[
                    styles.sectionTile,
                    index % 3 === 0 ? styles.sectionTileWide : styles.sectionTileHalf,
                    index % 3 === 1 ? styles.sectionTileLifted : null,
                  ]}>
                  <GlassView intensity={28} tint="dark" style={styles.sectionTileGlass}>
                    <LinearGradient
                      colors={['rgba(255,255,255,0.12)', 'rgba(255,255,255,0)', 'rgba(255,255,255,0)']}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 0.85 }}
                      style={styles.sectionTileGloss}
                    />
                    <Text style={styles.sectionTileGhostCount}>
                      {String(sectionMeta[key].count).padStart(2, '0')}
                    </Text>
                    <View style={styles.sectionTileTop}>
                      <View style={styles.sectionTileLeft}>
                        <Ionicons
                          name={sectionMeta[key].icon}
                          size={15}
                          color="rgba(255,255,255,0.84)"
                        />
                        <Text style={styles.sectionTileTitle}>{sectionMeta[key].title}</Text>
                      </View>
                      <View style={styles.sectionTileCountPill}>
                        <Text style={styles.sectionTileCount}>{sectionMeta[key].count}</Text>
                      </View>
                    </View>
                    <Text style={styles.sectionTileBlurb}>{sectionMeta[key].blurb}</Text>
                  </GlassView>
                </Pressable>
              ))}
            </View>
            <View style={styles.sectionFooterRule} />
            <View style={styles.sectionFooterGlow} />
              {loadingLists ? (
                <View style={styles.sectionLoadingWrap}>
                  <ActivityIndicator color="#fff" />
                </View>
              ) : null}
              {!loadingLists && !favoriteItems.length && !watchlistItems.length && !watchedItems.length && !ratedItems.length && !favoriteActorItems.length && !favoriteDirectorItems.length && !favoriteGalleryItems.length && !followingTaste.length ? (
                <Text style={styles.sectionEmptyHint}>No items yet. Add favorites or watched to build your profile.</Text>
              ) : null}
          </Animated.View>
        </Animated.ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#040507',
  },
  screenGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  flex: {
    flex: 1,
  },
  scroll: {
    paddingHorizontal: Spacing.three,
    paddingTop: 0,
    paddingBottom: 146,
  },
  heroStage: {
    marginBottom: Spacing.four,
  },
  heroImageShell: {
    marginHorizontal: 0,
    overflow: 'hidden',
    borderRadius: 34,
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 16 },
    elevation: 12,
  },
  heroImage: {
    height: undefined,
    aspectRatio: 0.92,
    borderRadius: 34,
    width: '100%',
    overflow: 'hidden',
    backgroundColor: '#0C1018',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  heroImageInner: {
    ...StyleSheet.absoluteFillObject,
    resizeMode: 'cover',
  },
  heroImageInnerShift: {
    transform: [{ translateY: PROFILE_HERO_IMAGE_VERTICAL_SHIFT }, { scale: 1.02 }],
  },
  heroPlaceholder: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111111',
  },
  heroPlaceholderText: {
    color: 'rgba(255,255,255,0.9)',
    fontFamily: Fonts.serif,
    fontSize: 92,
    lineHeight: 96,
  },
  heroTopActions: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 14,
  },
  profileMetaBlock: {
    marginTop: -54,
    marginHorizontal: 12,
    paddingHorizontal: 12,
    paddingTop: 74,
    paddingBottom: 8,
    position: 'relative',
  },
  profileMetaSheen: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 30,
    opacity: 0.9,
  },
  profileMetaOrbLeft: {
    position: 'absolute',
    width: 136,
    height: 136,
    borderRadius: 999,
    top: 18,
    left: -18,
    backgroundColor: 'rgba(138, 28, 48, 0.14)',
  },
  profileMetaOrbRight: {
    position: 'absolute',
    width: 124,
    height: 124,
    borderRadius: 999,
    right: -12,
    bottom: 6,
    backgroundColor: 'rgba(94, 16, 31, 0.1)',
  },
  settingsIconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.34)',
    backgroundColor: 'rgba(8,12,19,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  visibilityToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderWidth: 1,
  },
  visibilityTogglePublic: {
    backgroundColor: 'rgba(34,197,94,0.2)',
    borderColor: 'rgba(34,197,94,0.58)',
  },
  visibilityTogglePrivate: {
    backgroundColor: 'rgba(9,14,22,0.65)',
    borderColor: 'rgba(255,255,255,0.28)',
  },
  visibilityToggleText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  profileControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  profileKicker: {
    marginTop: 18,
    color: 'rgba(255,255,255,0.52)',
    fontFamily: Fonts.mono,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  name: {
    fontFamily: Fonts.serif,
    marginTop: 4,
    fontSize: 43,
    lineHeight: 46,
    color: '#FFFFFF',
  },
  identityLine: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
  },
  nickname: {
    fontFamily: Fonts.mono,
    fontSize: 11,
    color: 'rgba(255,255,255,0.74)',
    textTransform: 'uppercase',
    letterSpacing: 1.1,
  },
  identityDivider: {
    width: 26,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  identityTag: {
    color: 'rgba(255,255,255,0.5)',
    fontFamily: Fonts.mono,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 1.05,
  },
  bio: {
    marginTop: 16,
    fontFamily: Fonts.serif,
    fontSize: 15,
    lineHeight: 22,
    color: 'rgba(255,255,255,0.84)',
    maxWidth: '92%',
  },
  editBtn: {
    borderRadius: 999,
    backgroundColor: 'rgba(8,12,19,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.34)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 11,
    paddingVertical: 7,
    flexDirection: 'row',
    gap: 6,
  },
  editBtnText: {
    color: '#fff',
    fontSize: 10,
    fontFamily: Fonts.mono,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 0,
    marginTop: 22,
  },
  statCard: {
    flex: 1,
    paddingVertical: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statsDivider: {
    width: 1,
    backgroundColor: 'rgba(255,255,255,0.12)',
    marginVertical: 8,
  },
  statValue: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 21,
  },
  statLabel: {
    marginTop: 4,
    color: 'rgba(255,255,255,0.58)',
    fontFamily: Fonts.mono,
    fontSize: 9.5,
    textTransform: 'uppercase',
    letterSpacing: 0.9,
  },
  sectionRailWrap: {
    marginTop: 10,
    marginBottom: 18,
  },
  sectionRailHeader: {
    marginBottom: 18,
    paddingHorizontal: 2,
  },
  sectionRailTitle: {
    marginBottom: 8,
    color: 'rgba(255,255,255,0.9)',
    fontFamily: Fonts.mono,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1.35,
  },
  sectionRailSubtitle: {
    maxWidth: '86%',
    color: 'rgba(255,255,255,0.66)',
    fontFamily: Fonts.serif,
    fontSize: 14,
    lineHeight: 21,
  },
  sectionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  sectionTile: {
    overflow: 'hidden',
  },
  sectionTileWide: {
    width: '100%',
  },
  sectionTileHalf: {
    width: '48.2%',
  },
  sectionTileLifted: {
    marginTop: 18,
  },
  sectionTileGlass: {
    minHeight: 122,
    borderRadius: 30,
    paddingHorizontal: 16,
    paddingVertical: 15,
    overflow: 'hidden',
    backgroundColor: 'rgba(9,12,20,0.34)',
  },
  sectionTileGloss: {
    ...StyleSheet.absoluteFillObject,
  },
  sectionTileGhostCount: {
    position: 'absolute',
    right: 12,
    bottom: -10,
    color: 'rgba(255,255,255,0.08)',
    fontFamily: Fonts.mono,
    fontSize: 64,
    lineHeight: 64,
  },
  sectionTileTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  sectionTileLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    flex: 1,
  },
  sectionTileTitle: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 18,
  },
  sectionTileCountPill: {
    minWidth: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  sectionTileCount: {
    color: 'rgba(255,255,255,0.9)',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  sectionTileBlurb: {
    marginTop: 18,
    maxWidth: '74%',
    color: 'rgba(255,255,255,0.64)',
    fontFamily: Fonts.serif,
    fontSize: 12.5,
    lineHeight: 18,
  },
  sectionLoadingWrap: {
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionEmptyHint: {
    marginTop: 14,
    color: 'rgba(255,255,255,0.58)',
    fontFamily: Fonts.serif,
    fontSize: 13,
  },
  sectionFooterRule: {
    marginTop: 16,
    height: 1,
    width: '72%',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  sectionFooterGlow: {
    marginTop: 8,
    width: 84,
    height: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(145, 35, 56, 0.42)',
  },
  previewWrap: {
    marginBottom: 12,
  },
  previewCard: {
    borderRadius: 20,
    padding: Spacing.three,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(9,12,18,0.76)',
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.three,
  },
  previewTitle: {
    color: '#fff',
    fontFamily: Fonts.mono,
    textTransform: 'uppercase',
    letterSpacing: 1.1,
    fontSize: 14,
  },
  previewOpenBtn: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingVertical: 6,
    paddingHorizontal: 11,
  },
  previewOpenText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  previewRow: {
    gap: 10,
    paddingRight: 6,
  },
  previewMovieCard: {
    width: 102,
  },
  previewMoviePoster: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  previewMoviePosterFallback: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  previewMovieTitle: {
    marginTop: 6,
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 11,
  },
  previewActorCard: {
    width: 86,
    alignItems: 'center',
  },
  previewActorImage: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  previewActorFallback: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  previewActorTitle: {
    marginTop: 6,
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 10,
    textAlign: 'center',
  },
  previewFollowCard: {
    width: 92,
    alignItems: 'center',
  },
  previewFollowAvatar: {
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  previewFollowAvatarFallback: {
    width: 70,
    height: 70,
    borderRadius: 35,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  previewFollowAvatarText: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 28,
  },
  actionsWrap: {
    marginTop: 6,
    gap: 9,
  },
  settingsBackdrop: {
    flex: 1,
    justifyContent: 'flex-start',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  settingsBackdropPress: {
    flex: 1,
  },
  settingsSheet: {
    marginHorizontal: Spacing.three,
    marginTop: 58,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(7,10,15,0.98)',
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two,
    gap: 4,
  },
  settingsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  settingsTitle: {
    color: '#fff',
    fontFamily: Fonts.mono,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontSize: 12,
  },
  settingsCloseBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  settingsItem: {
    minHeight: 44,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(255,255,255,0.04)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  settingsItemText: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 13,
  },
  settingsItemDanger: {
    borderColor: 'rgba(255,120,120,0.5)',
    backgroundColor: 'rgba(120,14,20,0.26)',
  },
  settingsItemDangerText: {
    color: '#ffd8d8',
    fontFamily: Fonts.serif,
    fontSize: 13,
  },
  compactGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  tilePressable: {
    width: '48%',
  },
  compactTile: {
    borderRadius: 14,
    padding: Spacing.two,
    minHeight: 90,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  compactTileActive: {
    borderColor: 'rgba(255,255,255,0.42)',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  compactTileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  compactTileBadge: {
    color: 'rgba(255,255,255,0.8)',
    fontFamily: Fonts.mono,
    fontSize: 9,
    backgroundColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
  },
  compactTileTitle: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 13,
  },
  compactTileCount: {
    marginTop: 6,
    color: 'rgba(255,255,255,0.85)',
    fontFamily: Fonts.mono,
    fontSize: 12,
  },
  sectionCard: {
    padding: Spacing.two,
    borderRadius: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.one,
  },
  sectionTitleText: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 16,
  },
  eyeBtn: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  eyeText: {
    color: '#fff',
    fontSize: 11,
    fontFamily: Fonts.mono,
  },
  sectionEmpty: {
    color: 'rgba(255,255,255,0.6)',
    fontFamily: Fonts.serif,
    fontSize: 12,
  },
  moviesBox: {
    marginTop: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(0,0,0,0.26)',
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  boxRow: {
    gap: 10,
    paddingRight: 4,
  },
  boxCard: {
    width: 86,
  },
  boxPoster: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  boxPosterFallback: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  boxTitle: {
    marginTop: 4,
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 11,
  },
  boxMeta: {
    marginTop: 1,
    color: 'rgba(255,255,255,0.7)',
    fontFamily: Fonts.mono,
    fontSize: 9,
  },
  actorCircleCard: {
    width: 84,
    alignItems: 'center',
  },
  actorCircleImage: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  actorCircleFallback: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  actorCircleTitle: {
    marginTop: 6,
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 10,
    textAlign: 'center',
  },
  actorCircleMeta: {
    marginTop: 1,
    color: 'rgba(255,255,255,0.7)',
    fontFamily: Fonts.mono,
    fontSize: 8,
    textAlign: 'center',
  },
  followCard: {
    width: 88,
    alignItems: 'center',
  },
  followAvatar: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  followAvatarFallback: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  followAvatarText: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 28,
  },
  logoutBtn: {
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.26)',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  logoutText: {
    fontFamily: Fonts.mono,
    color: '#fff',
  },
  deleteAccountBtn: {
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,96,96,0.75)',
    backgroundColor: 'rgba(120,14,20,0.28)',
  },
  deleteAccountText: {
    fontFamily: Fonts.mono,
    color: '#ffd6d6',
  },
  adminBtn: {
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    backgroundColor: 'rgba(193,18,31,0.24)',
  },
  adminBtnText: {
    fontFamily: Fonts.mono,
    color: '#fff',
  },
  sheetBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheetBackdropPress: {
    flex: 1,
  },
  sheet: {
    maxHeight: '92%',
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.four,
    paddingTop: Spacing.three,
    backgroundColor: 'rgba(8,8,8,0.98)',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 42,
    height: 4,
    borderRadius: 999,
    marginBottom: Spacing.two,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
});

