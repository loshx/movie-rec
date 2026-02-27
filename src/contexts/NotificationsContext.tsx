import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, AppStateStatus, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/contexts/AuthContext';
import {
  addUserNotification,
  getUnreadNotificationCount,
  listLocalReplyCandidates,
  listNotificationSubscriptions,
  listUserNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  removeNotificationSubscription,
  type AppNotification,
  upsertNotificationSubscription,
  hasNotificationMarker,
  setNotificationMarker,
} from '@/db/notifications';
import { getCurrentCinemaPoll, getCinemaEventByStatusNow, type CinemaEvent } from '@/db/cinema';
import { getUserWatchlist } from '@/db/user-movies';
import { hasBackendApi, backendGetCommentReplyNotifications } from '@/lib/cinema-backend';
import {
  cancelScheduledLocalNotification,
  configureForegroundNotificationBehavior,
  getExpoPushTokenSafe,
  registerPushTokenOnBackend,
  scheduleLocalLiveReminder,
  unregisterPushTokenOnBackend,
} from '@/lib/push-notifications';

const SYNC_INTERVAL_MS = 45_000;
const TOAST_MS = 4_200;

type ToastState = {
  id: number;
  title: string;
  body: string;
};

type NotificationContextValue = {
  notifications: AppNotification[];
  unreadCount: number;
  refreshing: boolean;
  refresh: () => Promise<void>;
  markRead: (notificationId: number) => Promise<void>;
  markAllRead: () => Promise<void>;
  openNotification: (notification: AppNotification) => Promise<void>;
  armCinemaLiveReminder: (event?: CinemaEvent | null) => Promise<void>;
  disarmCinemaLiveReminder: (event?: CinemaEvent | null) => Promise<void>;
  isCinemaLiveReminderArmed: (event?: CinemaEvent | null) => boolean;
};

const NotificationsContext = createContext<NotificationContextValue | null>(null);

function dayMarker() {
  return new Date().toISOString().slice(0, 10);
}

function stripText(text: string, limit = 120) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function buildMovieReplyActionPath(tmdbIdInput: unknown, parentIdInput?: unknown, replyIdInput?: unknown) {
  const tmdbId = Number(tmdbIdInput);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return '/';
  const params = new URLSearchParams();
  params.set('openComments', '1');
  const parentId = Number(parentIdInput);
  if (Number.isFinite(parentId) && parentId > 0) {
    params.set('focusParent', String(Math.floor(parentId)));
  }
  const replyId = Number(replyIdInput);
  if (Number.isFinite(replyId) && replyId > 0) {
    params.set('focusReply', String(Math.floor(replyId)));
  }
  return `/movie/${Math.floor(tmdbId)}?${params.toString()}`;
}

function isEventLive(event: CinemaEvent | null, nowMs = Date.now()) {
  if (!event) return false;
  const start = Date.parse(String(event.start_at || ''));
  const end = Date.parse(String(event.end_at || ''));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return nowMs >= start && nowMs <= end;
}

