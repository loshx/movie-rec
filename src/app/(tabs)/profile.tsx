import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { router } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { GlassView } from '@/components/glass-view';
import { useAuth } from '@/contexts/AuthContext';
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
  setUserListPrivacy,
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

export default function ProfileScreen() {
  const { user, logout } = useAuth();
  const detailsCacheRef = useRef<Map<string, ProfileMovieItem>>(new Map());
  const inFlightRef = useRef<Map<string, Promise<ProfileMovieItem | null>>>(new Map());
  const invalidKeysRef = useRef<Set<string>>(new Set());
  const actorCacheRef = useRef<Map<number, ProfileActorItem>>(new Map());
  const actorInFlightRef = useRef<Map<number, Promise<ProfileActorItem | null>>>(new Map());
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
  const [activeSection, setActiveSection] = useState<ProfileSectionKey>('favorites');
  const [panelVisible, setPanelVisible] = useState(false);
  const sheetTranslateY = useRef(new Animated.Value(420)).current;
  const scrollRef = useRef<ScrollView | null>(null);

  const nickname = user?.nickname ?? 'nickname';
  const bio = (user as any)?.bio ?? '';
  const avatarUrl = ((user as any)?.avatar_url ?? '').trim();
  const hasAvatar = !!avatarUrl;

  const fullName = useMemo(() => {
    const base = `${user?.name ?? ''}`.trim();
    return base.length ? base : 'User name';
  }, [user?.name]);

  const closePanel = useCallback(() => {
    Animated.timing(sheetTranslateY, {
      toValue: 420,
      duration: 180,
      useNativeDriver: true,
    }).start(() => setPanelVisible(false));
  }, [sheetTranslateY]);

  const onSelectSection = useCallback((key: ProfileSectionKey) => {
    setActiveSection(key);
    setPanelVisible(true);
  }, []);

  useEffect(() => {
    if (!panelVisible) return;
    sheetTranslateY.setValue(420);
    Animated.spring(sheetTranslateY, {
      toValue: 0,
      useNativeDriver: true,
      damping: 16,
      stiffness: 180,
    }).start();
  }, [panelVisible, sheetTranslateY]);

  const sheetPanResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) =>
        gesture.dy > 5 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderMove: (_, gesture) => {
        sheetTranslateY.setValue(Math.max(0, gesture.dy));
      },
      onPanResponderRelease: (_, gesture) => {
        if (gesture.dy > 120 || gesture.vy > 1.1) {
          closePanel();
        } else {
          Animated.spring(sheetTranslateY, {
            toValue: 0,
            useNativeDriver: true,
            damping: 16,
            stiffness: 180,
          }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(sheetTranslateY, {
          toValue: 0,
          useNativeDriver: true,
          damping: 16,
          stiffness: 180,
        }).start();
      },
    })
  ).current;

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

  const loadLists = useCallback(async () => {
    if (!user) return;

    setLoadingLists(true);
    try {
      const [watchRows, favRows, actorRows, directorRows, watchedRows, ratedRows, savedPrivacy, galleryRows] = await Promise.all([
        getUserWatchlist(user.id),
        getUserFavorites(user.id),
        getUserFavoriteActors(user.id),
        getUserFavoriteDirectors(user.id),
        getUserWatched(user.id),
        getUserRatings(user.id),
        getUserListPrivacy(user.id),
        getUserFavoriteGallery(user.id),
      ]);

      const [watchData, favData, actorData, directorData, watchedData, ratedData] = await Promise.all([
        Promise.all(watchRows.map(resolveMovieItem)),
        Promise.all(favRows.map(resolveMovieItem)),
        Promise.all(actorRows.map(resolveActorItem)),
        Promise.all(directorRows.map(resolveActorItem)),
        Promise.all(watchedRows.map(resolveMovieItem)),
        Promise.all(ratedRows.map(resolveMovieItem)),
      ]);

      setWatchlistItems(watchData.filter((item): item is ProfileMovieItem => !!item));
      setFavoriteItems(favData.filter((item): item is ProfileMovieItem => !!item));
      setFavoriteActorItems(actorData.filter((item): item is ProfileActorItem => !!item));
      setFavoriteDirectorItems(directorData.filter((item): item is ProfileActorItem => !!item));
      setFavoriteGalleryItems(galleryRows.map((item) => ({ id: item.id, title: item.title, image: item.image })));
      setWatchedItems(watchedData.filter((item): item is ProfileMovieItem => !!item));
      setRatedItems(ratedData.filter((item): item is ProfileMovieItem => !!item));
      setPrivacy(savedPrivacy);
      const following = await getFollowingProfiles(user.id);
      setFollowingTaste(following);
    } catch {
      setWatchlistItems([]);
      setFavoriteItems([]);
      setFavoriteActorItems([]);
      setFavoriteDirectorItems([]);
      setFavoriteGalleryItems([]);
      setWatchedItems([]);
      setRatedItems([]);
      setFollowingTaste([]);
      setPrivacy({
        watchlist: false,
        favorites: false,
        watched: false,
        rated: false,
      });
    } finally {
      setLoadingLists(false);
    }
  }, [resolveActorItem, resolveMovieItem, user]);

  const togglePrivacy = useCallback(
    (key: keyof PrivacyState) => {
      if (!user) return;
      setPrivacy((prev) => {
        const next = { ...prev, [key]: !prev[key] };
        void setUserListPrivacy(user.id, next).catch(() => {});
        return next;
      });
    },
    [user]
  );

  useEffect(() => {
    if (!user) return;
    const timer = setTimeout(() => {
      void syncPublicProfile({
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
          favorite_actors: true,
          favorite_directors: true,
        },
        watchlist: watchlistItems,
        favorites: favoriteItems,
        watched: watchedItems,
        rated: ratedItems,
        favorite_actors: favoriteActorItems,
        favorite_directors: favoriteDirectorItems,
      }).catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [favoriteActorItems, favoriteDirectorItems, favoriteItems, privacy.favorites, privacy.rated, privacy.watchlist, privacy.watched, ratedItems, user, watchedItems, watchlistItems]);

  useFocusEffect(
    useCallback(() => {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ y: 0, animated: false });
      });
      runEnterAnimation();
      void loadLists();
    }, [loadLists, runEnterAnimation])
  );

  useEffect(() => {
    runEnterAnimation();
  }, [runEnterAnimation, user?.id]);

  return (
    <View style={styles.root}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}>
        <ScrollView
          ref={scrollRef}
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}>
          <Animated.View
            style={[
              styles.heroWrap,
              { opacity: heroOpacity, transform: [{ translateY: heroTranslateY }] },
            ]}>
            <View style={styles.heroImage}>
              {hasAvatar ? (
                <Image source={{ uri: avatarUrl }} style={styles.heroImageInner} />
              ) : (
                <View style={styles.heroPlaceholder}>
                  <Text style={styles.heroPlaceholderText}>?</Text>
                </View>
              )}
              <View style={styles.heroImageOverlay} />
            </View>

            <GlassView
              intensity={32}
              tint="dark"
              style={styles.heroCard}>
              <Text style={styles.name}>{fullName}</Text>
              <Text style={styles.nickname}>@{nickname}</Text>
              <Text style={styles.bio}>{bio || 'Tell something about yourself...'}</Text>
            </GlassView>

            <Pressable
              onPress={() => router.push('/profile-edit')}
              style={styles.editBtn}>
              <Text style={styles.editIcon}>✎</Text>
            </Pressable>
          </Animated.View>

          <Animated.View
            style={[
              styles.lists,
              { opacity: bodyOpacity, transform: [{ translateY: bodyTranslateY }] },
            ]}>
            <View style={styles.compactGrid}>
              <CompactTile
                title="Watchlist"
                count={watchlistItems.length}
                icon="bookmark"
                active={activeSection === 'watchlist'}
                badge={privacy.watchlist ? 'Public' : 'Private'}
                onPress={() => onSelectSection('watchlist')}
              />
              <CompactTile
                title="Favorites"
                count={favoriteItems.length}
                icon="heart"
                active={activeSection === 'favorites'}
                badge={privacy.favorites ? 'Public' : 'Private'}
                onPress={() => onSelectSection('favorites')}
              />
              <CompactTile
                title="Actors"
                count={favoriteActorItems.length}
                icon="people"
                active={activeSection === 'actors'}
                onPress={() => onSelectSection('actors')}
              />
              <CompactTile
                title="Directors"
                count={favoriteDirectorItems.length}
                icon="film"
                active={activeSection === 'directors'}
                onPress={() => onSelectSection('directors')}
              />
              <CompactTile
                title="Shots"
                count={favoriteGalleryItems.length}
                icon="aperture"
                active={activeSection === 'shots'}
                onPress={() => onSelectSection('shots')}
              />
              <CompactTile
                title="Watched"
                count={watchedItems.length}
                icon="checkmark-circle"
                active={activeSection === 'watched'}
                badge={privacy.watched ? 'Public' : 'Private'}
                onPress={() => onSelectSection('watched')}
              />
              <CompactTile
                title="Rated"
                count={ratedItems.length}
                icon="star"
                active={activeSection === 'rated'}
                badge={privacy.rated ? 'Public' : 'Private'}
                onPress={() => onSelectSection('rated')}
              />
              <CompactTile
                title="Following"
                count={followingTaste.length}
                icon="person-add"
                active={activeSection === 'following'}
                onPress={() => onSelectSection('following')}
              />
            </View>

          </Animated.View>

          <Animated.View
            style={{ opacity: bodyOpacity, transform: [{ translateY: bodyTranslateY }] }}>
            {user?.role === 'admin' ? (
              <Pressable onPress={() => router.push('/admin')} style={styles.adminBtn}>
                <Text style={styles.adminBtnText}>Admin Panel</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={async () => {
                await logout();
                router.replace('/login');
              }}
              style={styles.logoutBtn}>
              <Text style={styles.logoutText}>Sign out</Text>
            </Pressable>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>

      <Modal visible={panelVisible} transparent animationType="fade" onRequestClose={closePanel}>
        <View style={styles.sheetBackdrop}>
          <Pressable style={styles.sheetBackdropPress} onPress={closePanel} />
          <Animated.View
            style={[styles.sheet, { transform: [{ translateY: sheetTranslateY }] }]}
            {...sheetPanResponder.panHandlers}>
            <View style={styles.sheetHandle} />
            {activeSection === 'watchlist' ? (
              <PanelMovieSection
                title="Watchlist"
                isPublic={privacy.watchlist}
                loading={loadingLists}
                items={watchlistItems}
                onToggle={() => togglePrivacy('watchlist')}
              />
            ) : null}
            {activeSection === 'favorites' ? (
              <PanelMovieSection
                title="Favorites"
                isPublic={privacy.favorites}
                loading={loadingLists}
                items={favoriteItems}
                onToggle={() => togglePrivacy('favorites')}
              />
            ) : null}
            {activeSection === 'actors' ? (
              <PanelActorSection
                title="Favorite Actors"
                loading={loadingLists}
                items={favoriteActorItems}
                roleLabel="Actor"
                roleParam="actor"
              />
            ) : null}
            {activeSection === 'directors' ? (
              <PanelActorSection
                title="Favorite Directors"
                loading={loadingLists}
                items={favoriteDirectorItems}
                roleLabel="Director"
                roleParam="director"
              />
            ) : null}
            {activeSection === 'shots' ? (
              <PanelGallerySection title="Favorite Shots" loading={loadingLists} items={favoriteGalleryItems} />
            ) : null}
            {activeSection === 'watched' ? (
              <PanelMovieSection
                title="Watched"
                isPublic={privacy.watched}
                loading={loadingLists}
                items={watchedItems}
                onToggle={() => togglePrivacy('watched')}
              />
            ) : null}
            {activeSection === 'rated' ? (
              <PanelMovieSection
                title="Rated"
                isPublic={privacy.rated}
                loading={loadingLists}
                items={ratedItems}
                onToggle={() => togglePrivacy('rated')}
              />
            ) : null}
            {activeSection === 'following' ? <PanelFollowingSection items={followingTaste} /> : null}
          </Animated.View>
        </View>
      </Modal>
    </View>
  );
}

