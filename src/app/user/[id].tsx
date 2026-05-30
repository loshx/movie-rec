import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/contexts/AuthContext';
import { GlassView } from '@/components/glass-view';
import { Fonts, Spacing } from '@/constants/theme';
import {
  followTaste,
  getFollowingProfiles,
  getPublicProfile,
  type PublicProfile,
  unfollowTaste,
} from '@/lib/social-backend';
import { hasMlApi, syncMlFollowingGraph } from '@/lib/ml-recommendations';

type PublicSectionKey = 'watchlist' | 'favorites' | 'actors' | 'directors' | 'watched' | 'rated';

const PUBLIC_SECTION_ORDER: PublicSectionKey[] = [
  'favorites',
  'watchlist',
  'watched',
  'rated',
  'actors',
  'directors',
];

export default function PublicUserProfileScreen() {
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const heroTopOffset = useMemo(
    () => Math.max(8, Math.min(16, insets.top * 0.35)),
    [insets.top]
  );
  const params = useLocalSearchParams<{ id?: string }>();
  const targetId = Number(params.id ?? 0);
  const scrollRef = useRef<ScrollView | null>(null);
  const scrollY = useRef(new Animated.Value(0)).current;
  const heroScrollTranslateY = useMemo(
    () =>
      scrollY.interpolate({
        inputRange: [0, 260],
        outputRange: [0, -84],
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
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [following, setFollowing] = useState(false);
  const [saving, setSaving] = useState(false);

  const currentUserId = Number((user as any)?.id ?? (user as any)?.user_id ?? 0);
  const isOwnProfile = currentUserId > 0 && currentUserId === targetId;
  const canFollow = currentUserId > 0 && !isOwnProfile;

  const sectionMeta = useMemo(() => {
    const watchlistCount = (profile?.watchlist ?? []).length;
    const favoritesCount = (profile?.favorites ?? []).length;
    const watchedCount = (profile?.watched ?? []).length;
    const ratedCount = (profile?.rated ?? []).length;
    const actorsCount = (profile?.favorite_actors ?? []).length;
    const directorsCount = (profile?.favorite_directors ?? []).length;
    return {
      watchlist: { title: 'Watchlist', count: watchlistCount, icon: 'bookmark' as const, blurb: 'What this person is saving for later nights.' },
      favorites: { title: 'Favorites', count: favoritesCount, icon: 'heart' as const, blurb: 'The quickest way to read their taste at a glance.' },
      actors: { title: 'Actors', count: actorsCount, icon: 'people' as const, blurb: 'Recurring faces behind their favorite picks.' },
      directors: { title: 'Directors', count: directorsCount, icon: 'film' as const, blurb: 'Filmmakers steering the tone of their profile.' },
      watched: { title: 'Watched', count: watchedCount, icon: 'checkmark-circle' as const, blurb: 'The trail they already crossed through the catalog.' },
      rated: { title: 'Rated', count: ratedCount, icon: 'star' as const, blurb: 'Titles where their opinion is written in full.' },
    };
  }, [profile?.favorite_actors, profile?.favorite_directors, profile?.favorites, profile?.rated, profile?.watchlist, profile?.watched]);

  const loadProfile = useCallback(async () => {
    if (!Number.isFinite(targetId) || targetId <= 0) {
      setProfile(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const [publicProfile, mineFollowing] = await Promise.all([
        getPublicProfile(targetId),
        currentUserId > 0 ? getFollowingProfiles(currentUserId) : Promise.resolve([]),
      ]);
      setProfile(publicProfile);
      if (currentUserId > 0) {
        setFollowing(mineFollowing.some((x) => x.user_id === targetId));
      } else {
        setFollowing(false);
      }
    } finally {
      setLoading(false);
    }
  }, [currentUserId, targetId]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  useFocusEffect(
    useCallback(() => {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ y: 0, animated: false });
      });
    }, [])
  );

  const openPublicSection = useCallback(
    (key: PublicSectionKey) => {
      router.push({
        pathname: '/profile-lists' as any,
        params: {
          section: key,
          userId: String(targetId),
        },
      });
    },
    [targetId]
  );

  const handleFollowToggle = useCallback(async () => {
    if (!canFollow || saving || !profile) return;
    setSaving(true);
    try {
      if (following) {
        await unfollowTaste(currentUserId, targetId);
        setFollowing(false);
        setProfile((prev) =>
          prev ? { ...prev, followers: Math.max(0, Number(prev.followers ?? 0) - 1) } : prev
        );
      } else {
        await followTaste(currentUserId, targetId);
        setFollowing(true);
        setProfile((prev) => (prev ? { ...prev, followers: Number(prev.followers ?? 0) + 1 } : prev));
      }
      if (hasMlApi()) {
        const nextFollowing = await getFollowingProfiles(currentUserId);
        await syncMlFollowingGraph(
          currentUserId,
          nextFollowing.map((p) => p.user_id)
        );
      }
    } finally {
      setSaving(false);
    }
  }, [canFollow, currentUserId, following, profile, saving, targetId]);

  if (loading) {
    return (
      <View style={styles.loader}>
        <LinearGradient
          colors={['#040507', '#06080D', '#08080A']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.screenGradient}
        />
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  if (!profile) {
    return (
      <View style={styles.loader}>
        <LinearGradient
          colors={['#040507', '#06080D', '#08080A']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.screenGradient}
        />
        <Text style={styles.emptyStateText}>User not found.</Text>
        <Pressable style={styles.emptyBackBtn} onPress={() => router.back()}>
          <Text style={styles.emptyBackText}>Back</Text>
        </Pressable>
      </View>
    );
  }

  const title = profile.name || profile.nickname;
  const bio = String(profile.bio ?? '').trim();
  const avatarUrl = String(profile.avatar_url ?? '').trim();
  const hasAvatar = avatarUrl.length > 0;
  const allListsEmpty =
    (profile.favorites ?? []).length === 0 &&
    (profile.watchlist ?? []).length === 0 &&
    (profile.watched ?? []).length === 0 &&
    (profile.rated ?? []).length === 0 &&
    (profile.favorite_actors ?? []).length === 0 &&
    (profile.favorite_directors ?? []).length === 0;

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={['#040507', '#06080D', '#08080A']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.screenGradient}
      />

      <Animated.ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.scroll}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true }
        )}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}>
        <View style={[styles.heroStage, { marginTop: heroTopOffset }]}>
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
                <Image source={{ uri: avatarUrl }} style={styles.heroImageInner} />
              ) : (
                <View style={styles.heroPlaceholder}>
                  <Text style={styles.heroPlaceholderText}>?</Text>
                </View>
              )}

              <View style={[styles.heroTopActions, { top: insets.top + 12 }]}>
                <Pressable onPress={() => router.back()} style={styles.backIconBtn}>
                  <Ionicons name="chevron-back" size={18} color="#fff" />
                </Pressable>
              </View>
            </View>
          </Animated.View>

          <View style={styles.profileMetaBlock}>
            <LinearGradient
              colors={['rgba(255,255,255,0.05)', 'rgba(255,255,255,0)', 'rgba(138,32,52,0.09)']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.profileMetaSheen}
            />
            <View style={styles.profileMetaOrbLeft} pointerEvents="none" />
            <View style={styles.profileMetaOrbRight} pointerEvents="none" />
            <View style={styles.profileControlsRow}>
              <View style={styles.publicTastePill}>
                <Ionicons name="sparkles-outline" size={13} color="#fff" />
                <Text style={styles.publicTastePillText}>Public taste</Text>
              </View>
              {canFollow ? (
                <Pressable
                  onPress={() => void handleFollowToggle()}
                  disabled={saving}
                  style={[
                    styles.followPillInline,
                    following ? styles.followPillInlineActive : null,
                    saving ? styles.followPillLargeDisabled : null,
                  ]}>
                  <Text style={styles.followPillInlineText}>
                    {saving ? 'Saving...' : following ? 'Following' : 'Follow'}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            <Text style={styles.profileKicker}>Shared profile</Text>
            <Text style={styles.name}>{title}</Text>
            <View style={styles.identityLine}>
              <Text style={styles.nickname}>@{profile.nickname}</Text>
              <View style={styles.identityDivider} />
              <Text style={styles.identityTag}>open signal</Text>
            </View>
            <Text style={styles.bio} numberOfLines={3}>
              {bio || 'This user has not added a bio yet.'}
            </Text>
            <View style={styles.statsRow}>
              <Pressable onPress={() => openPublicSection('favorites')} style={styles.statCard}>
                <Text style={styles.statValue}>{(profile.favorites ?? []).length}</Text>
                <Text style={styles.statLabel}>Favorites</Text>
              </Pressable>
              <View style={styles.statsDivider} />
              <Pressable onPress={() => openPublicSection('watched')} style={styles.statCard}>
                <Text style={styles.statValue}>{(profile.watched ?? []).length}</Text>
                <Text style={styles.statLabel}>Watched</Text>
              </Pressable>
              <View style={styles.statsDivider} />
              <View style={styles.statCard}>
                <Text style={styles.statValue}>{Number(profile.followers ?? 0)}</Text>
                <Text style={styles.statLabel}>Followers</Text>
              </View>
            </View>
            {!canFollow && !user ? (
              <Text style={styles.followHint}>Sign in to follow taste.</Text>
            ) : null}
          </View>
        </View>

        <View style={styles.sectionRailWrap}>
          <View style={styles.sectionRailHeader}>
            <Text style={styles.sectionRailTitle}>Public Lists</Text>
            <Text style={styles.sectionRailSubtitle}>
              Browse the visible lanes this person decided to share with everyone else.
            </Text>
          </View>
          <View style={styles.sectionGrid}>
            {PUBLIC_SECTION_ORDER.map((key, index) => (
              <Pressable
                key={key}
                onPress={() => openPublicSection(key)}
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
                      <Ionicons name={sectionMeta[key].icon} size={15} color="rgba(255,255,255,0.84)" />
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
          {allListsEmpty ? <Text style={styles.sectionEmptyHint}>No public items yet.</Text> : null}
        </View>
      </Animated.ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#050505',
  },
  screenGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  loader: {
    flex: 1,
    backgroundColor: '#050505',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  emptyStateText: {
    color: 'rgba(255,255,255,0.78)',
    fontFamily: Fonts.serif,
    fontSize: 14,
  },
  emptyBackBtn: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  emptyBackText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  scroll: {
    paddingHorizontal: Spacing.three,
    paddingTop: 0,
    paddingBottom: 132,
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
    backgroundColor: '#12151E',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
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
    fontSize: 92,
    lineHeight: 96,
  },
  heroTopActions: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingHorizontal: 14,
  },
  backIconBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.34)',
    backgroundColor: 'rgba(8,12,19,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  followPillLarge: {
    marginTop: 10,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.34)',
    backgroundColor: 'rgba(8,12,19,0.78)',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  followPillLargeActive: {
    borderColor: 'rgba(78,212,145,0.64)',
    backgroundColor: 'rgba(36,111,79,0.62)',
  },
  followPillLargeDisabled: {
    opacity: 0.75,
  },
  followPillLargeText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 13,
  },
  followPillInline: {
    minHeight: 38,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
    backgroundColor: 'rgba(8,12,19,0.78)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  followPillInlineActive: {
    borderColor: 'rgba(78,212,145,0.64)',
    backgroundColor: 'rgba(36,111,79,0.62)',
  },
  followPillInlineText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 11,
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
    backgroundColor: 'rgba(145, 34, 55, 0.13)',
  },
  profileMetaOrbRight: {
    position: 'absolute',
    width: 124,
    height: 124,
    borderRadius: 999,
    right: -12,
    bottom: 6,
    backgroundColor: 'rgba(96, 18, 34, 0.09)',
  },
  profileControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  publicTastePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  publicTastePillText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 10,
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
  followHint: {
    marginTop: 10,
    color: 'rgba(255,255,255,0.7)',
    fontFamily: Fonts.mono,
    fontSize: 11,
    textAlign: 'center',
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
    backgroundColor: 'rgba(149, 38, 59, 0.38)',
  },
});
