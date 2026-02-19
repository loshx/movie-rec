import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';

import { useAuth } from '@/contexts/AuthContext';
import { Fonts, Spacing } from '@/constants/theme';
import { followTaste, getFollowingProfiles, getPublicProfile, type PublicProfile, unfollowTaste } from '@/lib/social-backend';
import { hasMlApi, syncMlFollowingGraph } from '@/lib/ml-recommendations';
import { GlassView } from '@/components/glass-view';

type PublicSectionKey = 'watchlist' | 'favorites' | 'actors' | 'directors' | 'watched' | 'rated';

export default function PublicUserProfileScreen() {
  const { user } = useAuth();
  const params = useLocalSearchParams();
  const targetId = Number(params.id ?? 0);

  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [following, setFollowing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [activeSection, setActiveSection] = useState<PublicSectionKey>('favorites');
  const [panelVisible, setPanelVisible] = useState(false);
  const sheetTranslateY = useRef(new Animated.Value(420)).current;
  const scrollRef = useRef<ScrollView | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setLoading(true);
        const [p, mineFollowing] = await Promise.all([
          getPublicProfile(targetId),
          user ? getFollowingProfiles(user.id) : Promise.resolve([]),
        ]);
        if (!mounted) return;
        setProfile(p);
        if (user) {
          setFollowing(mineFollowing.some((x) => x.user_id === targetId));
        }
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [targetId, user]);

  const title = useMemo(() => {
    if (!profile) return 'User profile';
    return profile.name || profile.nickname;
  }, [profile]);

  const currentUserId = Number((user as any)?.id ?? (user as any)?.user_id ?? 0);

  const closePanel = useCallback(() => {
    Animated.timing(sheetTranslateY, {
      toValue: 420,
      duration: 180,
      useNativeDriver: true,
    }).start(() => setPanelVisible(false));
  }, [sheetTranslateY]);

  const onSelectSection = useCallback((key: PublicSectionKey) => {
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

  useFocusEffect(
    useCallback(() => {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ y: 0, animated: false });
      });
    }, [targetId])
  );

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

  if (loading) {
    return (
      <View style={styles.loader}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  if (!profile) {
    return (
      <View style={styles.loader}>
        <Text style={styles.empty}>User not found.</Text>
      </View>
    );
  }

  const isOwnProfile =
    currentUserId > 0 && currentUserId === targetId;
  const canFollow = currentUserId > 0 && !isOwnProfile;

  return (
    <ScrollView ref={scrollRef} style={styles.root} contentContainerStyle={styles.scroll}>
      <Pressable style={styles.backBtn} onPress={() => router.back()}>
        <Ionicons name="arrow-back" size={18} color="#fff" />
        <Text style={styles.backText}>Back</Text>
      </Pressable>

      <View style={styles.hero}>
        {profile.avatar_url ? (
          <Image source={{ uri: profile.avatar_url }} style={styles.avatar} />
        ) : (
          <View style={styles.avatarFallback}>
            <Text style={styles.avatarFallbackText}>?</Text>
          </View>
        )}
        <Text style={styles.name}>{title}</Text>
        <Text style={styles.nick}>@{profile.nickname}</Text>
        <Text style={styles.bio}>{profile.bio || 'No bio yet.'}</Text>
        <Text style={styles.stats}>{profile.followers} followers • {profile.following} following</Text>

        {canFollow ? (
          <Pressable
            style={styles.followBtn}
            disabled={saving}
            onPress={async () => {
              if (!user) return;
              setSaving(true);
              try {
                if (following) {
                  await unfollowTaste(currentUserId, targetId);
                  setFollowing(false);
                  setProfile((prev) => (prev ? { ...prev, followers: Math.max(0, (prev.followers ?? 0) - 1) } : prev));
                } else {
                  await followTaste(currentUserId, targetId);
                  setFollowing(true);
                  setProfile((prev) => (prev ? { ...prev, followers: (prev.followers ?? 0) + 1 } : prev));
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
            }}>
            <Text style={styles.followText}>{following ? 'Unfollow' : 'Follow'}</Text>
          </Pressable>
        ) : user ? null : (
          <Text style={styles.followHint}>Sign in to follow taste.</Text>
        )}
      </View>

      <View style={styles.compactGrid}>
        <CompactTile
          title="Watchlist"
          count={(profile.watchlist ?? []).length}
          icon="bookmark"
          active={activeSection === 'watchlist'}
          onPress={() => onSelectSection('watchlist')}
        />
        <CompactTile
          title="Favorites"
          count={(profile.favorites ?? []).length}
          icon="heart"
          active={activeSection === 'favorites'}
          onPress={() => onSelectSection('favorites')}
        />
        <CompactTile
          title="Actors"
          count={(profile.favorite_actors ?? []).length}
          icon="people"
          active={activeSection === 'actors'}
          onPress={() => onSelectSection('actors')}
        />
        <CompactTile
          title="Directors"
          count={((profile as any).favorite_directors ?? []).length}
          icon="film"
          active={activeSection === 'directors'}
          onPress={() => onSelectSection('directors')}
        />
        <CompactTile
          title="Watched"
          count={(profile.watched ?? []).length}
          icon="checkmark-circle"
          active={activeSection === 'watched'}
          onPress={() => onSelectSection('watched')}
        />
        <CompactTile
          title="Rated"
          count={(profile.rated ?? []).length}
          icon="star"
          active={activeSection === 'rated'}
          onPress={() => onSelectSection('rated')}
        />
      </View>

      <Modal visible={panelVisible} transparent animationType="fade" onRequestClose={closePanel}>
        <View style={styles.sheetBackdrop}>
          <Pressable style={styles.sheetBackdropPress} onPress={closePanel} />
          <Animated.View
            style={[styles.sheet, { transform: [{ translateY: sheetTranslateY }] }]}
            {...sheetPanResponder.panHandlers}>
            <View style={styles.sheetHandle} />
            {activeSection === 'watchlist' ? <PanelMovieSection title="Watchlist" items={profile.watchlist ?? []} /> : null}
            {activeSection === 'favorites' ? <PanelMovieSection title="Favorites" items={profile.favorites ?? []} /> : null}
            {activeSection === 'actors' ? (
              <PanelPeopleSection title="Favorite Actors" items={profile.favorite_actors ?? []} role="actor" />
            ) : null}
            {activeSection === 'directors' ? (
              <PanelPeopleSection
                title="Favorite Directors"
                items={(profile as any).favorite_directors ?? []}
                role="director"
              />
            ) : null}
            {activeSection === 'watched' ? <PanelMovieSection title="Watched" items={profile.watched ?? []} /> : null}
            {activeSection === 'rated' ? <PanelMovieSection title="Rated" items={profile.rated ?? []} /> : null}
          </Animated.View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function CompactTile({
  title,
  count,
  icon,
  active,
  onPress,
}: {
  title: string;
  count: number;
  icon: keyof typeof Ionicons.glyphMap;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={styles.tilePressable}>
      <GlassView
        intensity={24}
        tint="dark"
        style={active ? { ...styles.compactTile, ...styles.compactTileActive } : styles.compactTile}>
        <View style={styles.compactTileHeader}>
          <Ionicons name={icon} size={16} color={active ? '#FFFFFF' : 'rgba(255,255,255,0.84)'} />
        </View>
        <Text style={styles.compactTileTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.compactTileCount}>{count}</Text>
      </GlassView>
    </Pressable>
  );
}

function PanelMovieSection({ title, items }: { title: string; items: any[] }) {
  const list = (items ?? []).slice(0, 40);

  return (
    <GlassView intensity={24} tint="dark" style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {list.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          {list.map((item, idx) => {
            const tmdbId = Number(item.tmdbId ?? item.tmdb_id ?? 0);
            const mediaType = item.mediaType === 'tv' ? 'tv' : 'movie';
            const poster = String(item.poster ?? item.poster_path ?? '').trim();
            const ratingText =
              typeof item.rating === 'number' && Number.isFinite(item.rating)
                ? `${item.rating}/10`
                : null;

            return (
              <Pressable
                key={`${title}-${idx}-${tmdbId}`}
                style={styles.card}
                onPress={() => {
                  if (!tmdbId) return;
                  router.push({
                    pathname: '/movie/[id]',
                    params: { id: String(tmdbId), type: mediaType },
                  });
                }}>
                {poster ? (
                  <Image source={{ uri: poster }} style={styles.poster} />
                ) : (
                  <View style={styles.posterFallback} />
                )}
                <Text style={styles.cardTitle} numberOfLines={1}>
                  {item.title ?? `TMDB #${tmdbId || idx}`}
                </Text>
                {ratingText ? <Text style={styles.cardMeta}>{ratingText}</Text> : null}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : (
        <Text style={styles.empty}>Private or empty.</Text>
      )}
    </GlassView>
  );
}

function PanelPeopleSection({
  title,
  items,
  role,
}: {
  title: string;
  items: any[];
  role: 'actor' | 'director';
}) {
  const list = (items ?? []).slice(0, 40);
  return (
    <GlassView intensity={24} tint="dark" style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {list.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          {list.map((item, idx) => {
            const personId = Number(item.personId ?? item.person_id ?? 0);
            const avatar = String(item.profile ?? item.avatar_url ?? item.poster ?? '').trim();
            return (
              <Pressable
                key={`${title}-${idx}-${personId}`}
                style={styles.personCard}
                onPress={() => {
                  if (!personId) return;
                  router.push({ pathname: '/person/[id]', params: { id: String(personId), role } });
                }}>
                {avatar ? <Image source={{ uri: avatar }} style={styles.personAvatar} /> : <View style={styles.personAvatarFallback} />}
                <Text style={styles.cardTitle} numberOfLines={1}>
                  {item.name ?? `Person #${personId || idx}`}
                </Text>
                <Text style={styles.cardMeta}>{role === 'director' ? 'Director' : 'Actor'}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : (
        <Text style={styles.empty}>Private or empty.</Text>
      )}
    </GlassView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#050505' },
  scroll: { padding: Spacing.four, paddingBottom: 100, gap: 12 },
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#050505' },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  backText: { color: '#fff', fontFamily: Fonts.mono, fontSize: 11 },
  hero: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    padding: Spacing.three,
    alignItems: 'center',
  },
  avatar: { width: 90, height: 90, borderRadius: 45, backgroundColor: 'rgba(255,255,255,0.08)' },
  avatarFallback: {
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarFallbackText: { color: '#fff', fontFamily: Fonts.serif, fontSize: 44 },
  name: { marginTop: 10, color: '#fff', fontFamily: Fonts.serif, fontSize: 22 },
  nick: { marginTop: 2, color: 'rgba(255,255,255,0.7)', fontFamily: Fonts.mono, fontSize: 12 },
  bio: { marginTop: 8, color: 'rgba(255,255,255,0.82)', fontFamily: Fonts.serif, fontSize: 13, textAlign: 'center' },
  stats: { marginTop: 8, color: 'rgba(255,255,255,0.78)', fontFamily: Fonts.mono, fontSize: 11 },
  followBtn: {
    marginTop: 10,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: '#C1121F',
  },
  followText: { color: '#fff', fontFamily: Fonts.mono, fontSize: 11 },
  followHint: {
    marginTop: 10,
    color: 'rgba(255,255,255,0.7)',
    fontFamily: Fonts.mono,
    fontSize: 11,
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
  section: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    padding: Spacing.three,
  },
  sectionTitle: { color: '#fff', fontFamily: Fonts.serif, fontSize: 17, marginBottom: 6 },
  row: {
    gap: 10,
    paddingRight: 4,
  },
  card: {
    width: 86,
  },
  personCard: {
    width: 86,
    alignItems: 'center',
  },
  personAvatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  personAvatarFallback: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  poster: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  posterFallback: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  cardTitle: {
    marginTop: 4,
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 11,
  },
  cardMeta: {
    marginTop: 1,
    color: 'rgba(255,255,255,0.72)',
    fontFamily: Fonts.mono,
    fontSize: 9,
  },
  empty: { color: 'rgba(255,255,255,0.6)', fontFamily: Fonts.serif, fontSize: 12 },
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