function CompactTile({
  title,
  count,
  icon,
  active,
  onPress,
  badge,
}: {
  title: string;
  count: number;
  icon: keyof typeof Ionicons.glyphMap;
  active: boolean;
  onPress: () => void;
  badge?: string;
}) {
  return (
    <Pressable onPress={onPress} style={styles.tilePressable}>
      <GlassView
        intensity={24}
        tint="dark"
        style={active ? { ...styles.compactTile, ...styles.compactTileActive } : styles.compactTile}>
        <View style={styles.compactTileHeader}>
          <Ionicons name={icon} size={16} color={active ? '#FFFFFF' : 'rgba(255,255,255,0.84)'} />
          {badge ? <Text style={styles.compactTileBadge}>{badge}</Text> : <View />}
        </View>
        <Text style={styles.compactTileTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.compactTileCount}>{count}</Text>
      </GlassView>
    </Pressable>
  );
}

function PanelFollowingSection({ items }: { items: PublicProfile[] }) {
  return (
    <GlassView intensity={24} tint="dark" style={styles.sectionCard}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitleText}>Following taste</Text>
      </View>
      {items.length === 0 ? <Text style={styles.sectionEmpty}>You do not follow anyone yet.</Text> : null}
      {items.length > 0 ? (
        <View style={styles.moviesBox}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.boxRow}>
            {items.map((item) => (
              <Pressable
                key={`follow-${item.user_id}`}
                style={styles.followCard}
                onPress={() => router.push(`/user/${item.user_id}` as any)}>
                {item.avatar_url ? (
                  <Image source={{ uri: item.avatar_url }} style={styles.followAvatar} />
                ) : (
                  <View style={styles.followAvatarFallback}>
                    <Text style={styles.followAvatarText}>?</Text>
                  </View>
                )}
                <Text style={styles.boxTitle} numberOfLines={1}>
                  {item.nickname}
                </Text>
                <Text style={styles.boxMeta}>{item.followers} followers</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </GlassView>
  );
}

function PanelActorSection({
  title,
  loading,
  items,
  roleLabel,
  roleParam,
}: {
  title: string;
  loading: boolean;
  items: ProfileActorItem[];
  roleLabel: string;
  roleParam: 'actor' | 'director';
}) {
  return (
    <GlassView intensity={24} tint="dark" style={styles.sectionCard}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitleText}>{title}</Text>
      </View>

      {loading ? <ActivityIndicator color="#fff" /> : null}
      {!loading && items.length === 0 ? <Text style={styles.sectionEmpty}>No favorites yet.</Text> : null}
      {!loading && items.length > 0 ? (
        <View style={styles.moviesBox}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.boxRow}>
            {items.map((item) => (
              <Pressable
                key={`${title}-${item.personId}`}
                style={styles.actorCircleCard}
                onPress={() => router.push({ pathname: '/person/[id]', params: { id: String(item.personId), role: roleParam } })}>
                {item.profile ? (
                  <Image source={{ uri: item.profile }} style={styles.actorCircleImage} />
                ) : (
                  <View style={styles.actorCircleFallback} />
                )}
                <Text style={styles.actorCircleTitle} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.actorCircleMeta}>{roleLabel}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </GlassView>
  );
}

function PanelMovieSection({
  title,
  isPublic,
  loading,
  items,
  onToggle,
}: {
  title: string;
  isPublic: boolean;
  loading: boolean;
  items: ProfileMovieItem[];
  onToggle: () => void;
}) {
  return (
    <GlassView intensity={24} tint="dark" style={styles.sectionCard}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitleText}>{title}</Text>
        <Pressable onPress={onToggle} style={styles.eyeBtn}>
          <Text style={styles.eyeText}>{isPublic ? 'Public' : 'Private'}</Text>
        </Pressable>
      </View>

      {loading ? <ActivityIndicator color="#fff" /> : null}
      {!loading && items.length === 0 ? <Text style={styles.sectionEmpty}>No movies yet.</Text> : null}
      {!loading && items.length > 0 ? (
        <View style={styles.moviesBox}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.boxRow}>
            {items.map((item) => (
              <Pressable
                key={`${title}-${item.tmdbId}`}
                style={styles.boxCard}
                onPress={() =>
                  router.push({
                    pathname: '/movie/[id]',
                    params: { id: String(item.tmdbId), type: item.mediaType },
                  })
                }>
                {item.poster ? (
                  <Image source={{ uri: item.poster }} style={styles.boxPoster} />
                ) : (
                  <View style={styles.boxPosterFallback} />
                )}
                <Text style={styles.boxTitle} numberOfLines={1}>
                  {item.title}
                </Text>
                {typeof item.rating === 'number' ? (
                  <Text style={styles.boxMeta}>{item.rating}/10</Text>
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </GlassView>
  );
}

function PanelGallerySection({
  title,
  loading,
  items,
}: {
  title: string;
  loading: boolean;
  items: ProfileGalleryItem[];
}) {
  return (
    <GlassView intensity={24} tint="dark" style={styles.sectionCard}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitleText}>{title}</Text>
      </View>

      {loading ? <ActivityIndicator color="#fff" /> : null}
      {!loading && items.length === 0 ? <Text style={styles.sectionEmpty}>No saved shots yet.</Text> : null}
      {!loading && items.length > 0 ? (
        <View style={styles.moviesBox}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.boxRow}>
            {items.map((item) => (
              <Pressable
                key={`gallery-${item.id}`}
                style={styles.boxCard}
                onPress={() =>
                  router.push({
                    pathname: '/gallery',
                    params: { open: String(item.id) },
                  })
                }>
                <Image source={{ uri: item.image }} style={styles.boxPoster} />
                <Text style={styles.boxTitle} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={styles.boxMeta}>Saved frame</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </GlassView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#050505',
  },
  flex: {
    flex: 1,
  },
  scroll: {
    padding: Spacing.four,
    paddingBottom: 120,
  },
  heroWrap: {
    marginBottom: Spacing.four,
    marginHorizontal: -Spacing.one,
  },
  heroImage: {
    height: 300,
    borderRadius: 24,
    width: '105%',
    marginHorizontal: -Spacing.one,
    overflow: 'hidden',
    backgroundColor: '#1B1B1B',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignSelf: 'center',
  },
  heroImageInner: {
    ...StyleSheet.absoluteFillObject,
    resizeMode: 'cover',
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
    fontSize: 96,
    lineHeight: 104,
  },
  heroImageOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  heroCard: {
    marginTop: -100,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.four,
    borderRadius: 16,
    width: '105%',
    alignSelf: 'center',
  },
  name: {
    fontFamily: Fonts.serif,
    fontSize: 22,
    color: '#FFFFFF',
  },
  nickname: {
    marginTop: 4,
    fontFamily: Fonts.mono,
    fontSize: 12,
    color: 'rgba(255,255,255,0.72)',
  },
  bio: {
    marginTop: 10,
    fontFamily: Fonts.serif,
    fontSize: 13,
    color: 'rgba(255,255,255,0.72)',
  },
  editBtn: {
    position: 'absolute',
    right: Spacing.two,
    top: Spacing.two,
    minWidth: 52,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.two,
  },
  editIcon: {
    color: '#fff',
    fontSize: 12,
    fontFamily: Fonts.mono,
  },
  lists: {
    gap: Spacing.three,
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
    marginTop: Spacing.three,
    alignItems: 'center',
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  logoutText: {
    fontFamily: Fonts.mono,
    color: '#fff',
  },
  adminBtn: {
    alignItems: 'center',
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    backgroundColor: 'rgba(193,18,31,0.32)',
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
    maxHeight: '62%',
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.four,
    paddingTop: Spacing.two,
    backgroundColor: 'rgba(8,8,8,0.98)',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
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
