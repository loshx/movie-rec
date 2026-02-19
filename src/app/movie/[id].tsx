import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  Vibration,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import ImageColors from 'react-native-image-colors';

import { GlassView } from '@/components/glass-view';
import { useAuth } from '@/contexts/AuthContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  addComment,
  getComments,
  getMovieState,
  MovieComment,
  setRating,
  toggleFavorite,
  toggleWatched,
  toggleWatchlist,
} from '@/db/user-movies';
import {
  backdropUrl,
  getMovieById,
  getMovieCredits,
  getMovieWatchProviders,
  getMovieVideos,
  getSimilarMovies,
  getSimilarTv,
  getTvById,
  getTvCredits,
  getTvWatchProviders,
  getTvVideos,
  Movie,
  posterUrl,
  providerLogoUrl,
  TmdbCast,
  TmdbCrew,
  TmdbVideo,
  TmdbWatchProvider,
  TvShow,
} from '@/lib/tmdb';
import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import YoutubePlayer from 'react-native-youtube-iframe';

function normalizeCommentAvatarUri(input?: string | null) {
  const value = String(input ?? '').trim();
  if (!value) return null;
  if (/^(https?:\/\/|blob:|file:\/\/|content:\/\/|ph:\/\/)/i.test(value)) {
    return value;
  }
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(value)) {
    return value;
  }
  return null;
}

function formatCommentTime(value?: string | null) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type DockActionButtonProps = {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  active?: boolean;
  activeColor?: string;
  onPress: () => void | Promise<void>;
};

function DockActionButton({
  icon,
  label,
  active = false,
  activeColor = '#fff',
  onPress,
}: DockActionButtonProps) {
  const pressed = useSharedValue(0);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - pressed.value * 0.08 }, { translateY: -pressed.value * 2 }],
    opacity: 1 - pressed.value * 0.06,
  }));

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        onPress={onPress}
        onPressIn={() => {
          pressed.value = withSpring(1, { damping: 16, stiffness: 260 });
        }}
        onPressOut={() => {
          pressed.value = withSpring(0, { damping: 18, stiffness: 220 });
        }}
        style={[styles.dockBtn, active && styles.dockBtnActive]}>
        <Ionicons
          name={icon}
          size={18}
          color={active ? activeColor : '#fff'}
        />
        <Text style={styles.dockBtnLabel}>{label}</Text>
      </Pressable>
    </Animated.View>
  );
}

