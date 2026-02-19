import Constants from 'expo-constants';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';

import { Fonts, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import { getCinemaEventByStatusNow, type CinemaEvent } from '@/db/cinema';
import { useTheme } from '@/hooks/use-theme';
import { getMovieCredits, posterUrl, type TmdbCast, type TmdbCrew } from '@/lib/tmdb';

type ChatMessage = {
  id: string;
  eventId: number;
  userId: number | null;
  nickname: string;
  avatarUrl?: string | null;
  text: string;
  createdAt: string;
};

type WsIncoming =
  | { type: 'history'; room: string; messages: ChatMessage[] }
  | { type: 'message'; room: string; message: ChatMessage }
  | { type: 'stats'; room: string; viewers: number; likes: number }
  | { type: 'liked'; room: string; liked: boolean };

const extra = (Constants.expoConfig?.extra ?? {}) as {
  EXPO_PUBLIC_CINEMA_WS_URL?: string;
  EXPO_PUBLIC_BACKEND_URL?: string;
};
const WS_URL =
  extra.EXPO_PUBLIC_CINEMA_WS_URL?.trim() ||
  (extra.EXPO_PUBLIC_BACKEND_URL?.trim()
    ? extra.EXPO_PUBLIC_BACKEND_URL.trim().replace(/^http/i, 'ws').replace(/\/+$/, '') + '/ws'
    : '');

function formatCountdown(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${d}d:${h}h:${m}m:${s}s`;
}

export default function CinemaScreen() {
  const theme = useTheme();
  const { user } = useAuth();
  const wsRef = useRef<WebSocket | null>(null);
  const videoRef = useRef<Video | null>(null);

  const [loading, setLoading] = useState(true);
  const [event, setEvent] = useState<CinemaEvent | null>(null);
  const [nowIso, setNowIso] = useState(new Date().toISOString());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatText, setChatText] = useState('');
  const [chatStatus, setChatStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [viewers, setViewers] = useState(0);
  const [likes, setLikes] = useState(0);
  const [likedByMe, setLikedByMe] = useState(false);
  const [subtitleLang, setSubtitleLang] = useState<'off' | 'en' | 'ro' | 'ru'>('off');
  const [cast, setCast] = useState<TmdbCast[]>([]);
  const [director, setDirector] = useState<TmdbCrew | null>(null);

  useEffect(() => {
    let mounted = true;
    const loadEvent = async () => {
      const next = await getCinemaEventByStatusNow();
      if (!mounted) return;
      setEvent(next);
    };

    (async () => {
      try {
        setLoading(true);
        await loadEvent();
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    const poll = setInterval(() => {
      loadEvent();
    }, 5000);

    return () => {
      mounted = false;
      clearInterval(poll);
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNowIso(new Date().toISOString()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const tmdbId = Number(event?.tmdb_id ?? 0);
      if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
        if (mounted) {
          setCast([]);
          setDirector(null);
        }
        return;
      }
      try {
        const credits = await getMovieCredits(tmdbId);
        if (!mounted) return;
        const castList = (credits.cast ?? [])
          .filter((person) => !!person.profile_path)
          .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
          .slice(0, 8);
        const directorPerson =
          (credits.crew ?? []).find((person) => person.job === 'Director' && !!person.profile_path) ??
          (credits.crew ?? []).find((person) => person.job === 'Director') ??
          null;
        setCast(castList);
        setDirector(directorPerson);
      } catch {
        if (!mounted) return;
        setCast([]);
        setDirector(null);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [event?.tmdb_id]);

  const phase = useMemo<'upcoming' | 'live' | 'ended' | 'none'>(() => {
    if (!event) return 'none';
    const now = Date.parse(nowIso);
    const start = Date.parse(event.start_at);
    const end = Date.parse(event.end_at);
    if (now < start) return 'upcoming';
    if (now <= end) return 'live';
    return 'ended';
  }, [event, nowIso]);

  const countdownText = useMemo(() => {
    if (!event || phase !== 'upcoming') return null;
    const diff = Date.parse(event.start_at) - Date.parse(nowIso);
    return formatCountdown(diff);
  }, [event, nowIso, phase]);

  useEffect(() => {
    if (!event || phase !== 'live' || !WS_URL) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (!WS_URL) setChatStatus('error');
      setViewers(0);
      setLikes(0);
      setLikedByMe(false);
      return;
    }

    const room = `cinema:${event.id}`;
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    setChatStatus('connecting');

    ws.onopen = () => {
      setChatStatus('connected');
      ws.send(
        JSON.stringify({
          type: 'join',
          room,
          userId: user?.id ?? null,
          nickname: user?.nickname ?? 'guest',
          avatarUrl: (user as any)?.avatar_url ?? null,
        })
      );
    };

    ws.onmessage = (ev) => {
      try {
        const payload = JSON.parse(String(ev.data)) as WsIncoming;
        if (payload.type === 'history') {
          setMessages(payload.messages);
          return;
        }
        if (payload.type === 'message') {
          setMessages((prev) => [...prev, payload.message].slice(-120));
          return;
        }
        if (payload.type === 'stats') {
          setViewers(payload.viewers || 0);
          setLikes(payload.likes || 0);
          return;
        }
        if (payload.type === 'liked') {
          setLikedByMe(!!payload.liked);
        }
      } catch {
      }
    };
    ws.onerror = () => {
      setChatStatus('error');
    };
    ws.onclose = () => {
      setChatStatus('idle');
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [event, phase, user]);

  const sendMessage = () => {
    const text = chatText.trim();
    if (!text || !event || !wsRef.current || chatStatus !== 'connected') return;
    wsRef.current.send(
      JSON.stringify({
        type: 'message',
        room: `cinema:${event.id}`,
        eventId: event.id,
        userId: user?.id ?? null,
        nickname: user?.nickname ?? 'guest',
        text,
      })
    );
    setChatText('');
  };

  const toggleLike = () => {
    if (!event || !wsRef.current || chatStatus !== 'connected') return;
    const next = !likedByMe;
    wsRef.current.send(
      JSON.stringify({
        type: 'like',
        room: `cinema:${event.id}`,
        liked: next,
      })
    );
  };

  const openFullscreen = async () => {
    try {
      await videoRef.current?.presentFullscreenPlayer();
    } catch {
    }
  };

  if (loading) {
    return (
      <View style={[styles.loader, { backgroundColor: theme.background }]}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  if (!event) {
    return (
      <View style={[styles.loader, { backgroundColor: theme.background }]}>
        <Text style={styles.emptyText}>No cinema session scheduled yet.</Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      {phase === 'upcoming' ? (
        <View style={styles.phaseShell}>
          <View style={styles.phasePosterWrap}>
            {event.poster_url ? (
              <Image source={{ uri: event.poster_url }} style={styles.phasePoster} resizeMode="cover" />
            ) : (
              <View style={styles.upcomingPosterFallback} />
            )}
            <View style={styles.upcomingShade} />
          </View>
          <View style={styles.phaseInfoCard}>
            <Text style={styles.phaseTitle}>{event.title}</Text>
            <Text style={styles.phaseCountdown}>{countdownText ?? '0d:0h:0m:0s'}</Text>
            <Text style={styles.phaseHint} numberOfLines={3}>
              {event.description?.trim() || 'Live stream will begin soon.'}
            </Text>
          </View>
        </View>
      ) : null}

      {phase === 'ended' ? (
        <View style={styles.phaseShell}>
          <View style={styles.phasePosterWrap}>
            {event.poster_url ? <Image source={{ uri: event.poster_url }} style={styles.phasePoster} resizeMode="cover" /> : null}
            <View style={styles.upcomingShade} />
          </View>
          <View style={styles.phaseInfoCard}>
            <Text style={styles.phaseTitle}>{event.title}</Text>
            <Text style={styles.phaseEnded}>Ended</Text>
            <Text style={styles.phaseHint} numberOfLines={3}>
              Thanks for watching. Next cinema event will appear automatically.
            </Text>
          </View>
        </View>
      ) : null}

      {phase === 'live' ? (
        <View style={styles.liveShellModern}>
          <View style={styles.playerHero}>
            <Video
              ref={videoRef}
              source={{ uri: event.video_url }}
              style={styles.video}
              useNativeControls
              resizeMode={ResizeMode.CONTAIN}
              shouldPlay
            />
            <Pressable style={styles.expandBtnModern} onPress={openFullscreen}>
              <Ionicons name="expand-outline" size={18} color="#fff" />
            </Pressable>
          </View>

          <View style={styles.liveControlsRow}>
            <View style={styles.liveStats}>
              <Ionicons name="eye-outline" size={26} color="#fff" />
              <Text style={styles.liveStatsText}>{viewers}</Text>
            </View>
            <Pressable style={styles.liveStats} onPress={toggleLike}>
              <Ionicons name={likedByMe ? 'heart' : 'heart-outline'} size={26} color="#fff" />
              <Text style={styles.liveStatsText}>{likes}</Text>
            </Pressable>
            <View style={styles.subRowModern}>
              {(['off', 'en', 'ro', 'ru'] as const).map((lang) => (
                <Pressable
                  key={lang}
                  onPress={() => setSubtitleLang(lang)}
                  style={[styles.subChipModern, subtitleLang === lang && styles.subChipModernActive]}>
                  <Text style={styles.subChipModernText}>{lang.toUpperCase()}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={styles.chatCardModern}>
            <View style={styles.chatHeadModern}>
              <Text style={styles.chatTitleModern}>LIVE CHAT</Text>
              <View style={styles.liveDot} />
              <Text style={styles.chatStateModern}>
                {chatStatus === 'connected'
                  ? 'ONLINE'
                  : chatStatus === 'connecting'
                    ? 'CONNECTING'
                    : chatStatus === 'error'
                      ? 'OFFLINE'
                      : 'OFFLINE'}
              </Text>
            </View>
            <View style={styles.messagesWrapModern}>
              {messages.length === 0 ? (
                <Text style={styles.emptyText}>No messages yet.</Text>
              ) : (
                messages.slice(-25).map((msg) => (
                  <View key={msg.id} style={styles.msgRow}>
                    <View style={styles.msgHeader}>
                      <Pressable
                        style={styles.msgAvatar}
                        onPress={() => {
                          if (!msg.userId) return;
                          router.push(`/user/${msg.userId}` as any);
                        }}>
                        {msg.avatarUrl ? <Image source={{ uri: msg.avatarUrl }} style={styles.msgAvatarImage} /> : null}
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          if (!msg.userId) return;
                          router.push(`/user/${msg.userId}` as any);
                        }}>
                        <Text style={styles.msgUser}>{msg.nickname}</Text>
                      </Pressable>
                    </View>
                    <Text style={styles.msgText}>{msg.text}</Text>
                  </View>
                ))
              )}
            </View>
            <View style={styles.inputRowModern}>
              <TextInput
                value={chatText}
                onChangeText={setChatText}
                placeholder="Write message..."
                placeholderTextColor="rgba(255,255,255,0.5)"
                style={styles.inputModern}
                editable={chatStatus === 'connected'}
              />
              <Pressable onPress={sendMessage} style={[styles.sendBtnModern, chatStatus !== 'connected' && styles.sendBtnDisabled]}>
                <Ionicons name="send" size={20} color="#fff" />
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    padding: Spacing.four,
    paddingBottom: 10,
    gap: 10,
  },
  loader: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  phaseShell: {
    flex: 1,
    gap: 12,
  },
  phasePosterWrap: {
    flex: 1,
    borderRadius: 26,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: '#0b0b0b',
  },
  phasePoster: {
    width: '100%',
    height: '100%',
  },
  phaseInfoCard: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    padding: 14,
    gap: 6,
  },
  phaseTitle: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 20,
  },
  phaseCountdown: {
    color: '#E10613',
    fontFamily: Fonts.mono,
    fontSize: 24,
    letterSpacing: 0.5,
    fontWeight: '700',
  },
  phaseEnded: {
    color: 'rgba(255,255,255,0.92)',
    fontFamily: Fonts.mono,
    fontSize: 16,
  },
  phaseHint: {
    color: 'rgba(255,255,255,0.78)',
    fontFamily: Fonts.serif,
    fontSize: 13,
    lineHeight: 18,
  },
  upcomingShell: {
    gap: 18,
  },
  upcomingPosterWrap: {
    height: 490,
    borderRadius: 30,
    overflow: 'hidden',
    backgroundColor: '#0b0b0b',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  upcomingPoster: {
    width: '100%',
    height: '100%',
  },
  upcomingPosterFallback: {
    width: '100%',
    height: '100%',
    backgroundColor: '#111',
  },
  upcomingShade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 260,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  countdownCard: {
    position: 'absolute',
    left: 18,
    right: 18,
    bottom: 18,
    borderRadius: 28,
    paddingHorizontal: 22,
    paddingVertical: 18,
    backgroundColor: '#E10613',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.16)',
  },
  countdownTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  countdownTopText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 18,
    letterSpacing: 1.2,
  },
  countdownDot: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.96)',
  },
  countdownBig: {
    marginTop: 8,
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 44,
    lineHeight: 48,
    fontWeight: '700',
  },
  infoSection: {
    gap: 12,
  },
  aboutHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  aboutTitle: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 56 / 2,
    letterSpacing: 1.5,
    fontWeight: '700',
  },
  aboutText: {
    color: 'rgba(255,255,255,0.82)',
    fontFamily: Fonts.serif,
    fontSize: 14,
    lineHeight: 20,
  },
  actorRow: {
    flexDirection: 'row',
    gap: 10,
  },
  personCard: {
    width: 86,
    gap: 6,
  },
  personCardImage: {
    width: 86,
    height: 150,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    borderRadius: 6,
    backgroundColor: '#151515',
  },
  personCardFallback: {
    width: 86,
    height: 150,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    borderRadius: 6,
    backgroundColor: '#151515',
  },
  personCardName: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 12,
  },
  personCardRole: {
    color: 'rgba(255,255,255,0.72)',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  endedCard: {
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: '#0b0b0b',
    position: 'relative',
  },
  endedOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: Spacing.three,
    backgroundColor: 'rgba(0,0,0,0.62)',
    gap: 6,
  },
  endedChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.14)',
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  endedChipText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  endedTitle: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 19,
  },
  endedHint: {
    color: 'rgba(255,255,255,0.82)',
    fontFamily: Fonts.serif,
    fontSize: 12,
  },
  poster: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 12,
    backgroundColor: '#0b0b0b',
  },
  liveShellModern: {
    flex: 1,
    gap: 0,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(255,255,255,0.04)',
    overflow: 'hidden',
  },
  playerHero: {
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    overflow: 'hidden',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.12)',
    backgroundColor: '#000',
    position: 'relative',
  },
  expandBtnModern: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    backgroundColor: 'rgba(8,8,8,0.78)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  liveControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  liveStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  liveStatsText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 13,
  },
  subRowModern: {
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  subChipModern: {
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  subChipModernActive: {
    borderColor: '#E10613',
    backgroundColor: 'rgba(225,6,19,0.35)',
  },
  subChipModernText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  chatCardModern: {
    flex: 1,
    borderRadius: 0,
    borderWidth: 0,
    backgroundColor: '#34363d',
    padding: 10,
    minHeight: 0,
  },
  chatHeadModern: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 10,
  },
  chatTitleModern: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 42 / 2,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  liveDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#E10613',
  },
  chatStateModern: {
    marginLeft: 'auto',
    color: 'rgba(255,255,255,0.72)',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  messagesWrapModern: {
    flex: 1,
    minHeight: 0,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.13)',
    backgroundColor: 'rgba(0,0,0,0.18)',
    padding: 8,
    gap: 8,
  },
  video: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#000',
  },
  playerPlaceholder: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    padding: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 120,
  },
  chatCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    padding: Spacing.three,
  },
  chatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  chatTitle: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 17,
  },
  chatState: {
    color: 'rgba(255,255,255,0.68)',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  messagesWrap: {
    maxHeight: 220,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(0,0,0,0.25)',
    padding: 8,
    gap: 8,
  },
  msgRow: {
    gap: 2,
  },
  msgHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  msgAvatar: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.14)',
    overflow: 'hidden',
  },
  msgAvatarImage: {
    width: '100%',
    height: '100%',
  },
  msgUser: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  msgText: {
    color: 'rgba(255,255,255,0.84)',
    fontFamily: Fonts.serif,
    fontSize: 12,
  },
  inputRowModern: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  inputModern: {
    flex: 1,
    height: 46,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(0,0,0,0.52)',
    paddingHorizontal: 12,
    color: '#fff',
    fontFamily: Fonts.serif,
  },
  sendBtnModern: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)',
    backgroundColor: '#090909',
  },
  sendBtnDisabled: {
    opacity: 0.5,
  },
  emptyText: {
    color: 'rgba(255,255,255,0.66)',
    fontFamily: Fonts.serif,
    fontSize: 12,
  },
});
