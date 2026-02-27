import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Keyboard,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

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
  getMovieRecommendations,
  getMovieWatchProviders,
  getMovieVideos,
  getSimilarMovies,
  getSimilarTv,
  getTvById,
  getTvCredits,
  getTvRecommendations,
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

function getImageColorsModule():
  | { getColors: (uri: string, options?: Record<string, unknown>) => Promise<any> }
  | null {
  try {
    const mod = require('react-native-image-colors');
    return mod?.default ?? mod;
  } catch {
    return null;
  }
}

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

function firstParamValue(value: unknown) {
  if (Array.isArray(value)) return String(value[0] ?? '').trim();
  return String(value ?? '').trim();
}

function parsePositiveParam(value: unknown) {
  const n = Number(firstParamValue(value));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function parseBooleanParam(value: unknown) {
  const raw = firstParamValue(value).toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export default function MovieDetailScreen() {
  const theme = useTheme();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams();
  const tmdbId = Number(firstParamValue(params.id) || 0);
  const mediaType = firstParamValue(params.type) === 'tv' ? 'tv' : 'movie';
  const openCommentsFromParams = useMemo(
    () => parseBooleanParam((params as Record<string, unknown>).openComments),
    [params]
  );
  const focusParentCommentId = useMemo(
    () => parsePositiveParam((params as Record<string, unknown>).focusParent),
    [params]
  );
  const focusReplyCommentId = useMemo(
    () => parsePositiveParam((params as Record<string, unknown>).focusReply),
    [params]
  );
  const activeUserId = Number((user as any)?.id ?? 0);
  const activeUserNicknameKey = String((user as any)?.nickname ?? '').trim().toLowerCase();

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
  const [trailerOpen, setTrailerOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const sheetY = useSharedValue(0);
  const sheetStart = useSharedValue(0);
  const promptDragging = useSharedValue(0);
  const promptArrowY = useSharedValue(0);
  const watchModalOpacity = useSharedValue(0);
  const watchModalScale = useSharedValue(0.92);
  const watchToastOpacity = useSharedValue(0);
  const watchToastTranslateY = useSharedValue(14);
  const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
  const heroHeight = Math.round(Math.min(screenHeight * 0.7, screenWidth * 1.5));

  const accent = useMemo(() => {
    if (!tmdbId) return '#3B82F6';
    const hue = (tmdbId * 47) % 360;
    return `hsl(${hue}, 70%, 55%)`;
  }, [tmdbId]);
  const [accentColor, setAccentColor] = useState(accent);
  const watchToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);
  const commentsScrollRef = useRef<ScrollView | null>(null);
  const nearBottomArmedRef = useRef(false);
  const commentLayoutYRef = useRef<Record<number, number>>({});
  const openedFromParamsRef = useRef(false);

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
    setTrailerOpen(false);
  }, [mediaType, tmdbId]);

  useEffect(() => {
    if (!movie) return;
    if (Platform.OS === 'web') return;
    const imageColors = getImageColorsModule();
    if (!imageColors?.getColors) return;
    const imageForColor =
      posterUrl(movie.poster_path, 'w185') ||
      backdropUrl(movie.backdrop_path, 'w780');
    if (!imageForColor) return;
    let canceled = false;
    (async () => {
      try {
        const result = await imageColors.getColors(imageForColor, {
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
        const [videosRes, recommendationRes, similarFallbackRes, creditsRes, providersRes] = await Promise.all([
          mediaType === 'tv' ? getTvVideos(tmdbId) : getMovieVideos(tmdbId),
          mediaType === 'tv' ? getTvRecommendations(tmdbId, 1) : getMovieRecommendations(tmdbId, 1),
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
        const recommendationItems = (recommendationRes.results ?? []).filter((item) => !!item.poster_path);
        const fallbackItems = (similarFallbackRes.results ?? []).filter((item) => !!item.poster_path);
        const similarItems = recommendationItems.length > 0 ? recommendationItems : fallbackItems;
        setSimilar(similarItems.slice(0, 10));
        setCast(
          (creditsRes.cast ?? [])
            .filter((person) => !!person.profile_path)
            .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
            .slice(0, 12)
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
    if (!commentsOpen) {
      sheetY.value = screenHeight;
    }
  }, [commentsOpen, screenHeight, sheetY]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (event) => {
      setKeyboardHeight(event.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ y: 0, animated: false });
      });
    }, [])
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
  const watchToastAnimatedStyle = useAnimatedStyle(() => ({
    opacity: watchToastOpacity.value,
    transform: [{ translateY: watchToastTranslateY.value }],
  }));
  const promptArrowStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: promptArrowY.value }],
  }));

  useEffect(() => {
    if (commentsOpen) {
      cancelAnimation(promptArrowY);
      promptArrowY.value = 0;
      return;
    }
    promptArrowY.value = withRepeat(
      withSequence(
        withTiming(-8, { duration: 520 }),
        withTiming(0, { duration: 520 })
      ),
      -1,
      false
    );
    return () => {
      cancelAnimation(promptArrowY);
      promptArrowY.value = 0;
    };
  }, [commentsOpen, promptArrowY]);

  const closeCommentsSheet = useCallback(() => {
    Keyboard.dismiss();
    nearBottomArmedRef.current = false;
    sheetY.value = withTiming(screenHeight, { duration: 220 }, (finished) => {
      if (finished) {
        runOnJS(setCommentsOpen)(false);
      }
    });
  }, [screenHeight, sheetY]);

  const dismissKeyboard = useCallback(() => {
    Keyboard.dismiss();
  }, []);

  const openCommentsSheet = useCallback(() => {
    if (commentsOpen) return;
    nearBottomArmedRef.current = false;
    setCommentsOpen(true);
    sheetY.value = screenHeight;
    requestAnimationFrame(() => {
      sheetY.value = withTiming(0, { duration: 230 });
    });
  }, [commentsOpen, screenHeight, sheetY]);

  useEffect(() => {
    commentLayoutYRef.current = {};
    openedFromParamsRef.current = false;
  }, [tmdbId, focusParentCommentId, focusReplyCommentId, openCommentsFromParams]);

  useEffect(() => {
    if (!openCommentsFromParams) return;
    if (commentsOpen) return;
    if (openedFromParamsRef.current) return;
    openedFromParamsRef.current = true;
    openCommentsSheet();
  }, [commentsOpen, openCommentsFromParams, openCommentsSheet]);

  const commentsPromptGesture = useMemo(
    () =>
      Gesture.Pan()
        .onStart(() => {
          sheetStart.value = screenHeight;
          promptDragging.value = 0;
        })
        .onUpdate((event) => {
          if (event.translationY > -2) return;
          if (!promptDragging.value) {
            promptDragging.value = 1;
            sheetY.value = screenHeight;
            runOnJS(setCommentsOpen)(true);
          }
          const next = Math.max(0, Math.min(screenHeight, sheetStart.value + event.translationY));
          sheetY.value = next;
        })
        .onEnd((event) => {
          if (!promptDragging.value) return;
          promptDragging.value = 0;
          const shouldOpen =
            sheetY.value < screenHeight * 0.78 ||
            event.translationY < -86 ||
            event.velocityY < -780;
          if (shouldOpen) {
            sheetY.value = withTiming(0, { duration: 220 });
            return;
          }
          sheetY.value = withTiming(screenHeight, { duration: 190 }, (finished) => {
            if (finished) {
              runOnJS(setCommentsOpen)(false);
            }
          });
        }),
    [promptDragging, screenHeight, sheetStart, sheetY]
  );

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
    setWatchToastVisible(true);
    if (watchToastTimerRef.current) clearTimeout(watchToastTimerRef.current);
    watchToastTimerRef.current = setTimeout(() => {
      setWatchToastVisible(false);
      watchToastTimerRef.current = null;
    }, 2100);
  }, []);

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

  const tryOpenCommentsFromBottom = useCallback(
    (event: {
      nativeEvent: {
        contentOffset: { y: number };
        layoutMeasurement: { height: number };
        contentSize: { height: number };
      };
    }) => {
      if (commentsOpen) return;
      const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
      const nearBottom = contentOffset.y + layoutMeasurement.height >= contentSize.height - 18;
      if (nearBottom) {
        if (nearBottomArmedRef.current) {
          openCommentsSheet();
          nearBottomArmedRef.current = false;
          return;
        }
        nearBottomArmedRef.current = true;
        return;
      }
      nearBottomArmedRef.current = false;
    },
    [commentsOpen, openCommentsSheet]
  );

  const isCommentOwnedByActiveUser = useCallback(
    (comment: MovieComment) => {
      const commentUserId = Number(comment.public_user_id ?? comment.user_id ?? 0);
      if (activeUserId > 0 && commentUserId === activeUserId) return true;
      const commentNicknameKey = String(comment.nickname ?? '').trim().toLowerCase();
      if (activeUserNicknameKey && commentNicknameKey && commentNicknameKey === activeUserNicknameKey) return true;
      return false;
    },
    [activeUserId, activeUserNicknameKey]
  );

  const rootComments = useMemo(() => {
    const sortedRoots = comments
      .filter((c) => !c.parent_id)
      .sort(
        (a, b) =>
          new Date(String(b.created_at ?? '')).getTime() -
          new Date(String(a.created_at ?? '')).getTime()
      );
    if (activeUserId <= 0 && !activeUserNicknameKey) return sortedRoots;
    const myComments = sortedRoots.filter((c) => isCommentOwnedByActiveUser(c));
    const otherComments = sortedRoots.filter((c) => !isCommentOwnedByActiveUser(c));
    return [...myComments, ...otherComments];
  }, [activeUserId, activeUserNicknameKey, comments, isCommentOwnedByActiveUser]);

  const scrollToFocusedComment = useCallback(
    (animated = true) => {
      const targetId = focusParentCommentId;
      if (!targetId) return false;
      const targetY = Number(commentLayoutYRef.current[targetId]);
      if (!Number.isFinite(targetY)) return false;
      commentsScrollRef.current?.scrollTo({
        y: Math.max(0, targetY - 10),
        animated,
      });
      return true;
    },
    [focusParentCommentId]
  );
  const repliesByParent = useMemo(
    () => {
      const grouped = comments.reduce<Record<number, MovieComment[]>>((acc, c) => {
        if (!c.parent_id) return acc;
        acc[c.parent_id] = acc[c.parent_id] ?? [];
        acc[c.parent_id].push(c);
        return acc;
      }, {});
      Object.values(grouped).forEach((list) => {
        list.sort(
          (a, b) =>
            new Date(String(b.created_at ?? '')).getTime() -
            new Date(String(a.created_at ?? '')).getTime()
        );
      });
      return grouped;
    },
    [comments]
  );

  useEffect(() => {
    if (!commentsOpen) return;
    if (!focusParentCommentId) return;
    const timer = setTimeout(() => {
      scrollToFocusedComment(true);
    }, 140);
    return () => clearTimeout(timer);
  }, [commentsOpen, focusParentCommentId, rootComments.length, scrollToFocusedComment]);

  if (loading || !movie) {
    return (
      <View style={[styles.loader, { backgroundColor: theme.background }]}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  const onSendComment = async () => {
    if (!user) return;
    const nextComment = commentText.trim();
    if (!nextComment) return;
    await addComment(
      user.id,
      tmdbId,
      nextComment,
      replyTo?.id ?? null,
      user.nickname,
      normalizeCommentAvatarUri((user as any)?.avatar_url ?? null)
    );
    setCommentText('');
    setReplyTo(null);
    refreshComments();
  };
  const trailerUrl = trailer?.key ? `https://www.youtube.com/watch?v=${trailer.key}` : null;

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
  const isWeb = Platform.OS === 'web';
  const activeActionColor = isWeb ? '#E5E7EB' : accentColor;
  const floatingBackTop = Math.max(insets.top + 8, 16);
  const commentsKeyboardOffset = Math.max(
    0,
    keyboardHeight - (Platform.OS === 'ios' ? insets.bottom : 0)
  );
  const commentsComposerBottom = Platform.OS === 'ios' ? Math.max(insets.bottom + 8, 12) : 8;

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <View style={styles.flex}>
        <Pressable onPress={handleBackPress} style={[styles.floatingBackBtn, { top: floatingBackTop }]}>
          <Ionicons name="chevron-back" size={20} color="#fff" />
        </Pressable>
        <ScrollView
          ref={scrollRef}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            styles.scroll,
            { paddingBottom: Math.max(insets.bottom + 4, 8) },
          ]}
          scrollEnabled={!commentsOpen}
          onScrollEndDrag={tryOpenCommentsFromBottom}
          onMomentumScrollEnd={tryOpenCommentsFromBottom}>
          {hasHeroImage ? (
            <View style={[styles.hero, { backgroundColor: theme.background, height: heroHeight }]}>
              <Image
                source={{ uri: heroImageUri }}
                style={styles.heroImage}
                contentFit="cover"
                contentPosition="top"
                transition={120}
                cachePolicy="memory-disk"
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
            <Pressable
              style={styles.watchBtn}
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
              <Ionicons name="play-circle-outline" size={20} color="#fff" />
              <Text style={styles.watchText}>Watch</Text>
            </Pressable>
            <View style={styles.quickActionsRow}>
              <Pressable
                style={[styles.quickActionBtn, state.inWatchlist && styles.quickActionBtnActive]}
                onPress={async () => {
                  if (!user) return;
                  await toggleWatchlist(user.id, tmdbId, mediaType);
                  refreshState();
                }}>
                <Ionicons
                  name={state.inWatchlist ? 'bookmark' : 'bookmark-outline'}
                  size={16}
                  color={state.inWatchlist ? activeActionColor : '#fff'}
                />
                <Text style={styles.quickActionText}>Watchlist</Text>
              </Pressable>
              <Pressable
                style={[styles.quickActionBtn, state.inFavorites && styles.quickActionBtnActive]}
                onPress={async () => {
                  if (!user) return;
                  await toggleFavorite(user.id, tmdbId, mediaType);
                  refreshState();
                }}>
                <Ionicons
                  name={state.inFavorites ? 'heart' : 'heart-outline'}
                  size={16}
                  color={state.inFavorites ? '#EF4444' : '#fff'}
                />
                <Text style={styles.quickActionText}>Favorite</Text>
              </Pressable>
              <Pressable
                style={[styles.quickActionBtn, state.watched && styles.quickActionBtnActive]}
                onPress={async () => {
                  if (!user) return;
                  await toggleWatched(user.id, tmdbId, mediaType);
                  refreshState();
                }}>
                <Ionicons
                  name={state.watched ? 'checkmark-circle' : 'checkmark-circle-outline'}
                  size={16}
                  color={state.watched ? '#22C55E' : '#fff'}
                />
                <Text style={styles.quickActionText}>Watched</Text>
              </Pressable>
            </View>
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
              trailerOpen ? (
                <View style={styles.trailerPlayerWrap}>
                  <YoutubePlayer
                    height={208}
                    play={false}
                    videoId={trailer.key}
                    initialPlayerParams={{ modestbranding: true }}
                  />
                </View>
              ) : (
                <Pressable style={styles.trailerBtn} onPress={() => setTrailerOpen(true)}>
                  <Ionicons name="play-circle" size={17} color="#fff" />
                  <Text style={styles.trailerText} numberOfLines={1}>
                    Play trailer
                  </Text>
                </Pressable>
              )
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
              <FlatList
                horizontal
                data={similar}
                keyExtractor={(item) => String(item.id)}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.similarRow}
                initialNumToRender={6}
                maxToRenderPerBatch={6}
                windowSize={4}
                removeClippedSubviews
                renderItem={({ item }) => (
                  <Pressable
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
                      transition={120}
                      cachePolicy="memory-disk"
                    />
                    <View style={styles.similarGlass}>
                      <Text style={styles.similarTitle} numberOfLines={1}>
                        {'title' in item ? item.title : item.name}
                      </Text>
                    </View>
                  </Pressable>
                )}
              />
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
                <Image
                  source={{ uri: posterUrl(director.profile_path, 'w342') ?? undefined }}
                  style={styles.castImage}
                  contentFit="cover"
                  transition={120}
                  cachePolicy="memory-disk"
                />
                <View style={styles.castGlass}>
                  <Text style={styles.castName} numberOfLines={1}>
                    {director.name}
                  </Text>
                  <Text style={styles.castRole} numberOfLines={1}>
                    Director
                  </Text>
                </View>
              </Pressable>
            ) : (
              <Text style={styles.emptyText}>Director unavailable.</Text>
            )}
          </View>

          <View style={styles.extraSection}>
            <Text style={styles.sectionLabel}>ACTORS</Text>
            {cast.length > 0 ? (
              <FlatList
                horizontal
                data={cast}
                keyExtractor={(person) => String(person.id)}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.castRow}
                initialNumToRender={6}
                maxToRenderPerBatch={6}
                windowSize={4}
                removeClippedSubviews
                renderItem={({ item: person }) => (
                  <Pressable
                    style={styles.castCard}
                    onPress={() =>
                      router.push({ pathname: '/person/[id]', params: { id: String(person.id), role: 'actor' } })
                    }>
                    <Image
                      source={{ uri: posterUrl(person.profile_path, 'w342') ?? undefined }}
                      style={styles.castImage}
                      contentFit="cover"
                      transition={120}
                      cachePolicy="memory-disk"
                    />
                    <View style={styles.castGlass}>
                      <Text style={styles.castName} numberOfLines={1}>
                        {person.name}
                      </Text>
                      {person.character ? (
                        <Text style={styles.castRole} numberOfLines={1}>
                          {person.character}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                )}
              />
            ) : (
              <Text style={styles.emptyText}>Cast unavailable.</Text>
            )}
          </View>

          <GestureDetector gesture={commentsPromptGesture}>
            <View style={styles.commentsPrompt}>
              <Animated.View style={promptArrowStyle}>
                <Ionicons name="chevron-up" size={24} color="#fff" />
              </Animated.View>
              <Text style={styles.commentsPromptText}>swipe up to open comments</Text>
            </View>
          </GestureDetector>

        </ScrollView>

        {commentsOpen ? (
          <GestureDetector
            gesture={Gesture.Pan()
              .onStart(() => {
                sheetStart.value = sheetY.value;
              })
              .onUpdate((event) => {
                const next = Math.max(0, Math.min(screenHeight, sheetStart.value + event.translationY));
                sheetY.value = next;
              })
              .onEnd((event) => {
                const shouldClose = sheetY.value > screenHeight * 0.22 || event.velocityY > 650;
                if (shouldClose) {
                  runOnJS(dismissKeyboard)();
                  sheetY.value = withTiming(screenHeight, { duration: 220 }, (finished) => {
                    if (finished) {
                      runOnJS(setCommentsOpen)(false);
                    }
                  });
                } else {
                  sheetY.value = withTiming(0, { duration: 180 });
                }
              })}>
            <Animated.View
              pointerEvents="auto"
              style={[
                styles.commentsSheet,
                { top: Math.max(insets.top + 8, 12) },
                sheetStyle,
              ]}>
              <View style={styles.sheetHandle}>
                <Text style={styles.commentsTitle}>COMMENTS</Text>
                <Pressable onPress={closeCommentsSheet} style={styles.sheetCloseBtn}>
                  <Ionicons name="chevron-down" size={22} color="#fff" />
                </Pressable>
              </View>
              <ScrollView
                ref={commentsScrollRef}
                style={styles.commentsScroll}
                showsVerticalScrollIndicator={false}
                keyboardDismissMode="interactive"
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.commentsWrap}>
                {rootComments.map((comment) => {
                  const avatarUri = normalizeCommentAvatarUri(comment.avatar_url ?? null);
                  const isFocusedComment =
                    !!focusParentCommentId && Number(comment.id) === Number(focusParentCommentId);
                  return (
                    <View
                      key={comment.id}
                      onLayout={(event) => {
                        commentLayoutYRef.current[Number(comment.id)] = event.nativeEvent.layout.y;
                        if (isFocusedComment && commentsOpen) {
                          requestAnimationFrame(() => {
                            scrollToFocusedComment(false);
                          });
                        }
                      }}
                      style={[
                        styles.commentCard,
                        isFocusedComment ? styles.commentCardFocused : null,
                      ]}>
                      <Pressable
                        style={styles.avatarCircle}
                        onPress={() => router.push(`/user/${comment.public_user_id ?? comment.user_id}` as any)}>
                        {avatarUri ? (
                          <Image source={{ uri: avatarUri }} style={styles.avatarCircleImage} contentFit="cover" />
                        ) : (
                          <Text style={styles.avatarFallbackText}>?</Text>
                        )}
                      </Pressable>
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
                        {(repliesByParent[comment.id] ?? []).map((reply) => {
                          const replyAvatarUri = normalizeCommentAvatarUri(reply.avatar_url ?? null);
                          return (
                            <View key={reply.id} style={styles.replyCard}>
                              <Pressable
                                style={styles.avatarMini}
                                onPress={() => router.push(`/user/${reply.public_user_id ?? reply.user_id}` as any)}>
                                {replyAvatarUri ? (
                                  <Image source={{ uri: replyAvatarUri }} style={styles.avatarMiniImage} contentFit="cover" />
                                ) : (
                                  <Text style={styles.avatarMiniFallbackText}>?</Text>
                                )}
                              </Pressable>
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
                          );
                        })}
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
              <View
                style={[
                  styles.commentsComposer,
                  {
                    paddingBottom: commentsComposerBottom,
                    transform: [{ translateY: -commentsKeyboardOffset }],
                  },
                ]}>
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
                    returnKeyType="send"
                    onSubmitEditing={onSendComment}
                    blurOnSubmit={false}
                    style={styles.commentInput}
                  />
                  <Pressable onPress={onSendComment} style={styles.sendBtn}>
                    <Ionicons name="send" size={18} color="#000" />
                  </Pressable>
                </View>
              </View>
            </Animated.View>
          </GestureDetector>
        ) : null}

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
      </View>
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
    paddingBottom: 0,
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
  },
  quickActionsRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  quickActionBtn: {
    flex: 1,
    height: 42,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  quickActionBtnActive: {
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderColor: 'rgba(255,255,255,0.24)',
  },
  quickActionText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 11,
    letterSpacing: 0.2,
  },
  watchBtn: {
    width: '100%',
    height: 54,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(14,18,24,0.92)',
  },
  watchText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 14,
    letterSpacing: 0.2,
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
    fontSize: 20,
    letterSpacing: 1.2,
  },
  commentsScroll: {
    flex: 1,
  },
  commentsWrap: {
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    gap: Spacing.two,
    paddingBottom: 170,
  },
  commentsSheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    top: 20,
    backgroundColor: '#000',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    borderColor: '#161616',
    paddingTop: Spacing.two,
    overflow: 'hidden',
  },
  sheetHandle: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.two,
    paddingTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#111',
  },
  sheetCloseBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0E0E10',
    borderWidth: 1,
    borderColor: '#232328',
  },
  commentsPrompt: {
    marginTop: 22,
    marginBottom: 0,
    minHeight: 58,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 0,
  },
  commentsPromptText: {
    marginTop: 0,
    color: 'rgba(255,255,255,0.84)',
    fontFamily: Fonts.mono,
    fontSize: 11,
    letterSpacing: 0.5,
  },
  commentCard: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.two,
    borderRadius: 14,
    backgroundColor: '#08090B',
    borderWidth: 1,
    borderColor: '#1A1A1F',
  },
  commentCardFocused: {
    borderColor: 'rgba(96,165,250,0.78)',
    backgroundColor: 'rgba(8,14,24,0.96)',
  },
  avatarCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#1F2937',
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
    color: 'rgba(255,255,255,0.92)',
    fontFamily: Fonts.serif,
    fontSize: 12,
    lineHeight: 18,
  },
  replyText: {
    color: '#93C5FD',
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
    borderTopColor: '#1A1A1F',
  },
  avatarMini: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#1F2937',
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
    color: 'rgba(255,255,255,0.82)',
    fontFamily: Fonts.mono,
    fontSize: 12,
    letterSpacing: 0.4,
  },
  replyingTo: {
    color: 'rgba(255,255,255,0.56)',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  commentsComposer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.two,
    borderTopWidth: 1,
    borderTopColor: '#121212',
    backgroundColor: '#000',
    gap: 6,
  },
  commentInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: Spacing.one,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#2A2A30',
    backgroundColor: '#0E0E11',
  },
  commentInput: {
    flex: 1,
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 14,
    paddingVertical: 8,
  },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F4F4F5',
  },
});