export default function MovieDetailScreen() {
  const theme = useTheme();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams();
  const tmdbId = Number(params.id ?? 0);
  const mediaType = params.type === 'tv' ? 'tv' : 'movie';

  const [movie, setMovie] = useState<Movie | TvShow | null>(null);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState({
    inWatchlist: false,
    inFavorites: false,
    watched: false,
    rating: null as number | null,
  });
  const [trailer, setTrailer] = useState<TmdbVideo | null>(null);
  const [similar, setSimilar] = useState<(Movie | TvShow)[]>([]);
  const [cast, setCast] = useState<TmdbCast[]>([]);
  const [director, setDirector] = useState<TmdbCrew | null>(null);
  const [watchProviders, setWatchProviders] = useState<TmdbWatchProvider[]>([]);
  const [watchProvidersLink, setWatchProvidersLink] = useState<string | null>(null);
  const [showWatchProviders, setShowWatchProviders] = useState(false);
  const [watchToastVisible, setWatchToastVisible] = useState(false);
  const [comments, setComments] = useState<MovieComment[]>([]);
  const [commentText, setCommentText] = useState('');
  const [replyTo, setReplyTo] = useState<MovieComment | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const sheetY = useSharedValue(0);
  const sheetStart = useSharedValue(0);
  const watchModalOpacity = useSharedValue(0);
  const watchModalScale = useSharedValue(0.92);
  const watchButtonShakeX = useSharedValue(0);
  const watchToastOpacity = useSharedValue(0);
  const watchToastTranslateY = useSharedValue(14);
  const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
  const sheetPeek = 72;
  const sheetClosedY = screenHeight - sheetPeek;
  const heroHeight = Math.round(Math.min(screenHeight * 0.7, screenWidth * 1.5));

  const accent = useMemo(() => {
    if (!tmdbId) return '#3B82F6';
    const hue = (tmdbId * 47) % 360;
    return `hsl(${hue}, 70%, 55%)`;
  }, [tmdbId]);
  const [accentColor, setAccentColor] = useState(accent);
  const watchToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);

  const heroGradientColors = useMemo<readonly [string, string, string, string]>(() => {
    if (theme.mode === 'light') {
      return ['rgba(255,255,255,0)', `${theme.background}33`, `${theme.background}99`, theme.background];
    }
    return ['rgba(0,0,0,0)', `${theme.background}22`, `${theme.background}88`, theme.background];
  }, [theme.background, theme.mode]);
  const heroEdgeFadeColors = useMemo<readonly [string, string, string, string]>(
    () => ['rgba(0,0,0,0)', `${theme.background}66`, `${theme.background}CC`, theme.background],
    [theme.background]
  );

  useEffect(() => {
    setAccentColor(accent);
  }, [accent]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setLoading(true);
        const data = mediaType === 'tv' ? await getTvById(tmdbId) : await getMovieById(tmdbId);
        if (mounted) setMovie(data);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [mediaType, tmdbId]);

  useEffect(() => {
    if (!movie) return;
    if (Platform.OS === 'web') return;
    const imageForColor =
      posterUrl(movie.poster_path, 'w342') ||
      backdropUrl(movie.backdrop_path, 'w780');
    if (!imageForColor) return;
    let canceled = false;
    (async () => {
      try {
        const result = await ImageColors.getColors(imageForColor, {
          fallback: accent,
          cache: true,
          key: imageForColor,
        } as any);
        if (canceled) return;
        let next = accent;
        if (result.platform === 'android') {
          next = (result as any).dominant ?? accent;
        } else if (result.platform === 'ios') {
          next = (result as any).primary ?? (result as any).secondary ?? accent;
        } else if (result.platform === 'web') {
          next = (result as any).dominant ?? accent;
        } else {
          next = (result as any).background ?? accent;
        }
        setAccentColor(next);
      } catch {
        setAccentColor(accent);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [movie, accent]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [videosRes, similarRes, creditsRes, providersRes] = await Promise.all([
          mediaType === 'tv' ? getTvVideos(tmdbId) : getMovieVideos(tmdbId),
          mediaType === 'tv' ? getSimilarTv(tmdbId, 1) : getSimilarMovies(tmdbId, 1),
          mediaType === 'tv' ? getTvCredits(tmdbId) : getMovieCredits(tmdbId),
          mediaType === 'tv' ? getTvWatchProviders(tmdbId) : getMovieWatchProviders(tmdbId),
        ]);
        if (!mounted) return;

        const videos = videosRes.results ?? [];
        const best =
          videos.find((v) => v.site === 'YouTube' && v.type === 'Trailer' && v.official) ??
          videos.find((v) => v.site === 'YouTube' && v.type === 'Trailer') ??
          videos.find((v) => v.site === 'YouTube');
        setTrailer(best ?? null);
        setSimilar((similarRes.results ?? []).filter((item) => !!item.poster_path).slice(0, 12));
        setCast(
          (creditsRes.cast ?? [])
            .filter((person) => !!person.profile_path)
            .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
            .slice(0, 18)
        );
        const chosenDirector =
          (creditsRes.crew ?? []).find((person) => person.job === 'Director' && !!person.profile_path) ??
          (creditsRes.crew ?? []).find((person) => person.job === 'Director') ??
          null;
        setDirector(chosenDirector);
        const regionResults = providersRes.results ?? {};
        const preferredRegion =
          regionResults.US ?? regionResults.GB ?? regionResults.RO ?? null;
        const hasAnyProvider = (region: any) =>
          !!(
            (region?.flatrate ?? []).length ||
            (region?.rent ?? []).length ||
            (region?.buy ?? []).length ||
            (region?.free ?? []).length ||
            (region?.ads ?? []).length
          );
        const regionFromAnyMarket =
          Object.values(regionResults).find((region: any) => hasAnyProvider(region)) ?? null;
        const regionWithLink =
          Object.values(regionResults).find((region: any) => String(region?.link ?? '').trim()) ?? null;
        const region = preferredRegion ?? regionFromAnyMarket ?? regionWithLink;
        const merged = [
          ...(region?.flatrate ?? []),
          ...(region?.rent ?? []),
          ...(region?.buy ?? []),
          ...(region?.free ?? []),
          ...(region?.ads ?? []),
        ];
        const uniqueByProvider = new Map<number, TmdbWatchProvider>();
        for (const provider of merged) {
          if (!provider?.provider_id) continue;
          if (!uniqueByProvider.has(provider.provider_id)) {
            uniqueByProvider.set(provider.provider_id, provider);
          }
        }
        setWatchProviders(Array.from(uniqueByProvider.values()).slice(0, 12));
        setWatchProvidersLink(region?.link ?? null);
        setShowWatchProviders(false);
      } catch {
        if (!mounted) return;
        setTrailer(null);
        setSimilar([]);
        setCast([]);
        setDirector(null);
        setWatchProviders([]);
        setWatchProvidersLink(null);
        setShowWatchProviders(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [mediaType, tmdbId]);

  const refreshState = useCallback(async () => {
    if (!user) return;
    const next = await getMovieState(user.id, tmdbId);
    setState(next);
  }, [tmdbId, user]);

  const refreshComments = useCallback(async () => {
    const next = await getComments(tmdbId);
    setComments(next);
  }, [tmdbId]);

  useEffect(() => {
    if (!user) return;
    refreshState();
    refreshComments();
  }, [refreshComments, refreshState, user]);

  useEffect(() => {
    sheetY.value = sheetClosedY;
  }, [sheetClosedY, sheetY]);

  useFocusEffect(
    useCallback(() => {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ y: 0, animated: false });
      });
    }, [tmdbId, mediaType])
  );

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: sheetY.value }],
  }));
  const watchModalOverlayStyle = useAnimatedStyle(() => ({
    opacity: watchModalOpacity.value,
  }));
  const watchModalCardStyle = useAnimatedStyle(() => ({
    opacity: watchModalOpacity.value,
    transform: [{ scale: watchModalScale.value }],
  }));
  const watchButtonShakeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: watchButtonShakeX.value }],
  }));
  const watchToastAnimatedStyle = useAnimatedStyle(() => ({
    opacity: watchToastOpacity.value,
    transform: [{ translateY: watchToastTranslateY.value }],
  }));

  const openCommentsSheet = useCallback(() => {
    setCommentsOpen(true);
    sheetY.value = withSpring(0, { damping: 18, stiffness: 160 });
  }, [sheetY]);

  useEffect(() => {
    if (showWatchProviders) {
      watchModalOpacity.value = withTiming(1, { duration: 220 });
      watchModalScale.value = withTiming(1, { duration: 240 });
      return;
    }
    watchModalOpacity.value = 0;
    watchModalScale.value = 0.92;
  }, [showWatchProviders, watchModalOpacity, watchModalScale]);

  const triggerWatchUnavailableFeedback = useCallback(() => {
    watchButtonShakeX.value = withSequence(
      withTiming(-9, { duration: 45 }),
      withTiming(9, { duration: 70 }),
      withTiming(-7, { duration: 60 }),
      withTiming(6, { duration: 55 }),
      withTiming(0, { duration: 45 })
    );
    Vibration.vibrate(14);
    setWatchToastVisible(true);
    if (watchToastTimerRef.current) clearTimeout(watchToastTimerRef.current);
    watchToastTimerRef.current = setTimeout(() => {
      setWatchToastVisible(false);
      watchToastTimerRef.current = null;
    }, 2100);
  }, [watchButtonShakeX]);

  useEffect(() => {
    watchToastOpacity.value = withTiming(watchToastVisible ? 1 : 0, { duration: 180 });
    watchToastTranslateY.value = withTiming(watchToastVisible ? 0 : 14, { duration: 220 });
  }, [watchToastOpacity, watchToastTranslateY, watchToastVisible]);

  useEffect(() => {
    return () => {
      if (watchToastTimerRef.current) clearTimeout(watchToastTimerRef.current);
    };
  }, []);

  const handleBackPress = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/');
  }, []);

  if (loading || !movie) {
    return (
      <View style={[styles.loader, { backgroundColor: theme.background }]}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  const onSendComment = async () => {
    if (!user) return;
    await addComment(
      user.id,
      tmdbId,
      commentText,
      replyTo?.id ?? null,
      user.nickname,
      normalizeCommentAvatarUri((user as any)?.avatar_url ?? null)
    );
    setCommentText('');
    setReplyTo(null);
    refreshComments();
  };
  const trailerUrl = trailer?.key ? `https://www.youtube.com/watch?v=${trailer.key}` : null;

  const rootComments = comments
    .filter((c) => !c.parent_id)
    .sort(
      (a, b) =>
        new Date(String(b.created_at ?? '')).getTime() -
        new Date(String(a.created_at ?? '')).getTime()
    );
  const repliesByParent = comments.reduce<Record<number, MovieComment[]>>((acc, c) => {
    if (c.parent_id) {
      acc[c.parent_id] = acc[c.parent_id] ?? [];
      acc[c.parent_id].push(c);
      acc[c.parent_id].sort(
        (a, b) =>
          new Date(String(b.created_at ?? '')).getTime() -
          new Date(String(a.created_at ?? '')).getTime()
      );
    }
    return acc;
  }, {});

  const titleText = movie ? ('title' in movie ? movie.title : movie.name) : '';
  const overviewText = movie?.overview ?? '';
  const dateText =
    movie && 'release_date' in movie
      ? movie.release_date
      : movie && 'first_air_date' in movie
        ? movie.first_air_date
        : '';
  const yearText =
    typeof dateText === 'string' && /^\d{4}/.test(dateText) ? dateText.slice(0, 4) : null;
  const heroImageUri =
    posterUrl(movie?.poster_path, 'w500') ??
    backdropUrl(movie?.backdrop_path, 'w1280') ??
    undefined;
  const hasHeroImage = !!heroImageUri;
  const hasVoteAverage = (movie.vote_average ?? 0) > 0;
  const watchBgUri =
    posterUrl(movie?.poster_path, 'w342') ??
    backdropUrl(movie?.backdrop_path, 'w780') ??
    undefined;
  const isWeb = Platform.OS === 'web';
  const watchBorderColor = isWeb ? 'rgba(255,255,255,0.34)' : accentColor;
  const watchGlowColors: readonly [string, string, string, string] = isWeb
    ? [
        'rgba(255,255,255,0.18)',
        'rgba(255,255,255,0.10)',
        'rgba(255,255,255,0.05)',
        'rgba(255,255,255,0.02)',
      ]
    : [
        `${accentColor}F2`,
        `${accentColor}A8`,
        `${accentColor}52`,
        'rgba(255,255,255,0.08)',
      ];
  const activeActionColor = isWeb ? '#E5E7EB' : accentColor;
  const floatingBackTop = Math.max(insets.top + 8, 16);

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <Pressable onPress={handleBackPress} style={[styles.floatingBackBtn, { top: floatingBackTop }]}>
          <Ionicons name="chevron-back" size={20} color="#fff" />
        </Pressable>
        <ScrollView
          ref={scrollRef}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.scroll}
          scrollEnabled={!commentsOpen}
          onScrollEndDrag={(event) => {
            if (commentsOpen) return;
            const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
            const nearBottom =
              contentOffset.y + layoutMeasurement.height >= contentSize.height - 24;
            if (nearBottom) {
              openCommentsSheet();
            }
          }}
          onMomentumScrollEnd={(event) => {
            if (commentsOpen) return;
            const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
            const nearBottom =
              contentOffset.y + layoutMeasurement.height >= contentSize.height - 24;
            if (nearBottom) {
              openCommentsSheet();
            }
          }}>
          {hasHeroImage ? (
            <View style={[styles.hero, { backgroundColor: theme.background, height: heroHeight }]}>
              <Image
                source={{ uri: heroImageUri }}
                style={styles.heroImage}
                contentFit="cover"
                contentPosition="top"
              />
              <LinearGradient
                colors={heroGradientColors}
                style={styles.heroGradient}
              />
              <LinearGradient colors={heroEdgeFadeColors} style={styles.heroSeamFade} />
            </View>
          ) : (
            <View style={[styles.heroFallback, { backgroundColor: theme.background }]} />
          )}

          <View style={[styles.headerRow, !hasHeroImage && styles.headerRowNoHero]}>
            <View>
              <Text style={[styles.title, styles.textShadow]}>{titleText}</Text>
              <Pressable style={styles.aboutRow} onPress={() => setAboutOpen((v) => !v)}>
                <Text style={styles.aboutLabel}>About movie</Text>
                {yearText ? <Text style={styles.aboutYear}>• {yearText}</Text> : null}
                <Ionicons name={aboutOpen ? 'chevron-up' : 'chevron-down'} size={18} color="#fff" />
              </Pressable>
            </View>
            {hasVoteAverage ? (
              <View style={styles.ratingChip}>
                <Text style={[styles.ratingText, styles.textShadow]}>{movie.vote_average.toFixed(1)}</Text>
                <Ionicons name="star" size={14} color="#facc15" />
              </View>
            ) : null}
          </View>

          {aboutOpen ? (
            <Text style={styles.overview}>{overviewText || 'No overview available.'}</Text>
          ) : null}

          <View style={styles.actionsRow}>
            <Animated.View style={watchButtonShakeStyle}>
              <Pressable
                style={[styles.watchBtn, { borderColor: watchBorderColor }]}
                onPress={() => {
                  if (watchProviders.length > 0) {
                    setShowWatchProviders((prev) => !prev);
                    return;
                  }
                  if (watchProvidersLink) {
                    Linking.openURL(watchProvidersLink).catch(() => {});
                    return;
                  }
                  triggerWatchUnavailableFeedback();
                }}>
                {watchBgUri ? (
                  <Image
                    source={{ uri: watchBgUri }}
                    style={styles.watchBgImage}
                    contentFit="cover"
                    blurRadius={18}
                  />
                ) : null}
                <LinearGradient
                  colors={['rgba(0,0,0,0.08)', 'rgba(0,0,0,0.48)']}
                  style={styles.watchBgTint}
                />
                <LinearGradient colors={watchGlowColors} style={styles.watchGlow} />
                <LinearGradient
                  colors={[
                    'rgba(255,255,255,0.42)',
                    'rgba(255,255,255,0.10)',
                    'rgba(255,255,255,0)',
                  ]}
                  start={{ x: 0.5, y: 0 }}
                  end={{ x: 0.5, y: 1 }}
                  style={styles.watchHighlight}
                />
                <GlassView
                  intensity={52}
                  tint={theme.mode === 'light' ? 'light' : 'dark'}
                  style={styles.watchGlass}>
                  <Text style={styles.watchText}>WATCH</Text>
                </GlassView>
              </Pressable>
            </Animated.View>
            <GlassView intensity={40} tint={theme.mode === 'light' ? 'light' : 'dark'} style={styles.quickDock}>
              <View style={styles.quickDockRow}>
                <DockActionButton
                  icon={state.inWatchlist ? 'time' : 'time-outline'}
                  label="Watchlist"
                  active={state.inWatchlist}
                  activeColor={activeActionColor}
                  onPress={async () => {
                    if (!user) return;
                    await toggleWatchlist(user.id, tmdbId, mediaType);
                    refreshState();
                  }}
                />
                <DockActionButton
                  icon={state.inFavorites ? 'heart' : 'heart-outline'}
                  label="Like"
                  active={state.inFavorites}
                  activeColor="#EF4444"
                  onPress={async () => {
                    if (!user) return;
                    await toggleFavorite(user.id, tmdbId, mediaType);
                    refreshState();
                  }}
                />
                <DockActionButton
                  icon={state.watched ? 'checkmark-circle' : 'checkmark-circle-outline'}
                  label={state.watched ? 'Watched' : 'Seen'}
                  active={state.watched}
                  activeColor="#22C55E"
                  onPress={async () => {
                    if (!user) return;
                    await toggleWatched(user.id, tmdbId, mediaType);
                    refreshState();
                  }}
                />
                <DockActionButton
                  icon="chatbubble-ellipses-outline"
                  label="Comments"
                  onPress={openCommentsSheet}
                />
              </View>
            </GlassView>
          </View>

          <View style={styles.starsRow}>
            {Array.from({ length: 10 }).map((_, idx) => {
              const value = idx + 1;
              const active = (state.rating ?? 0) >= value;
              return (
                <Pressable
                  key={value}
                  onPress={async () => {
                    if (!user) return;
                    await setRating(user.id, tmdbId, value, mediaType);
                    refreshState();
                  }}>
                  <Ionicons
                    name={active ? 'star' : 'star-outline'}
                    size={20}
                    color={active ? activeActionColor : '#777'}
                  />
                </Pressable>
              );
            })}
          </View>

          <View style={styles.extraSection}>
            <Text style={styles.sectionLabel}>TRAILER</Text>
            {trailer && trailer.site === 'YouTube' && Platform.OS !== 'web' ? (
              <View style={styles.trailerPlayerWrap}>
                <YoutubePlayer
                  height={208}
                  play={false}
                  videoId={trailer.key}
                  initialPlayerParams={{ modestbranding: true }}
                />
              </View>
            ) : trailerUrl ? (
              <Pressable style={styles.trailerBtn} onPress={() => Linking.openURL(trailerUrl)}>
                <Ionicons name="logo-youtube" size={16} color="#fff" />
                <Text style={styles.trailerText} numberOfLines={1}>
                  Watch on YouTube
                </Text>
              </Pressable>
            ) : (
              <Text style={styles.emptyText}>Trailer unavailable.</Text>
            )}
          </View>

          <View style={styles.extraSection}>
            <Text style={styles.sectionLabel}>SIMILAR MOVIES</Text>
            {similar.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.similarRow}>
                {similar.map((item, idx) => (
                  <Pressable
                    key={`${item.id}-${idx}`}
                    style={styles.similarCard}
                    onPress={() =>
                      router.push({
                        pathname: '/movie/[id]',
                        params: { id: String(item.id), type: mediaType },
                      })
                    }>
                    <Image
                      source={{ uri: posterUrl(item.poster_path, 'w342') ?? undefined }}
                      style={styles.similarPoster}
                      contentFit="cover"
                    />
                    <GlassView intensity={28} tint="dark" style={styles.similarGlass}>
                      <Text style={styles.similarTitle} numberOfLines={1}>
                        {'title' in item ? item.title : item.name}
                      </Text>
                    </GlassView>
                  </Pressable>
                ))}
              </ScrollView>
            ) : (
              <Text style={styles.emptyText}>No recommendations right now.</Text>
            )}
          </View>

          <View style={styles.extraSection}>
            <Text style={styles.sectionLabel}>DIRECTOR</Text>
            {director ? (
              <Pressable
                style={styles.castCard}
                onPress={() => router.push({ pathname: '/person/[id]', params: { id: String(director.id), role: 'director' } })}>
                <Image source={{ uri: posterUrl(director.profile_path, 'w342') ?? undefined }} style={styles.castImage} contentFit="cover" />
                <GlassView intensity={28} tint="dark" style={styles.castGlass}>
                  <Text style={styles.castName} numberOfLines={1}>
                    {director.name}
                  </Text>
                  <Text style={styles.castRole} numberOfLines={1}>
                    Director
                  </Text>
                </GlassView>
              </Pressable>
            ) : (
              <Text style={styles.emptyText}>Director unavailable.</Text>
            )}
          </View>

          <View style={styles.extraSection}>
            <Text style={styles.sectionLabel}>ACTORS</Text>
            {cast.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.castRow}>
                {cast.map((person) => (
                  <Pressable
                    key={person.id}
                    style={styles.castCard}
                    onPress={() =>
                      router.push({ pathname: '/person/[id]', params: { id: String(person.id), role: 'actor' } })
                    }>
                    <Image
                      source={{ uri: posterUrl(person.profile_path, 'w342') ?? undefined }}
                      style={styles.castImage}
                      contentFit="cover"
                    />
                    <GlassView intensity={28} tint="dark" style={styles.castGlass}>
                      <Text style={styles.castName} numberOfLines={1}>
                        {person.name}
                      </Text>
                      {person.character ? (
                        <Text style={styles.castRole} numberOfLines={1}>
                          {person.character}
                        </Text>
                      ) : null}
                    </GlassView>
                  </Pressable>
                ))}
              </ScrollView>
            ) : (
              <Text style={styles.emptyText}>Cast unavailable.</Text>
            )}
          </View>

        </ScrollView>

        <GestureDetector
          gesture={Gesture.Pan()
            .onStart(() => {
              sheetStart.value = sheetY.value;
            })
            .onUpdate((event) => {
              const next = Math.max(0, Math.min(sheetClosedY, sheetStart.value + event.translationY));
              sheetY.value = next;
            })
            .onEnd(() => {
              const shouldOpen = sheetY.value < screenHeight * 0.35;
              const target = shouldOpen ? 0 : sheetClosedY;
              sheetY.value = withSpring(target, { damping: 18, stiffness: 160 });
              runOnJS(setCommentsOpen)(shouldOpen);
            })}>
          <Animated.View
            pointerEvents="auto"
            style={[
              styles.commentsSheet,
              sheetStyle,
            ]}>
            <View style={styles.sheetHandle}>
              <Text style={styles.commentsTitle}>COMMENTS</Text>
              <Ionicons name="chevron-down" size={22} color="#fff" />
            </View>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.commentsWrap}>
              {rootComments.map((comment) => (
                <View key={comment.id} style={styles.commentCard}>
                  {/** Avoid rendering invalid/truncated avatar URLs on web. */}
                  {(() => {
                    const avatarUri = normalizeCommentAvatarUri(comment.avatar_url ?? null);
                    return (
                  <Pressable
                    style={styles.avatarCircle}
                    onPress={() => router.push(`/user/${comment.public_user_id ?? comment.user_id}` as any)}
                  >
                    {avatarUri ? (
                      <Image source={{ uri: avatarUri }} style={styles.avatarCircleImage} contentFit="cover" />
                    ) : (
                      <Text style={styles.avatarFallbackText}>?</Text>
                    )}
                  </Pressable>
                    );
                  })()}
                  <View style={styles.commentBody}>
                    <View style={styles.commentMeta}>
                      <Pressable
                        style={styles.commentNamePressable}
                        onPress={() => router.push(`/user/${comment.public_user_id ?? comment.user_id}` as any)}>
                        <Text style={styles.commentName} numberOfLines={1} ellipsizeMode="tail">
                          {comment.nickname}
                        </Text>
                      </Pressable>
                      <Text style={styles.commentTime}>{formatCommentTime(comment.created_at)}</Text>
                    </View>
                    <Text style={styles.commentText}>{comment.text}</Text>
                    <Pressable onPress={() => setReplyTo(comment)}>
                      <Text style={styles.replyText}>Reply</Text>
                    </Pressable>
                    {(repliesByParent[comment.id] ?? []).map((reply) => (
                      <View key={reply.id} style={styles.replyCard}>
                        {(() => {
                          const replyAvatarUri = normalizeCommentAvatarUri(reply.avatar_url ?? null);
                          return (
                        <Pressable
                          style={styles.avatarMini}
                          onPress={() => router.push(`/user/${reply.public_user_id ?? reply.user_id}` as any)}
                        >
                          {replyAvatarUri ? (
                            <Image source={{ uri: replyAvatarUri }} style={styles.avatarMiniImage} contentFit="cover" />
                          ) : (
                            <Text style={styles.avatarMiniFallbackText}>?</Text>
                          )}
                        </Pressable>
                          );
                        })()}
                        <View>
                          <View style={styles.commentMeta}>
                            <Pressable
                              style={styles.commentNamePressable}
                              onPress={() => router.push(`/user/${reply.public_user_id ?? reply.user_id}` as any)}>
                              <Text style={styles.commentName} numberOfLines={1} ellipsizeMode="tail">
                                {reply.nickname}
                              </Text>
                            </Pressable>
                            <Text style={styles.commentTime}>{formatCommentTime(reply.created_at)}</Text>
                          </View>
                          <Text style={styles.commentText}>{reply.text}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                </View>
              ))}
            </ScrollView>
            <Text style={styles.leaveComment}>leave comment</Text>
            {replyTo ? (
              <Text style={styles.replyingTo}>Replying to @{replyTo.nickname}</Text>
            ) : null}
            <View style={styles.commentInputRow}>
              <TextInput
                value={commentText}
                onChangeText={setCommentText}
                placeholder="Write a comment..."
                placeholderTextColor="rgba(255,255,255,0.6)"
                style={styles.commentInput}
              />
              <Pressable onPress={onSendComment} style={styles.sendBtn}>
                <Ionicons name="send" size={18} color="#fff" />
              </Pressable>
            </View>
          </Animated.View>
        </GestureDetector>

        <Modal
          visible={showWatchProviders}
          transparent
          animationType="none"
          onRequestClose={() => setShowWatchProviders(false)}>
          <Animated.View style={[styles.watchModalBackdrop, watchModalOverlayStyle]}>
            <Pressable style={styles.watchModalBackdropTap} onPress={() => setShowWatchProviders(false)} />
            <Animated.View style={[styles.watchModalCard, watchModalCardStyle]}>
              <View style={styles.watchModalHeader}>
                <Text style={styles.watchModalTitle}>Where to watch</Text>
                <Pressable onPress={() => setShowWatchProviders(false)} style={styles.watchModalCloseBtn}>
                  <Ionicons name="close" size={18} color="#fff" />
                </Pressable>
              </View>
              <Text style={styles.watchModalHint}>Choose a platform</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.watchModalRow}>
                {watchProviders.map((provider) => (
                  <Pressable
                    key={`modal-watch-${provider.provider_id}`}
                    style={styles.watchModalLogoBtn}
                    onPress={() => {
                      setShowWatchProviders(false);
                      if (watchProvidersLink) {
                        void Linking.openURL(watchProvidersLink);
                      }
                    }}>
                    {provider.logo_path ? (
                      <Image
                        source={{ uri: providerLogoUrl(provider.logo_path, 'w92') ?? undefined }}
                        style={styles.watchModalLogo}
                        contentFit="cover"
                      />
                    ) : (
                      <View style={styles.watchModalLogoFallback}>
                        <Text style={styles.watchModalLogoFallbackText} numberOfLines={1}>
                          {provider.provider_name.slice(0, 2).toUpperCase()}
                        </Text>
                      </View>
                    )}
                  </Pressable>
                ))}
              </ScrollView>
            </Animated.View>
          </Animated.View>
        </Modal>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.watchToast,
            { bottom: Math.max(insets.bottom + 104, 122) },
            watchToastAnimatedStyle,
          ]}>
          <Ionicons name="information-circle" size={16} color="#fff" />
          <Text style={styles.watchToastText}>No providers listed yet</Text>
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  scroll: {
    paddingBottom: 120,
  },
  loader: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hero: {
    height: 420,
    overflow: 'visible',
  },
  heroFallback: {
    height: 88,
  },
  heroSeamFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: -2,
    height: 220,
  },
  heroImage: {
    width: '100%',
    height: '100%',
  },
  heroGradient: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: -120,
    height: 460,
  },
  floatingBackBtn: {
    position: 'absolute',
    left: 16,
    width: 38,
    height: 38,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    zIndex: 20,
  },
  headerRow: {
    marginTop: -80,
    paddingHorizontal: Spacing.four,
  },
  headerRowNoHero: {
    marginTop: Spacing.one,
  },
  title: {
    fontFamily: Fonts.serif,
    fontSize: 28,
    color: '#fff',
  },
  aboutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
  },
  aboutLabel: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 14,
  },
  aboutYear: {
    color: 'rgba(255,255,255,0.8)',
    fontFamily: Fonts.mono,
    fontSize: 13,
  },
  ratingChip: {
    position: 'absolute',
    left: Spacing.four,
    top: -30,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  ratingText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 14,
  },
  textShadow: {
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
  },
  overview: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
    color: 'rgba(255,255,255,0.7)',
    fontFamily: Fonts.serif,
    fontSize: 13,
    textShadowColor: 'rgba(0,0,0,0.65)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
  },
  actionsRow: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.four,
    gap: Spacing.two,
  },
  watchBtn: {
    flex: 1,
    borderRadius: 22,
    alignItems: 'center',
    borderWidth: 1.2,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.06)',
    shadowColor: '#000',
    shadowOpacity: 0.32,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
  },
  watchBgImage: {
    ...StyleSheet.absoluteFillObject,
  },
  watchBgTint: {
    ...StyleSheet.absoluteFillObject,
  },
  watchGlow: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.95,
  },
  watchHighlight: {
    position: 'absolute',
    left: 8,
    right: 8,
    top: 7,
    height: 20,
    borderRadius: 14,
    opacity: 0.9,
  },
  watchGlass: {
    width: '100%',
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.16)',
  },
  watchText: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 18,
    letterSpacing: 1,
  },
  watchToast: {
    position: 'absolute',
    left: 16,
    right: 16,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(18,20,26,0.94)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  watchToastText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 12,
  },
  quickDock: {
    width: '100%',
    borderRadius: 18,
    paddingHorizontal: 8,
    paddingVertical: 7,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  quickDockRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  dockBtn: {
    flex: 1,
    minWidth: 0,
    height: 56,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 6,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  dockBtnActive: {
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderColor: 'rgba(255,255,255,0.26)',
  },
  dockBtnLabel: {
    color: 'rgba(255,255,255,0.94)',
    fontFamily: Fonts.mono,
    fontSize: 10,
    letterSpacing: 0.3,
  },
  starsRow: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
  },
  extraSection: {
    marginTop: Spacing.three,
    paddingHorizontal: Spacing.four,
  },
  sectionLabel: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 18,
    marginBottom: Spacing.two,
  },
  trailerPlayerWrap: {
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  trailerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  trailerText: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 14,
    flex: 1,
  },
  emptyText: {
    color: 'rgba(255,255,255,0.65)',
    fontFamily: Fonts.serif,
    fontSize: 12,
  },
  similarRow: {
    gap: 10,
    paddingBottom: 4,
  },
  similarCard: {
    width: 116,
    borderRadius: 12,
    overflow: 'hidden',
    position: 'relative',
  },
  similarPoster: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  similarGlass: {
    position: 'absolute',
    left: 6,
    right: 6,
    bottom: 6,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: 'rgba(0,0,0,0.28)',
  },
  similarTitle: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 11,
  },
  watchModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.66)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 18,
  },
  watchModalBackdropTap: {
    ...StyleSheet.absoluteFillObject,
  },
  watchModalCard: {
    width: '100%',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(8,8,10,0.96)',
    padding: 14,
  },
  watchModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  watchModalTitle: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 20,
  },
  watchModalCloseBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  watchModalHint: {
    marginTop: 4,
    marginBottom: 12,
    color: 'rgba(255,255,255,0.74)',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  watchModalRow: {
    gap: 10,
    paddingRight: 4,
  },
  watchModalLogoBtn: {
    width: 56,
    height: 56,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  watchModalLogo: {
    width: '100%',
    height: '100%',
  },
  watchModalLogoFallback: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  watchModalLogoFallbackText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 12,
  },
  castRow: {
    gap: 10,
    paddingBottom: 4,
  },
  castCard: {
    width: 116,
    borderRadius: 12,
    overflow: 'hidden',
    position: 'relative',
  },
  castImage: {
    width: '100%',
    aspectRatio: 2 / 3,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  castGlass: {
    position: 'absolute',
    left: 6,
    right: 6,
    bottom: 6,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: 'rgba(0,0,0,0.28)',
  },
  castName: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 11,
  },
  castRole: {
    marginTop: 2,
    color: 'rgba(255,255,255,0.72)',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  commentsTitle: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 22,
    letterSpacing: 2,
  },
  commentsWrap: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    gap: Spacing.three,
    paddingBottom: 120,
  },
  commentsSheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '100%',
    backgroundColor: 'rgba(7,8,10,0.96)',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    paddingTop: Spacing.three,
  },
  sheetHandle: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.two,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  commentCard: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  avatarCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#3B82F6',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarCircleImage: {
    width: '100%',
    height: '100%',
  },
  avatarFallbackText: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 24,
    lineHeight: 24,
  },
  commentBody: {
    flex: 1,
    gap: 6,
  },
  commentMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  commentNamePressable: {
    flex: 1,
    minWidth: 0,
  },
  commentName: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 14,
  },
  commentTime: {
    color: 'rgba(255,255,255,0.62)',
    fontFamily: Fonts.mono,
    fontSize: 10,
    flexShrink: 0,
    marginLeft: 8,
    textAlign: 'right',
  },
  commentText: {
    color: 'rgba(255,255,255,0.9)',
    fontFamily: Fonts.serif,
    fontSize: 12,
    lineHeight: 18,
  },
  replyText: {
    color: '#CBD5E1',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  replyCard: {
    flexDirection: 'row',
    gap: Spacing.one,
    marginTop: Spacing.one,
    paddingLeft: Spacing.two,
    paddingTop: Spacing.one,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.09)',
  },
  avatarMini: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#60A5FA',
    marginTop: 4,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarMiniImage: {
    width: '100%',
    height: '100%',
  },
  avatarMiniFallbackText: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 12,
    lineHeight: 12,
  },
  leaveComment: {
    color: 'rgba(255,255,255,0.7)',
    fontFamily: Fonts.serif,
    fontSize: 16,
  },
  replyingTo: {
    color: 'rgba(255,255,255,0.6)',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  commentInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.two,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
    backgroundColor: 'rgba(255,255,255,0.1)',
    marginBottom: Spacing.six,
  },
  commentInput: {
    flex: 1,
    color: '#fff',
    fontFamily: Fonts.serif,
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(193,18,31,0.72)',
  },
});
