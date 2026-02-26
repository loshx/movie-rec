import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { VideoView, useVideoPlayer } from 'expo-video';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Fonts, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import {
  getCinemaEventByStatusNow,
  getCurrentCinemaPoll,
  voteCinemaPoll,
  type CinemaEvent,
  type CinemaPoll,
} from '@/db/cinema';
import { useTheme } from '@/hooks/use-theme';

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

const APP_CINEMA_CLIENT_ID = `cinema-client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const MAX_CHAT_MESSAGES = 160;

const extra = (Constants.expoConfig?.extra ?? {}) as {
  EXPO_PUBLIC_CINEMA_WS_URL?: string;
  EXPO_PUBLIC_BACKEND_URL?: string;
  EXPO_PUBLIC_CINEMA_EMPTY_IMAGE_URL?: string;
};

const BACKEND_URL = (process.env.EXPO_PUBLIC_BACKEND_URL ?? extra.EXPO_PUBLIC_BACKEND_URL ?? '').trim();
const EXPLICIT_WS_URL = (process.env.EXPO_PUBLIC_CINEMA_WS_URL ?? extra.EXPO_PUBLIC_CINEMA_WS_URL ?? '').trim();

const WS_URL =
  EXPLICIT_WS_URL ||
  (BACKEND_URL
    ? BACKEND_URL.replace(/^http/i, 'ws').replace(/\/+$/, '') + '/ws'
    : '');
const LOCAL_EMPTY_CINEMA_IMAGE = require('../../../assets/images/no-cinema.png');

function normalizeCinemaEmptyImageUrl(input: unknown): string | null {
  const value = String(input ?? '').trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return null;
}

const EMPTY_CINEMA_IMAGE_URL = normalizeCinemaEmptyImageUrl(
  process.env.EXPO_PUBLIC_CINEMA_EMPTY_IMAGE_URL ?? extra.EXPO_PUBLIC_CINEMA_EMPTY_IMAGE_URL
);

function formatCountdown(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${d}d:${h}h:${m}m:${s}s`;
}

function isSameCinemaEvent(a: CinemaEvent | null, b: CinemaEvent | null) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    Number(a.id) === Number(b.id) &&
    String(a.updated_at || '') === String(b.updated_at || '') &&
    String(a.start_at || '') === String(b.start_at || '') &&
    String(a.end_at || '') === String(b.end_at || '') &&
    String(a.video_url || '') === String(b.video_url || '')
  );
}

function sanitizeAvatarUri(input: unknown): string | null {
  const value = String(input ?? '').trim();
  if (!value) return null;
  if (/^(https?:\/\/|blob:|file:\/\/|content:\/\/|ph:\/\/)/i.test(value)) {
    return value.slice(0, 2000);
  }
  if (/^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(value)) {
    const compact = value.replace(/\s+/g, '');
    if (compact.length < 80 || compact.length > 2_000_000) return null;
    return compact;
  }
  return null;
}

