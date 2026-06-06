import Constants from 'expo-constants';
import * as Device from 'expo-device';

import { getBackendApiUrl, hasBackendApi } from '@/lib/cinema-backend';
import { getBackendUserTokenForUser, resolveBackendUserId } from '@/lib/backend-session';

type NotificationsModule = typeof import('expo-notifications');
type NotificationResponse = Parameters<NotificationsModule['addNotificationResponseReceivedListener']>[0] extends (
  response: infer Response
) => void
  ? Response
  : never;

type RegisterPushTokenInput = {
  userId: number;
  expoPushToken: string;
  platform: string;
  deviceName?: string | null;
};

let configured = false;
let notificationsModulePromise: Promise<NotificationsModule | null> | null = null;

function isExpoGoRuntime() {
  const constants = Constants as typeof Constants & {
    appOwnership?: string;
    executionEnvironment?: string;
  };
  return constants.appOwnership === 'expo' || constants.executionEnvironment === 'storeClient';
}

export function canUseNativeNotifications() {
  return !isExpoGoRuntime();
}

async function getNotificationsModule() {
  if (!canUseNativeNotifications()) return null;
  if (!notificationsModulePromise) {
    notificationsModulePromise = import('expo-notifications').catch((err) => {
      console.warn('[push] expo-notifications unavailable:', err instanceof Error ? err.message : String(err));
      return null;
    });
  }
  return notificationsModulePromise;
}

export function configureForegroundNotificationBehavior() {
  if (configured) return;
  configured = true;
  void getNotificationsModule().then((Notifications) => {
    if (!Notifications) return;
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
  });
}

export function notificationProjectId() {
  const extras = (Constants.expoConfig?.extra ?? {}) as { eas?: { projectId?: string } };
  const fromConfig = String(extras?.eas?.projectId ?? '').trim();
  if (fromConfig) return fromConfig;
  const fromEas = String(Constants.easConfig?.projectId ?? '').trim();
  if (fromEas) return fromEas;
  return '';
}

function normalizeExpoPushToken(value: unknown) {
  const token = String(value ?? '').trim();
  if (!token) return '';
  if (/^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(token)) return token;
  return '';
}

export async function ensureDefaultNotificationChannel() {
  const Notifications = await getNotificationsModule();
  if (!Notifications) return;
  if (Device.osName !== 'Android') return;
  await Notifications.setNotificationChannelAsync('default', {
    name: 'Default',
    importance: Notifications.AndroidImportance.MAX,
    sound: 'default',
    vibrationPattern: [0, 250, 250, 250],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
}

export async function askForNotificationPermission() {
  const Notifications = await getNotificationsModule();
  if (!Notifications) return null;
  const current = await Notifications.getPermissionsAsync();
  if (current.granted || current.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) {
    return current;
  }
  return Notifications.requestPermissionsAsync();
}

export async function getExpoPushTokenSafe() {
  const Notifications = await getNotificationsModule();
  if (!Notifications) return null;
  if (!Device.isDevice) return null;
  const permission = await askForNotificationPermission();
  if (!permission) return null;
  const granted =
    permission.granted || permission.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  if (!granted) return null;

  const projectId = notificationProjectId();
  if (!projectId) {
    throw new Error('Missing EAS projectId in app config (extra.eas.projectId).');
  }
  await ensureDefaultNotificationChannel();
  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  const normalized = normalizeExpoPushToken(token?.data);
  if (!normalized) return null;
  return normalized;
}

async function postBackendJson(path: string, body: Record<string, unknown>, userIdForToken: number) {
  if (!hasBackendApi()) return null;
  const url = getBackendApiUrl(path);
  if (!url) return null;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const token = getBackendUserTokenForUser(userIdForToken);
  if (token) headers['x-user-token'] = token;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let errorText = `Backend error ${response.status}`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload?.error) errorText = payload.error;
    } catch {
    }
    throw new Error(errorText);
  }
  return response.json().catch(() => null);
}

export async function registerPushTokenOnBackend(input: RegisterPushTokenInput) {
  const resolvedUserId = Number(resolveBackendUserId(input.userId) ?? input.userId);
  if (!Number.isFinite(resolvedUserId) || resolvedUserId <= 0) return;
  const token = normalizeExpoPushToken(input.expoPushToken);
  if (!token) return;
  await postBackendJson(
    '/api/notifications/push/register',
    {
      user_id: resolvedUserId,
      expo_push_token: token,
      platform: String(input.platform || Device.osName || 'unknown').trim() || 'unknown',
      device_name: String(input.deviceName ?? Device.deviceName ?? '').trim() || null,
    },
    resolvedUserId
  );
}

export async function unregisterPushTokenOnBackend(userId: number, token: string) {
  const resolvedUserId = Number(resolveBackendUserId(userId) ?? userId);
  if (!Number.isFinite(resolvedUserId) || resolvedUserId <= 0) return;
  const normalized = normalizeExpoPushToken(token);
  if (!normalized) return;
  await postBackendJson(
    '/api/notifications/push/unregister',
    {
      user_id: resolvedUserId,
      expo_push_token: normalized,
    },
    resolvedUserId
  );
}

export async function scheduleLocalLiveReminder(
  event: {
    id: number;
    title: string;
    startAt: string;
  },
  options?: { actionPath?: string }
) {
  const Notifications = await getNotificationsModule();
  if (!Notifications) return null;
  const startDate = new Date(event.startAt);
  if (!Number.isFinite(startDate.getTime())) return null;
  const fireAt = new Date(startDate.getTime() - 2000);
  if (fireAt.getTime() <= Date.now()) return null;
  const identifier = await Notifications.scheduleNotificationAsync({
    content: {
      title: `🎬 ${event.title} is starting`,
      body: 'Your cinema reminder is ready. Join now.',
      data: {
        actionPath: options?.actionPath ?? '/cinema',
        type: 'cinema_live_start_local',
        eventId: Number(event.id),
      },
      sound: 'default',
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: fireAt,
      channelId: 'default',
    },
  });
  return identifier;
}

export async function cancelScheduledLocalNotification(identifier: string | null | undefined) {
  const clean = String(identifier ?? '').trim();
  if (!clean) return;
  const Notifications = await getNotificationsModule();
  if (!Notifications) return;
  await Notifications.cancelScheduledNotificationAsync(clean).catch(() => {});
}

export async function addNotificationResponseListener(
  listener: (response: NotificationResponse) => void
) {
  const Notifications = await getNotificationsModule();
  if (!Notifications) return null;
  return Notifications.addNotificationResponseReceivedListener(listener);
}
