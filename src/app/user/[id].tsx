import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';

import { useAuth } from '@/contexts/AuthContext';
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
  const params = useLocalSearchParams<{ id?: string }>();
  const targetId = Number(params.id ?? 0);
  const scrollRef = useRef<ScrollView | null>(null);

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
      watchlist: { title: 'Watchlist', count: watchlistCount, icon: 'bookmark' as const },
      favorites: { title: 'Favorites', count: favoritesCount, icon: 'heart' as const },
      actors: { title: 'Actors', count: actorsCount, icon: 'people' as const },
      directors: { title: 'Directors', count: directorsCount, icon: 'film' as const },
      watched: { title: 'Watched', count: watchedCount, icon: 'checkmark-circle' as const },
      rated: { title: 'Rated', count: ratedCount, icon: 'star' as const },
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

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}>
        <View style={styles.heroStage}>
          <View style={styles.heroImage}>
            {hasAvatar ? (
              <Image source={{ uri: avatarUrl }} style={styles.heroImageInner} />
            ) : (
              <View style={styles.heroPlaceholder}>
                <Text style={styles.heroPlaceholderText}>?</Text>
              </View>
            )}
            <LinearGradient
              colors={['rgba(0,0,0,0.05)', 'rgba(0,0,0,0.42)', 'rgba(5,5,5,0.94)']}
              locations={[0, 0.52, 1]}
              style={styles.heroImageOverlay}
            />

            <View style={styles.heroTopActions}>
              <Pressable onPress={() => router.back()} style={styles.backIconBtn}>
                <Ionicons name="chevron-back" size={18} color="#fff" />
              </Pressable>
            </View>

            <View style={styles.heroBottomContent}>
              <Text style={styles.name}>{title}</Text>
              <Text style={styles.nickname}>@{profile.nickname}</Text>
              <Text style={styles.bio} numberOfLines={2}>
                {bio || 'This user has not added a bio yet.'}
              </Text>
              <View style={styles.statsRow}>
                <Pressable onPress={() => openPublicSection('favorites')} style={styles.statCard}>
                  <Text style={styles.statValue}>{(profile.favorites ?? []).length}</Text>
                  <Text style={styles.statLabel}>Favorites</Text>
                </Pressable>
                <Pressable onPress={() => openPublicSection('watched')} style={styles.statCard}>
                  <Text style={styles.statValue}>{(profile.watched ?? []).length}</Text>
                  <Text style={styles.statLabel}>Watched</Text>
                </Pressable>
                <View style={styles.statCard}>
                  <Text style={styles.statValue}>{Number(profile.followers ?? 0)}</Text>
                  <Text style={styles.statLabel}>Followers</Text>
                </View>
              </View>
              {canFollow ? (
                <Pressable
                  onPress={() => void handleFollowToggle()}
                  disabled={saving}
                  style={[
                    styles.followPillLarge,
                    following ? styles.followPillLargeActive : null,
                    saving ? styles.followPillLargeDisabled : null,
                  ]}>
                  <Text style={styles.followPillLargeText}>
                    {saving ? 'Saving...' : following ? 'Following' : 'Follow'}
                  </Text>
                </Pressable>
              ) : !user ? (
                <Text style={styles.followHint}>Sign in to follow taste.</Text>
              ) : null}
            </View>
          </View>
        </View>

        <View style={styles.sectionRailWrap}>
          <Text style={styles.sectionRailTitle}>Public Lists</Text>
          <View style={styles.sectionGrid}>
            {PUBLIC_SECTION_ORDER.map((key) => (
              <Pressable
                key={key}
                onPress={() => openPublicSection(key)}
                style={styles.sectionTile}>
                <View style={styles.sectionTileLeft}>
                  <Ionicons name={sectionMeta[key].icon} size={15} color="rgba(255,255,255,0.8)" />
                  <Text style={styles.sectionTileTitle}>{sectionMeta[key].title}</Text>
                </View>
                <Text style={styles.sectionTileCount}>{sectionMeta[key].count}</Text>
              </Pressable>
            ))}
          </View>
          {allListsEmpty ? <Text style={styles.sectionEmptyHint}>No public items yet.</Text> : null}
        </View>
      </ScrollView>
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
    paddingTop: Spacing.three,
    paddingBottom: 132,
  },
  heroStage: {
    marginBottom: Spacing.four,
  },
  heroImage: {
    height: 420,
    borderRadius: 28,
    width: '100%',
    overflow: 'hidden',
    backgroundColor: '#1B1B1B',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
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
  heroImageOverlay: {
    ...StyleSheet.absoluteFillObject,
  },
  heroTopActions: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 14,
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
  heroBottomContent: {
    position: 'absolute',
    left: 18,
    right: 18,
    bottom: 18,
  },
  name: {
    fontFamily: Fonts.serif,
    fontSize: 34,
    lineHeight: 36,
    color: '#FFFFFF',
  },
  nickname: {
    marginTop: 7,
    fontFamily: Fonts.mono,
    fontSize: 12,
    color: 'rgba(255,255,255,0.74)',
  },
  bio: {
    marginTop: 10,
    fontFamily: Fonts.serif,
    fontSize: 13,
    lineHeight: 18,
    color: 'rgba(255,255,255,0.82)',
  },
  statsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  statCard: {
    flex: 1,
    borderRadius: 11,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    backgroundColor: 'rgba(8,10,15,0.64)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statValue: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 16,
  },
  statLabel: {
    marginTop: 1,
    color: 'rgba(255,255,255,0.75)',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  followHint: {
    marginTop: 10,
    color: 'rgba(255,255,255,0.7)',
    fontFamily: Fonts.mono,
    fontSize: 11,
    textAlign: 'center',
  },
  sectionRailWrap: {
    marginBottom: 12,
  },
  sectionRailTitle: {
    marginBottom: 10,
    color: 'rgba(255,255,255,0.88)',
    fontFamily: Fonts.mono,
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 1.1,
  },
  sectionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  sectionTile: {
    width: '48.5%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 13,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(11,14,19,0.72)',
  },
  sectionTileLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
  },
  sectionTileTitle: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 10.8,
  },
  sectionTileCount: {
    color: 'rgba(255,255,255,0.84)',
    fontFamily: Fonts.mono,
    fontSize: 9.5,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  sectionEmptyHint: {
    marginTop: 10,
    color: 'rgba(255,255,255,0.66)',
    fontFamily: Fonts.serif,
    fontSize: 12.5,
  },
});