function normalizeIncomingMessage(input: Partial<ChatMessage> & Record<string, unknown>): ChatMessage {
  const id = String(input.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  return {
    id,
    eventId: Number.isFinite(Number(input.eventId)) ? Number(input.eventId) : 0,
    userId: Number.isFinite(Number(input.userId)) ? Number(input.userId) : null,
    nickname: String(input.nickname || 'guest').slice(0, 40),
    avatarUrl: sanitizeAvatarUri(input.avatarUrl ?? input.avatar_url ?? null),
    text: String(input.text || '').slice(0, 500),
    createdAt: String(input.createdAt || input.created_at || new Date().toISOString()),
  };
}

function messageFingerprint(message: ChatMessage) {
  const ts = Date.parse(String(message?.createdAt || ''));
  const bucketSec = Number.isFinite(ts) ? Math.floor(ts / 1000) : String(message?.createdAt || '');
  return `${Number(message?.userId ?? 0)}|${String(message?.nickname || '').trim()}|${String(message?.text || '').trim()}|${bucketSec}`;
}

function dedupeMessages(messages: ChatMessage[]) {
  const seenIds = new Set<string>();
  const seenFingerprints = new Set<string>();
  const output: ChatMessage[] = [];
  for (const message of messages) {
    if (!message?.id) continue;
    if (seenIds.has(message.id)) continue;
    const fp = messageFingerprint(message);
    if (seenFingerprints.has(fp)) continue;
    seenIds.add(message.id);
    seenFingerprints.add(fp);
    output.push(message);
  }
  return output;
}

function formatChatTime(iso: string) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function CinemaScreen() {
  const theme = useTheme();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();

  const wsRef = useRef<WebSocket | null>(null);
  const videoViewRef = useRef<VideoView | null>(null);
  const chatListRef = useRef<FlatList<ChatMessage> | null>(null);
  const shouldAutoscrollRef = useRef(true);
  const lastLiveSyncMsRef = useRef(0);
  const lastSentRef = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const phaseGuardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsConnectMetaRef = useRef<{ key: string; at: number }>({ key: '', at: 0 });
  const userSnapshotRef = useRef<{ userId: number | null; nickname: string; avatarUrl: string | null }>({
    userId: null,
    nickname: 'guest',
    avatarUrl: null,
  });

  const [loading, setLoading] = useState(true);
  const [event, setEvent] = useState<CinemaEvent | null>(null);
  const [nowIso, setNowIso] = useState(new Date().toISOString());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatText, setChatText] = useState('');
  const [chatStatus, setChatStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [viewers, setViewers] = useState(0);
  const [likes, setLikes] = useState(0);
  const [likedByMe, setLikedByMe] = useState(false);
  const [failedAvatarUris, setFailedAvatarUris] = useState<Record<string, true>>({});
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [poll, setPoll] = useState<CinemaPoll | null>(null);
  const [pollLoading, setPollLoading] = useState(false);
  const [pollSubmittingId, setPollSubmittingId] = useState<string | null>(null);
  const [pollMessage, setPollMessage] = useState<string | null>(null);

  const eventId = Number(event?.id ?? 0);
  const eventStartAt = String(event?.start_at ?? '');
  const eventEndAt = String(event?.end_at ?? '');
  const currentUserId = Number(user?.id ?? 0);
  const currentUserNickname = String(user?.nickname ?? 'guest').trim() || 'guest';
  const currentUserAvatar = useMemo(() => sanitizeAvatarUri((user as any)?.avatar_url), [user]);

  const videoSource = useMemo(() => {
    const uri = String(event?.video_url ?? '').trim();
    return uri ? { uri } : null;
  }, [event?.video_url]);

  const videoPlayer = useVideoPlayer(videoSource, (player) => {
    player.loop = false;
    player.timeUpdateEventInterval = 1;
  });

  useEffect(() => {
    userSnapshotRef.current = {
      userId: currentUserId > 0 ? currentUserId : null,
      nickname: currentUserNickname,
      avatarUrl: currentUserAvatar,
    };
  }, [currentUserId, currentUserNickname, currentUserAvatar]);

  useEffect(() => {
    let mounted = true;
    const loadEvent = async () => {
      const next = await getCinemaEventByStatusNow();
      if (!mounted) return;
      setEvent((prev) => (isSameCinemaEvent(prev, next) ? prev : next));
    };

    (async () => {
      try {
        setLoading(true);
        await loadEvent();
      } finally {
        if (mounted) setLoading(false);
      }
    })();

    const refreshTimer = setInterval(() => {
      void loadEvent();
    }, 15000);

    return () => {
      mounted = false;
      clearInterval(refreshTimer);
    };
  }, []);

  const refreshPoll = useCallback(async () => {
    try {
      setPollLoading(true);
      const next = await getCurrentCinemaPoll(currentUserId > 0 ? currentUserId : null);
      const visiblePoll = next && next.status === 'open' ? next : null;
      setPoll(visiblePoll);
      if (visiblePoll || next) setPollMessage(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not load poll.';
      if (/endpoint is missing on backend/i.test(message)) {
        setPoll(null);
        return;
      }
      setPollMessage(message);
    } finally {
      setPollLoading(false);
    }
  }, [currentUserId]);

  useEffect(() => {
    let mounted = true;
    const run = async () => {
      await refreshPoll();
      if (!mounted) return;
    };
    void run();
    const timer = setInterval(() => {
      void refreshPoll();
    }, 12000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [refreshPoll]);

  useEffect(() => {
    if (!eventId) return;
    const timer = setInterval(() => setNowIso(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, [eventId]);

  const rawPhase = useMemo<'upcoming' | 'live' | 'ended' | 'none'>(() => {
    if (!event) return 'none';
    const now = Date.parse(nowIso);
    const start = Date.parse(event.start_at);
    const end = Date.parse(event.end_at);
    if (now < start) return 'upcoming';
    if (now <= end) return 'live';
    return 'ended';
  }, [event, nowIso]);

  const [phase, setPhase] = useState<'upcoming' | 'live' | 'ended' | 'none'>(rawPhase);

  useEffect(() => {
    if (phaseGuardTimerRef.current) {
      clearTimeout(phaseGuardTimerRef.current);
      phaseGuardTimerRef.current = null;
    }
    if (phase === rawPhase) return;

    const liveBoundaryFlip =
      (phase === 'upcoming' && rawPhase === 'live') || (phase === 'live' && rawPhase === 'upcoming');
    const delayMs = liveBoundaryFlip ? 1400 : 0;
    if (delayMs <= 0) {
      setPhase(rawPhase);
      return;
    }
    phaseGuardTimerRef.current = setTimeout(() => {
      setPhase(rawPhase);
      phaseGuardTimerRef.current = null;
    }, delayMs);
    return () => {
      if (phaseGuardTimerRef.current) {
        clearTimeout(phaseGuardTimerRef.current);
        phaseGuardTimerRef.current = null;
      }
    };
  }, [phase, rawPhase]);

  const countdownText = useMemo(() => {
    if (!event || phase !== 'upcoming') return null;
    return formatCountdown(Date.parse(event.start_at) - Date.parse(nowIso));
  }, [event, nowIso, phase]);

  const getLiveTargetPositionMs = useCallback(() => {
    if (!eventId) return 0;
    const start = Date.parse(eventStartAt);
    const end = Date.parse(eventEndAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
    const maxPosition = Math.max(0, end - start - 1200);
    const elapsed = Date.now() - start;
    if (!Number.isFinite(elapsed)) return 0;
    return Math.max(0, Math.min(elapsed, maxPosition));
  }, [eventId, eventStartAt, eventEndAt]);

  const syncVideoToLive = useCallback(
    (force = false) => {
      if (phase !== 'live' || !eventId) return;
      const targetMs = getLiveTargetPositionMs();
      const currentMs = Math.round((Number(videoPlayer.currentTime) || 0) * 1000);
      const drift = Math.abs(currentMs - targetMs);
      if (force || drift > 3000 || !videoPlayer.playing) {
        videoPlayer.currentTime = targetMs / 1000;
        if (!videoPlayer.playing) {
          videoPlayer.play();
        }
      }
    },
    [eventId, phase, getLiveTargetPositionMs, videoPlayer]
  );

  useEffect(() => {
    if (phase !== 'live' || !eventId) return;
    const sub = videoPlayer.addListener('timeUpdate', (payload) => {
      const now = Date.now();
      if (now - lastLiveSyncMsRef.current < 2200) return;
      const targetMs = getLiveTargetPositionMs();
      const currentMs = Math.round((Number(payload.currentTime) || 0) * 1000);
      const drift = Math.abs(currentMs - targetMs);
      if (!videoPlayer.playing || drift > 5000) {
        lastLiveSyncMsRef.current = now;
        syncVideoToLive(true);
      }
    });
    return () => {
      sub.remove();
    };
  }, [eventId, phase, getLiveTargetPositionMs, syncVideoToLive, videoPlayer]);

  useEffect(() => {
    if (phase !== 'live' || !eventId) {
      lastLiveSyncMsRef.current = 0;
      try {
        videoPlayer.pause();
      } catch {
      }
      return;
    }
    const timer = setTimeout(() => syncVideoToLive(true), 260);
    const interval = setInterval(() => syncVideoToLive(false), 12000);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [eventId, phase, syncVideoToLive, videoPlayer]);

  useEffect(() => {
    if (!eventId || phase !== 'live' || !WS_URL) {
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
        }
        wsRef.current = null;
      }
      wsConnectMetaRef.current = { key: '', at: 0 };
      setChatStatus(WS_URL ? 'idle' : 'error');
      setMessages([]);
      setViewers(0);
      setLikes(0);
      setLikedByMe(false);
      return;
    }

    const room = `cinema:${eventId}`;
    const connectionKey = `${room}:${APP_CINEMA_CLIENT_ID}`;
    const now = Date.now();
    if (
      wsConnectMetaRef.current.key === connectionKey &&
      now - wsConnectMetaRef.current.at < 1400
    ) {
      return;
    }
    wsConnectMetaRef.current = { key: connectionKey, at: now };

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
      }
      wsRef.current = null;
    }

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    setChatStatus('connecting');

    ws.onopen = () => {
      if (wsRef.current !== ws) {
        ws.close();
        return;
      }
      setChatStatus('connected');
      const snapshot = userSnapshotRef.current;
      ws.send(
        JSON.stringify({
          type: 'join',
          room,
          userId: snapshot.userId,
          nickname: snapshot.nickname,
          avatarUrl: snapshot.avatarUrl,
          client_id: APP_CINEMA_CLIENT_ID,
        })
      );
    };

    ws.onmessage = (ev) => {
      if (wsRef.current !== ws) return;
      try {
        const payload = JSON.parse(String(ev.data)) as WsIncoming;
        if (payload.type === 'history') {
          const normalized = dedupeMessages(
            (Array.isArray(payload.messages) ? payload.messages : []).map((item) =>
              normalizeIncomingMessage(item as Partial<ChatMessage> & Record<string, unknown>)
            )
          ).slice(-MAX_CHAT_MESSAGES);
          setMessages(normalized);
          return;
        }
        if (payload.type === 'message') {
          const normalized = normalizeIncomingMessage(payload.message as Partial<ChatMessage> & Record<string, unknown>);
          setMessages((prev) => dedupeMessages([...prev, normalized]).slice(-MAX_CHAT_MESSAGES));
          return;
        }
        if (payload.type === 'stats') {
          setViewers(Number(payload.viewers) || 0);
          setLikes(Number(payload.likes) || 0);
          return;
        }
        if (payload.type === 'liked') {
          setLikedByMe(!!payload.liked);
        }
      } catch {
      }
    };

    ws.onerror = () => {
      if (wsRef.current !== ws) return;
      setChatStatus('error');
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      setChatStatus('idle');
    };

    return () => {
      try {
        ws.close();
      } catch {
      }
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
    };
  }, [eventId, phase]);

  useEffect(() => {
    if (!messages.length || !shouldAutoscrollRef.current) return;
    const timer = setTimeout(() => {
      chatListRef.current?.scrollToEnd({ animated: true });
    }, 30);
    return () => clearTimeout(timer);
  }, [messages.length]);

  const sendMessage = () => {
    const text = chatText.trim();
    if (!text || !eventId || !wsRef.current || chatStatus !== 'connected') return;
    const now = Date.now();
    if (lastSentRef.current.text === text && now - lastSentRef.current.at < 900) return;
    lastSentRef.current = { text, at: now };
    wsRef.current.send(
      JSON.stringify({
        type: 'message',
        room: `cinema:${eventId}`,
        eventId,
        userId: currentUserId > 0 ? currentUserId : null,
        nickname: currentUserNickname,
        text,
      })
    );
    setChatText('');
  };

  const toggleLike = () => {
    if (!eventId || !wsRef.current || chatStatus !== 'connected') return;
    wsRef.current.send(
      JSON.stringify({
        type: 'like',
        room: `cinema:${eventId}`,
        liked: !likedByMe,
      })
    );
  };

  const openFullscreen = useCallback(async () => {
    try {
      await videoViewRef.current?.enterFullscreen();
    } catch {
    }
  }, []);

  const onChatScroll = useCallback((evt: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = evt.nativeEvent;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    shouldAutoscrollRef.current = distanceFromBottom < 72;
  }, []);

  const markAvatarFailed = useCallback((uri: string) => {
    setFailedAvatarUris((prev) => {
      if (prev[uri]) return prev;
      return { ...prev, [uri]: true };
    });
  }, []);

  const resolveAvatarUri = useCallback(
    (avatarUrl: string | null | undefined) => {
      const uri = sanitizeAvatarUri(avatarUrl);
      if (!uri) return null;
      if (failedAvatarUris[uri]) return null;
      return uri;
    },
    [failedAvatarUris]
  );

  const renderChatItem = useCallback(
    ({ item }: ListRenderItemInfo<ChatMessage>) => {
      const isMine = currentUserId > 0 && item.userId === currentUserId;
      const avatarUri = resolveAvatarUri(item.avatarUrl);
      return (
        <View style={[styles.messageCard, isMine && styles.messageCardMine]}>
          <View style={styles.messageMetaRow}>
            <Pressable
              style={styles.avatarWrap}
              onPress={() => {
                if (!item.userId) return;
                router.push(`/user/${item.userId}` as any);
              }}>
              {avatarUri ? (
                <Image
                  source={{ uri: avatarUri }}
                  style={styles.avatarImage}
                  onError={() => {
                    markAvatarFailed(avatarUri);
                  }}
                />
              ) : (
                <View style={styles.avatarFallback} />
              )}
            </Pressable>
            <Text style={styles.messageUser}>{item.nickname || 'guest'}</Text>
            <Text style={styles.messageTime}>{formatChatTime(item.createdAt)}</Text>
          </View>
          <Text style={styles.messageText}>{item.text}</Text>
        </View>
      );
    },
    [currentUserId, markAvatarFailed, resolveAvatarUri]
  );

  const onVotePollOption = useCallback(
    async (optionId: string) => {
      if (!poll || poll.status !== 'open') return;
      if (!(currentUserId > 0)) {
        setPollMessage('Sign in to vote.');
        return;
      }
      try {
        setPollSubmittingId(optionId);
        setPollMessage(null);
        const updated = await voteCinemaPoll(poll.id, currentUserId, optionId);
        const visiblePoll = updated && updated.status === 'open' ? updated : null;
        setPoll(visiblePoll);
        setPollMessage(visiblePoll ? 'Vote saved.' : null);
      } catch (err) {
        setPollMessage(err instanceof Error ? err.message : 'Could not submit vote.');
      } finally {
        setPollSubmittingId(null);
      }
    },
    [poll, currentUserId]
  );

  const renderPollCard = useCallback(() => {
    if (!poll || poll.status !== 'open') return null;
    const isClosed = poll.status !== 'open';
    const userHasVoted = !!poll.user_vote_option_id;
    const revealResults = isClosed || userHasVoted;
    return (
      <View style={styles.pollCard}>
        <LinearGradient
          colors={['rgba(10,14,26,0.97)', 'rgba(7,12,22,0.97)', 'rgba(5,8,16,0.99)']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.pollCardGradient}>
          <View style={styles.pollHeader}>
            <View style={styles.pollHeaderLeft}>
              <View style={styles.pollTitleIconWrap}>
                <Ionicons name="sparkles" size={12} color="#7dd3fc" />
              </View>
              <Text style={styles.pollTitle}>Cinema Poll</Text>
            </View>
            <Text style={[styles.pollStatus, isClosed ? styles.pollStatusClosed : styles.pollStatusOpen]}>
              {isClosed ? 'Closed' : 'Open'}
            </Text>
          </View>
          <Text style={styles.pollQuestion}>{poll.question || 'Choose next movie'}</Text>
          {!revealResults ? <Text style={styles.pollQuestionHint}>Vote once to reveal percentages</Text> : null}
          <View style={styles.pollOptionsWrap}>
            {poll.options.map((option, idx) => {
              const selected = poll.user_vote_option_id === option.id;
              const disabled = isClosed || !!pollSubmittingId || userHasVoted;
              const percent = Math.max(0, Math.min(100, Math.round(Number(option.percent || 0))));
              return (
                <Pressable
                  key={option.id}
                  onPress={() => void onVotePollOption(option.id)}
                  disabled={disabled}
                  style={[styles.pollOption, disabled ? styles.pollOptionDisabled : null]}>
                  <LinearGradient
                    colors={
                      selected
                        ? ['rgba(21,128,61,0.5)', 'rgba(8,20,24,0.92)']
                        : ['rgba(15,23,42,0.92)', 'rgba(17,24,39,0.82)']
                    }
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={[styles.pollOptionBackdrop, selected ? styles.pollOptionBackdropSelected : null]}>
                    {option.poster_url ? (
                      <Image source={{ uri: option.poster_url }} style={styles.pollPoster} resizeMode="cover" />
                    ) : (
                      <View style={styles.pollPosterFallback} />
                    )}
                    <View style={styles.pollMeta}>
                      <View style={styles.pollTitleRow}>
                        <View style={styles.pollRankBadge}>
                          <Text style={styles.pollRankBadgeText}>{idx + 1}</Text>
                        </View>
                        <Text style={styles.pollOptionTitle} numberOfLines={1}>
                          {option.title}
                        </Text>
                      </View>
                      {revealResults ? (
                        <>
                          <View style={styles.pollStatsRow}>
                            <Text style={styles.pollOptionStats}>{Number(option.votes || 0)} votes</Text>
                            <Text style={styles.pollOptionPercent}>{percent}%</Text>
                          </View>
                          <View style={styles.pollProgressTrack}>
                            <View
                              style={[
                                styles.pollProgressFill,
                                selected ? styles.pollProgressFillSelected : null,
                                { width: `${Math.max(selected ? 8 : 0, percent)}%` },
                              ]}
                            />
                          </View>
                        </>
                      ) : (
                        <Text style={styles.pollOptionHint}>Tap to vote</Text>
                      )}
                    </View>
                    {selected ? (
                      <Ionicons name="checkmark-circle" size={20} color="#22c55e" style={styles.pollCheckIcon} />
                    ) : null}
                  </LinearGradient>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.pollFooter}>
            {revealResults
              ? `Total votes: ${Number(poll.total_votes || 0)}`
              : 'Results stay hidden until you vote'}
          </Text>
          {pollMessage ? <Text style={styles.pollMessage}>{pollMessage}</Text> : null}
        </LinearGradient>
      </View>
    );
  }, [poll, pollSubmittingId, pollMessage, onVotePollOption]);

  const emptyPollTopOffset = Math.max(insets.top + 10, 18);

  const chatStateLabel =
    chatStatus === 'connected'
      ? 'ONLINE'
      : chatStatus === 'connecting'
        ? 'CONNECTING'
        : chatStatus === 'error'
          ? 'OFFLINE'
          : 'OFFLINE';

  const chatStateColor = chatStatus === 'connected' ? '#22c55e' : chatStatus === 'connecting' ? '#f59e0b' : '#ef4444';

  if (loading) {
    return (
      <View style={[styles.loader, { backgroundColor: theme.background }]}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  if (!event || phase === 'ended') {
    const showNoCinemaArtwork = !poll && !pollLoading;
    return (
      <View
        style={[
          styles.emptyRoot,
          poll ? styles.emptyRootWithPoll : null,
          poll ? { paddingTop: emptyPollTopOffset } : null,
          { backgroundColor: theme.background },
        ]}>
        <View
          style={[
            styles.emptyContent,
            poll ? styles.emptyContentWithPoll : null,
            { paddingBottom: Math.max(insets.bottom + 44, 64) },
          ]}>
          {showNoCinemaArtwork ? (
            <>
              {EMPTY_CINEMA_IMAGE_URL ? (
                <Image source={{ uri: EMPTY_CINEMA_IMAGE_URL }} style={styles.emptyImage} resizeMode="contain" />
              ) : (
                <Image source={LOCAL_EMPTY_CINEMA_IMAGE} style={styles.emptyImage} resizeMode="contain" />
              )}
              <Text style={styles.emptyTitle}>NO CINEMA YET</Text>
            </>
          ) : null}
          {pollLoading && !poll ? (
            <View style={styles.pollLoadingWrap}>
              <ActivityIndicator color="#fff" />
            </View>
          ) : null}
          {renderPollCard()}
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: theme.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 4 : 0}>
      {phase === 'upcoming' ? (
        <View style={[styles.phaseShell, { paddingTop: Math.max(insets.top + 10, Spacing.three + 8) }]}>
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

      {phase === 'live' ? (
        <View style={styles.liveShell}>
          <LinearGradient colors={['#1a1f33', '#0f1423', '#090d18']} style={StyleSheet.absoluteFillObject} />

          <View style={styles.playerCard}>
            <VideoView
              ref={videoViewRef}
              player={videoPlayer}
              style={styles.video}
              nativeControls={false}
              contentFit="contain"
              fullscreenOptions={{ enable: true, orientation: 'landscape' }}
              onFullscreenEnter={() => setIsFullscreen(true)}
              onFullscreenExit={() => setIsFullscreen(false)}
            />
            <LinearGradient
              colors={['rgba(0,0,0,0.66)', 'rgba(0,0,0,0.24)', 'rgba(0,0,0,0.0)']}
              style={styles.playerTopFade}
              pointerEvents="none"
            />
            <View style={[styles.playerOverlayTop, { top: Math.max(insets.top + 8, 14) }]}>
              <View style={styles.liveBadge}>
                <View style={styles.liveBadgeDot} />
                <Text style={styles.liveBadgeText}>LIVE</Text>
              </View>
              <Pressable style={styles.fullscreenBtn} onPress={() => void openFullscreen()}>
                <Ionicons name={isFullscreen ? 'contract-outline' : 'expand-outline'} size={18} color="#fff" />
              </Pressable>
            </View>
          </View>

          <View style={styles.statsRow}>
            <View style={styles.statPill}>
              <Ionicons name="eye-outline" size={18} color="#fff" />
              <Text style={styles.statText}>{viewers}</Text>
            </View>
            <Pressable style={styles.statPill} onPress={toggleLike}>
              <Ionicons name={likedByMe ? 'heart' : 'heart-outline'} size={18} color="#fff" />
              <Text style={styles.statText}>{likes}</Text>
            </Pressable>
            <View style={styles.chatStatePill}>
              <View style={[styles.chatStateDot, { backgroundColor: chatStateColor }]} />
              <Text style={styles.chatStatePillText}>{chatStateLabel}</Text>
            </View>
          </View>

          <View style={styles.chatPanel}>
            <View style={styles.chatHeaderRow}>
              <View>
                <Text style={styles.chatTitle}>Cinema Chat</Text>
                <Text style={styles.chatSubtitle}>Live reactions and comments</Text>
              </View>
              <Text style={styles.liveOnlyLabel}>Live only</Text>
            </View>

            <FlatList
              ref={chatListRef}
              data={messages}
              keyExtractor={(item) => item.id}
              renderItem={renderChatItem}
              style={styles.chatList}
              contentContainerStyle={styles.chatListContent}
              keyboardShouldPersistTaps="handled"
              onScroll={onChatScroll}
              scrollEventThrottle={16}
              onContentSizeChange={() => {
                if (!shouldAutoscrollRef.current) return;
                chatListRef.current?.scrollToEnd({ animated: false });
              }}
              ListEmptyComponent={<Text style={styles.emptyChatText}>No messages yet. Be first in chat.</Text>}
            />

            <View style={[styles.composerRow, { paddingBottom: Math.max(10, insets.bottom) }]}>
              <TextInput
                value={chatText}
                onChangeText={setChatText}
                placeholder={chatStatus === 'connected' ? 'Write a message...' : 'Chat offline'}
                placeholderTextColor="rgba(255,255,255,0.55)"
                style={styles.input}
                editable={chatStatus === 'connected'}
                returnKeyType="send"
                blurOnSubmit={false}
                onSubmitEditing={sendMessage}
              />
              <Pressable
                onPress={sendMessage}
                disabled={chatStatus !== 'connected' || !chatText.trim()}
                style={[styles.sendBtn, (chatStatus !== 'connected' || !chatText.trim()) && styles.sendBtnDisabled]}>
                <Ionicons name="send" size={18} color="#fff" />
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  loader: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
    overflow: 'hidden',
  },
  emptyRootWithPoll: {
    justifyContent: 'flex-start',
    paddingTop: Spacing.three,
  },
  emptyContent: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyContentWithPoll: {
    gap: 8,
  },
  emptyImage: {
    width: '94%',
    maxWidth: 500,
    height: 440,
  },
  emptyTitle: {
    marginTop: 14,
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 1.1,
    borderBottomWidth: 2,
    borderBottomColor: '#E10613',
    paddingBottom: 1,
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
  },
  phaseShell: {
    flex: 1,
    gap: 12,
    paddingHorizontal: Spacing.four,
    paddingTop: Spacing.three,
    paddingBottom: Spacing.three,
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
  pollLoadingWrap: {
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pollCard: {
    width: '100%',
    alignSelf: 'stretch',
    marginTop: 10,
    borderRadius: 24,
    overflow: 'hidden',
    shadowColor: '#020617',
    shadowOpacity: 0.45,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 14,
  },
  pollCardGradient: {
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 10,
  },
  pollHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pollHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pollTitleIconWrap: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(125,211,252,0.42)',
    backgroundColor: 'rgba(14,116,144,0.26)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pollTitle: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 16,
    textTransform: 'uppercase',
    letterSpacing: 0.9,
    fontWeight: '700',
  },
  pollStatus: {
    fontFamily: Fonts.mono,
    fontSize: 11,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    overflow: 'hidden',
  },
  pollStatusOpen: {
    color: '#4ade80',
    borderColor: 'rgba(34,197,94,0.55)',
    backgroundColor: 'rgba(22,163,74,0.22)',
  },
  pollStatusClosed: {
    color: '#fca5a5',
    borderColor: 'rgba(239,68,68,0.5)',
    backgroundColor: 'rgba(239,68,68,0.14)',
  },
  pollQuestion: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 20,
    lineHeight: 26,
  },
  pollQuestionHint: {
    color: 'rgba(191,219,254,0.9)',
    fontFamily: Fonts.mono,
    fontSize: 11,
    letterSpacing: 0.3,
  },
  pollOptionsWrap: {
    gap: 10,
  },
  pollOption: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  pollOptionDisabled: {
    opacity: 0.84,
  },
  pollOptionBackdrop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 16,
  },
  pollOptionBackdropSelected: {
    backgroundColor: 'rgba(34,197,94,0.06)',
  },
  pollPoster: {
    width: 58,
    height: 84,
    borderRadius: 10,
    backgroundColor: '#111',
  },
  pollPosterFallback: {
    width: 58,
    height: 84,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  pollMeta: {
    flex: 1,
    gap: 5,
  },
  pollTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  pollRankBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(15,23,42,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pollRankBadgeText: {
    color: 'rgba(226,232,240,0.95)',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  pollOptionTitle: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 17,
    flex: 1,
  },
  pollStatsRow: {
    marginTop: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pollOptionStats: {
    color: 'rgba(241,245,249,0.88)',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  pollOptionPercent: {
    color: '#86efac',
    fontFamily: Fonts.mono,
    fontSize: 11.5,
    fontWeight: '700',
  },
  pollOptionHint: {
    color: 'rgba(191,219,254,0.9)',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  pollProgressTrack: {
    marginTop: 2,
    height: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(148,163,184,0.28)',
    overflow: 'hidden',
  },
  pollProgressFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: '#34d399',
  },
  pollProgressFillSelected: {
    backgroundColor: '#22c55e',
  },
  pollCheckIcon: {
    marginLeft: 2,
  },
  pollFooter: {
    color: 'rgba(255,255,255,0.78)',
    fontFamily: Fonts.mono,
    fontSize: 11.5,
    marginTop: 1,
  },
  pollMessage: {
    color: '#dbeafe',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  liveShell: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#0a0f1c',
    minHeight: 0,
  },
  playerCard: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.12)',
    backgroundColor: '#000',
    position: 'relative',
  },
  video: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#000',
  },
  playerTopFade: {
    ...StyleSheet.absoluteFillObject,
  },
  playerOverlayTop: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(225,6,19,0.85)',
    backgroundColor: 'rgba(8,8,8,0.8)',
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  liveBadgeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#E10613',
  },
  liveBadgeText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  fullscreenBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 0,
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  statPill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    gap: 6,
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  statText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 12.5,
  },
  chatStatePill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1.25,
    gap: 6,
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chatStateDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  chatStatePillText: {
    color: 'rgba(255,255,255,0.9)',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  chatPanel: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: 10,
    paddingTop: 10,
    gap: 8,
  },
  chatHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  chatTitle: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 18,
    letterSpacing: 0.8,
    fontWeight: '700',
  },
  chatSubtitle: {
    color: 'rgba(255,255,255,0.68)',
    fontFamily: Fonts.serif,
    fontSize: 12,
  },
  liveOnlyLabel: {
    color: 'rgba(255,255,255,0.82)',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  chatList: {
    flex: 1,
    minHeight: 0,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(0,0,0,0.28)',
  },
  chatListContent: {
    padding: 10,
    gap: 8,
    paddingBottom: 12,
  },
  emptyChatText: {
    color: 'rgba(255,255,255,0.66)',
    fontFamily: Fonts.serif,
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 24,
  },
  messageCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 5,
  },
  messageCardMine: {
    borderColor: 'rgba(225,6,19,0.45)',
    backgroundColor: 'rgba(225,6,19,0.15)',
  },
  messageMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  avatarWrap: {
    width: 24,
    height: 24,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  avatarImage: {
    width: '100%',
    height: '100%',
  },
  avatarFallback: {
    width: '100%',
    height: '100%',
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  messageUser: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  messageTime: {
    color: 'rgba(255,255,255,0.55)',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  messageText: {
    color: 'rgba(255,255,255,0.92)',
    fontFamily: Fonts.serif,
    fontSize: 14,
    lineHeight: 19,
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 4,
  },
  input: {
    flex: 1,
    height: 46,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 12,
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 14,
  },
  sendBtn: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.42)',
    backgroundColor: '#0a0a0a',
  },
  sendBtnDisabled: {
    opacity: 0.5,
  },
  emptyText: {
    color: 'rgba(255,255,255,0.76)',
    fontFamily: Fonts.serif,
    fontSize: 13,
    lineHeight: 18,
  },
});


