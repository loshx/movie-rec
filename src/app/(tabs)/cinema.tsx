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
import { getCinemaEventByStatusNow, type CinemaEvent } from '@/db/cinema';
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

function dedupeMessages(messages: ChatMessage[]) {
  const seen = new Set<string>();
  const output: ChatMessage[] = [];
  for (const message of messages) {
    if (!message?.id || seen.has(message.id)) continue;
    seen.add(message.id);
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

  useEffect(() => {
    if (!eventId) return;
    const timer = setInterval(() => setNowIso(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, [eventId]);

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
        wsRef.current.close();
        wsRef.current = null;
      }
      setChatStatus(WS_URL ? 'idle' : 'error');
      setMessages([]);
      setViewers(0);
      setLikes(0);
      setLikedByMe(false);
      return;
    }

    const room = `cinema:${eventId}`;
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
      ws.close();
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

  if (!event) {
    return (
      <View style={[styles.loader, { backgroundColor: theme.background }]}>
        <Text style={styles.emptyText}>No cinema session scheduled yet.</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: theme.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 4 : 0}>
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
            <View style={styles.playerOverlayTop}>
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
    padding: Spacing.four,
    paddingBottom: 10,
    gap: 10,
  },
  loader: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  liveShell: {
    flex: 1,
    borderRadius: 28,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
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
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(225,6,19,0.85)',
    backgroundColor: 'rgba(8,8,8,0.8)',
    paddingHorizontal: 10,
    paddingVertical: 5,
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
    borderRadius: 18,
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
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)',
    backgroundColor: 'rgba(0,0,0,0.28)',
  },
  statPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(0,0,0,0.32)',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  statText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 12,
  },
  chatStatePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(0,0,0,0.32)',
    paddingHorizontal: 10,
    paddingVertical: 6,
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
    color: 'rgba(255,255,255,0.66)',
    fontFamily: Fonts.serif,
    fontSize: 12,
  },
});