function pickDailyMood() {
  const moods = [
    { genreId: 27, label: 'Horror', title: '👻 Want something terrifying?', body: 'Tap for 6 dark picks made for your vibe.' },
    { genreId: 35, label: 'Comedy', title: '😂 Want to laugh tonight?', body: 'Tap for 6 comedy picks with strong audience response.' },
    { genreId: 18, label: 'Drama', title: '🎭 Craving deep stories?', body: 'Tap for 6 drama picks tuned to your taste signals.' },
    { genreId: 878, label: 'Sci-Fi', title: '🚀 Need a mind-bending trip?', body: 'Tap for 6 sci-fi picks with top quality signals.' },
    { genreId: 53, label: 'Thriller', title: '🕵️ Want pure tension?', body: 'Tap for 6 thriller picks that keep pressure high.' },
    { genreId: 14, label: 'Fantasy', title: '🪄 Ready for another world?', body: 'Tap for 6 fantasy picks with high community scores.' },
    { genreId: 28, label: 'Action', title: '💥 Need adrenaline now?', body: 'Tap for 6 action picks with high momentum.' },
    { genreId: 10749, label: 'Romance', title: '❤️ Want something romantic?', body: 'Tap for 6 romance picks blended with your profile.' },
  ];
  const idx = Math.abs(new Date().getDate()) % moods.length;
  return moods[idx];
}

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  configureForegroundNotificationBehavior();
  const insets = useSafeAreaInsets();
  const toastTopOffset = useMemo(() => Math.max(16, insets.top + 10), [insets.top]);

  const { user } = useAuth();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [liveReminderTargets, setLiveReminderTargets] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<ToastState | null>(null);

  const syncLockRef = useRef(false);
  const notificationsRef = useRef<AppNotification[]>([]);
  const hasHydratedNotificationsRef = useRef(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const expoPushTokenRef = useRef<string | null>(null);
  const pushRegisterBusyRef = useRef(false);

  useEffect(() => {
    notificationsRef.current = notifications;
  }, [notifications]);

  const reloadFromStore = useCallback(async (userId: number) => {
    const [rows, unread, liveSubs] = await Promise.all([
      listUserNotifications(userId, 180),
      getUnreadNotificationCount(userId),
      listNotificationSubscriptions(userId, 'cinema_live'),
    ]);
    setNotifications(rows);
    setUnreadCount(unread);
    setLiveReminderTargets(new Set(liveSubs.map((row) => row.targetId)));
    return rows;
  }, []);

  const syncReplies = useCallback(async (userId: number) => {
    try {
      if (hasBackendApi()) {
        const remoteReplies = await backendGetCommentReplyNotifications(userId, { limit: 120 });
        for (const row of remoteReplies) {
          const source = row.source === 'gallery' ? 'gallery' : 'movie';
          const dedupe = `reply:${source}:${Number(row.reply_id)}`;
          const actionPath =
            source === 'movie' && Number(row.tmdb_id) > 0
              ? buildMovieReplyActionPath(row.tmdb_id, row.parent_id, row.reply_id)
              : source === 'gallery' && Number(row.gallery_id) > 0
                ? `/gallery?open=${Number(row.gallery_id)}`
                : '/';
          await addUserNotification(userId, {
            type: 'comment_reply',
            title: `💬 ${String(row.from_nickname || 'Someone')} replied to your comment`,
            body: stripText(String(row.text || ''), 140) || 'Open to view the reply.',
            actionPath,
            payload: {
              source,
              reply_id: Number(row.reply_id),
              parent_id: Number(row.parent_id),
            },
            dedupeKey: dedupe,
          });
        }
        return;
      }
    } catch {
    }

    const localReplies = await listLocalReplyCandidates(userId, 120);
    for (const row of localReplies) {
      const dedupe = `reply:${row.source}:${row.replyId}`;
      const actionPath =
        row.source === 'movie' && Number(row.tmdbId) > 0
          ? buildMovieReplyActionPath(row.tmdbId, row.parentId, row.replyId)
          : row.source === 'gallery' && Number(row.galleryId) > 0
            ? `/gallery?open=${Number(row.galleryId)}`
            : '/';
      await addUserNotification(userId, {
        type: 'comment_reply',
        title: `💬 ${String(row.fromNickname || 'Someone')} replied to your comment`,
        body: stripText(String(row.text || ''), 140) || 'Open to view the reply.',
        actionPath,
        payload: {
          source: row.source,
          reply_id: row.replyId,
          parent_id: row.parentId,
        },
        dedupeKey: dedupe,
      });
    }
  }, []);

  const syncCinemaPollNotification = useCallback(async (userId: number) => {
    const poll = await getCurrentCinemaPoll(userId).catch(() => null);
    if (!poll || poll.status !== 'open') return;
    await addUserNotification(userId, {
      type: 'cinema_poll_open',
      title: '🗳️ New Cinema poll is open',
      body: stripText(String(poll.question || 'Vote now and pick the next cinema title.'), 140),
      actionPath: '/cinema',
      payload: { poll_id: Number(poll.id) },
      dedupeKey: `cinema-poll-open:${Number(poll.id)}`,
    });
  }, []);

  const syncCinemaLiveReminderNotification = useCallback(async (userId: number) => {
    const event = await getCinemaEventByStatusNow().catch(() => null);
    if (!event || !isEventLive(event)) return;

    const subs = await listNotificationSubscriptions(userId, 'cinema_live');
    for (const sub of subs) {
      const targetId = String(sub.targetId || '').trim();
      const isMatchingTarget = targetId === 'next' || targetId === String(event.id);
      if (!isMatchingTarget) continue;
      await addUserNotification(userId, {
        type: 'cinema_live_start',
        title: `🎬 Live started: ${event.title}`,
        body: 'Your cinema reminder fired. Tap to join the stream now.',
        actionPath: '/cinema',
        payload: {
          event_id: Number(event.id),
          start_at: String(event.start_at || ''),
        },
        dedupeKey: `cinema-live-start:${Number(event.id)}`,
      });
      await removeNotificationSubscription(userId, 'cinema_live', targetId);
    }
  }, []);

  const syncCreativeReminders = useCallback(async (userId: number) => {
    const marker = dayMarker();

    const watchlistMarker = await hasNotificationMarker(userId, 'daily_watchlist', marker);
    if (!watchlistMarker) {
      const watchlist = await getUserWatchlist(userId).catch(() => []);
      if (watchlist.length > 0) {
        await addUserNotification(userId, {
          type: 'watchlist_reminder',
          title: '🍿 Your watchlist misses you',
          body: `You still have ${watchlist.length} title${watchlist.length === 1 ? '' : 's'} waiting. Tonight can be legendary.`,
          actionPath: '/profile-lists?section=watchlist',
          dedupeKey: `daily-watchlist:${marker}`,
        });
      }
      await setNotificationMarker(userId, 'daily_watchlist', marker);
    }

    const sparkMarker = await hasNotificationMarker(userId, 'daily_spark', marker);
    if (!sparkMarker) {
      const mood = pickDailyMood();
      await addUserNotification(userId, {
        type: 'trending_now',
        title: '🔥 Watch what everyone talks about now',
        body: 'Tap and open 6 hot picks powered by TMDB + your taste signals.',
        actionPath: '/discover-picks?mode=trending',
        dedupeKey: `daily-trending:${marker}`,
      });
      await addUserNotification(userId, {
        type: 'daily_mood',
        title: mood.title,
        body: mood.body,
        actionPath: `/discover-picks?mode=genre&genre=${mood.genreId}&label=${encodeURIComponent(mood.label)}`,
        dedupeKey: `daily-mood:${marker}:${mood.genreId}`,
      });
      await setNotificationMarker(userId, 'daily_spark', marker);
    }
  }, []);

  const refresh = useCallback(async () => {
    const userId = Number(user?.id ?? 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      setNotifications([]);
      setUnreadCount(0);
      setLiveReminderTargets(new Set());
      hasHydratedNotificationsRef.current = false;
      return;
    }
    if (syncLockRef.current) return;
    syncLockRef.current = true;
    setRefreshing(true);
    try {
      const previousTopId = Number(notificationsRef.current[0]?.id ?? 0);
      const hadNotificationsBefore = notificationsRef.current.length > 0;
      await syncReplies(userId);
      await syncCinemaPollNotification(userId);
      await syncCinemaLiveReminderNotification(userId);
      await syncCreativeReminders(userId);
      const nextRows = await reloadFromStore(userId);

      const nextTop = nextRows[0];
      if (
        hasHydratedNotificationsRef.current &&
        hadNotificationsBefore &&
        nextTop &&
        Number(nextTop.id) > previousTopId &&
        !nextTop.readAt &&
        String(appStateRef.current) === 'active'
      ) {
        setToast({
          id: Number(nextTop.id),
          title: String(nextTop.title || 'Notification'),
          body: String(nextTop.body || ''),
        });
      }
      hasHydratedNotificationsRef.current = true;
    } finally {
      syncLockRef.current = false;
      setRefreshing(false);
    }
  }, [
    user?.id,
    reloadFromStore,
    syncReplies,
    syncCinemaPollNotification,
    syncCinemaLiveReminderNotification,
    syncCreativeReminders,
  ]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setToast(null);
    }, TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast?.id]);

  useEffect(() => {
    const userId = Number(user?.id ?? 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      setNotifications([]);
      setUnreadCount(0);
      setLiveReminderTargets(new Set());
      hasHydratedNotificationsRef.current = false;
      return;
    }
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, SYNC_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh, user?.id]);

  const ensurePushRegistration = useCallback(async () => {
    const userId = Number(user?.id ?? 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      return;
    }
    if (pushRegisterBusyRef.current) return;
    pushRegisterBusyRef.current = true;
    try {
      const token = await getExpoPushTokenSafe();
      if (!token) {
        console.warn('[push] Expo push token missing. Permission denied or device not eligible.');
        return;
      }
      expoPushTokenRef.current = token;
      await registerPushTokenOnBackend({
        userId,
        expoPushToken: token,
        platform: String(Device.osName || 'unknown'),
        deviceName: Device.deviceName ?? null,
      });
    } catch (err) {
      console.warn('[push] register token failed:', err instanceof Error ? err.message : String(err));
    } finally {
      pushRegisterBusyRef.current = false;
    }
  }, [user?.id]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      appStateRef.current = next;
      if (next === 'active' && user?.id) {
        void refresh();
        void ensurePushRegistration();
      }
    });
    return () => sub.remove();
  }, [ensurePushRegistration, refresh, user?.id]);

  useEffect(() => {
    const userId = Number(user?.id ?? 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      return;
    }
    void ensurePushRegistration();
  }, [ensurePushRegistration, user?.id]);

  useEffect(() => {
    const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = (response.notification.request.content.data ?? {}) as Record<string, unknown>;
      const actionPath = String(data?.actionPath ?? '').trim();
      if (actionPath) {
        router.push(actionPath as never);
      }
    });
    return () => {
      responseSub.remove();
    };
  }, []);

  useEffect(() => {
    return () => {
      const userId = Number(user?.id ?? 0);
      const token = expoPushTokenRef.current;
      if (!Number.isFinite(userId) || userId <= 0) return;
      if (!token) return;
      void unregisterPushTokenOnBackend(userId, token).catch((err) => {
        console.warn('[push] unregister token failed:', err instanceof Error ? err.message : String(err));
      });
    };
  }, [user?.id]);

  const markRead = useCallback(
    async (notificationId: number) => {
      const userId = Number(user?.id ?? 0);
      if (!Number.isFinite(userId) || userId <= 0) return;
      await markNotificationRead(userId, notificationId);
      await reloadFromStore(userId);
    },
    [reloadFromStore, user?.id]
  );

  const markAllRead = useCallback(async () => {
    const userId = Number(user?.id ?? 0);
    if (!Number.isFinite(userId) || userId <= 0) return;
    await markAllNotificationsRead(userId);
    await reloadFromStore(userId);
  }, [reloadFromStore, user?.id]);

  const openNotification = useCallback(
    async (notification: AppNotification) => {
      const userId = Number(user?.id ?? 0);
      if (Number.isFinite(userId) && userId > 0) {
        await markNotificationRead(userId, Number(notification.id));
        await reloadFromStore(userId);
      }
      if (notification.actionPath) {
        router.push(notification.actionPath as never);
      }
    },
    [reloadFromStore, user?.id]
  );

  const armCinemaLiveReminder = useCallback(
    async (event?: CinemaEvent | null) => {
      const userId = Number(user?.id ?? 0);
      if (!Number.isFinite(userId) || userId <= 0) return;
      const target = event?.id ? String(event.id) : 'next';
      let localReminderId: string | null = null;
      if (event?.id && event?.start_at) {
        localReminderId =
          (await scheduleLocalLiveReminder({
            id: Number(event.id),
            title: String(event.title || 'Cinema'),
            startAt: String(event.start_at),
          })) ?? null;
      }
      await upsertNotificationSubscription(userId, 'cinema_live', target, {
        title: event?.title ?? null,
        start_at: event?.start_at ?? null,
        local_notification_id: localReminderId,
      });
      await addUserNotification(userId, {
        type: 'cinema_live_reminder_armed',
        title: '🔔 Reminder armed',
        body: event?.title
          ? `I will notify you when "${event.title}" goes live.`
          : 'I will notify you when the next cinema stream starts.',
        actionPath: '/cinema',
        dedupeKey: `cinema-live-armed:${target}`,
      });
      await reloadFromStore(userId);
    },
    [reloadFromStore, user?.id]
  );

  const disarmCinemaLiveReminder = useCallback(
    async (event?: CinemaEvent | null) => {
      const userId = Number(user?.id ?? 0);
      if (!Number.isFinite(userId) || userId <= 0) return;
      const target = event?.id ? String(event.id) : 'next';
      const current = await listNotificationSubscriptions(userId, 'cinema_live');
      const currentTarget = current.find((row) => row.targetId === target);
      const localId = String(currentTarget?.payload?.local_notification_id ?? '').trim();
      if (localId) {
        await cancelScheduledLocalNotification(localId);
      }
      await removeNotificationSubscription(userId, 'cinema_live', target);
      await reloadFromStore(userId);
    },
    [reloadFromStore, user?.id]
  );

  const isCinemaLiveReminderArmed = useCallback(
    (event?: CinemaEvent | null) => {
      const target = event?.id ? String(event.id) : 'next';
      return liveReminderTargets.has(target);
    },
    [liveReminderTargets]
  );

  const value = useMemo<NotificationContextValue>(
    () => ({
      notifications,
      unreadCount,
      refreshing,
      refresh,
      markRead,
      markAllRead,
      openNotification,
      armCinemaLiveReminder,
      disarmCinemaLiveReminder,
      isCinemaLiveReminderArmed,
    }),
    [
      notifications,
      unreadCount,
      refreshing,
      refresh,
      markRead,
      markAllRead,
      openNotification,
      armCinemaLiveReminder,
      disarmCinemaLiveReminder,
      isCinemaLiveReminderArmed,
    ]
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}
      {toast ? (
        <View pointerEvents="box-none" style={[styles.toastHost, { top: toastTopOffset }]}>
          <Pressable
            onPress={() => {
              const target = notificationsRef.current.find((row) => Number(row.id) === Number(toast.id));
              if (target) {
                void openNotification(target);
              }
              setToast(null);
            }}
            style={styles.toastCard}>
            <Text style={styles.toastTitle} numberOfLines={1}>
              {toast.title}
            </Text>
            <Text style={styles.toastBody} numberOfLines={2}>
              {toast.body}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </NotificationsContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications must be used inside NotificationsProvider.');
  return ctx;
}

const styles = StyleSheet.create({
  toastHost: {
    position: 'absolute',
    left: 12,
    right: 12,
    alignItems: 'center',
    zIndex: 4000,
    elevation: 4000,
  },
  toastCard: {
    width: '100%',
    maxWidth: 640,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(8,13,24,0.95)',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  toastTitle: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  toastBody: {
    marginTop: 4,
    color: 'rgba(230,236,245,0.88)',
    fontSize: 12,
    lineHeight: 17,
  },
});
