import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';

import { getBackendApiUrl, hasBackendApi } from '@/lib/cinema-backend';
import { getBackendUserTokenForUser, resolveBackendUserId } from '@/lib/backend-session';

type RegisterPushTokenInput = {
  userId: number;
  expoPushToken: string;
  platform: string;
  deviceName?: string | null;
};

let configured = false;

export function configureForegroundNotificationBehavior() {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
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
  const current = await Notifications.getPermissionsAsync();
  if (current.granted || current.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) {
    return current;
  }
  return Notifications.requestPermissionsAsync();
}

export async function getExpoPushTokenSafe() {
  if (!Device.isDevice) return null;
  const permission = await askForNotificationPermission();
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
  await Notifications.cancelScheduledNotificationAsync(clean).catch(() => {});
}

