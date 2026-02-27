import React, { useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';

import { useNotifications } from '@/contexts/NotificationsContext';

function relativeTime(iso: string) {
  const ts = Date.parse(String(iso || ''));
  if (!Number.isFinite(ts)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'just now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function NotificationsScreen() {
  const { notifications, unreadCount, refreshing, markAllRead, openNotification } = useNotifications();

  const headerRight = useMemo(() => {
    if (notifications.length === 0) return null;
    return (
      <Pressable onPress={() => void markAllRead()} style={styles.markAllBtn}>
        <Text style={styles.markAllText}>Mark all read</Text>
      </Pressable>
    );
  }, [markAllRead, notifications.length]);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={18} color="#FFFFFF" />
        </Pressable>
        <View style={styles.headerTextWrap}>
          <Text style={styles.title}>Notifications</Text>
          <Text style={styles.subtitle}>
            {refreshing ? 'Syncing...' : unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
          </Text>
        </View>
        {headerRight ?? <View style={styles.placeholderRight} />}
      </View>

      <FlatList
        data={notifications}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyTitle}>No notifications yet</Text>
            <Text style={styles.emptyBody}>You will see replies, live reminders, and smart picks here.</Text>
          </View>
        }
        renderItem={({ item }) => {
          const unread = !item.readAt;
          return (
            <Pressable
              onPress={() => void openNotification(item)}
              style={[styles.card, unread ? styles.cardUnread : null]}>
              <View style={styles.cardTop}>
                <Text style={[styles.cardTitle, unread ? styles.cardTitleUnread : null]} numberOfLines={2}>
                  {item.title}
                </Text>
                <Text style={styles.cardTime}>{relativeTime(item.createdAt)}</Text>
              </View>
              <Text style={styles.cardBody} numberOfLines={3}>
                {item.body}
              </Text>
              {unread ? <View style={styles.unreadDot} /> : null}
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#04070F',
  },
  header: {
    paddingTop: 58,
    paddingHorizontal: 14,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  headerTextWrap: {
    flex: 1,
  },
  title: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: '800',
  },
  subtitle: {
    marginTop: 2,
    color: 'rgba(221,228,238,0.78)',
    fontSize: 12,
  },
  markAllBtn: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: 'rgba(147,197,253,0.45)',
    backgroundColor: 'rgba(59,130,246,0.15)',
  },
  markAllText: {
    color: '#D7E8FF',
    fontSize: 11,
    fontWeight: '600',
  },
  placeholderRight: {
    width: 36,
    height: 36,
  },
  listContent: {
    paddingHorizontal: 14,
    paddingBottom: 120,
    gap: 10,
  },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    backgroundColor: '#0A1020',
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  cardUnread: {
    borderColor: 'rgba(59,130,246,0.55)',
    backgroundColor: '#091528',
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 8,
  },
  cardTitle: {
    flex: 1,
    color: '#E7EDF8',
    fontSize: 14,
    fontWeight: '700',
  },
  cardTitleUnread: {
    color: '#FFFFFF',
  },
  cardTime: {
    color: 'rgba(203,214,230,0.62)',
    fontSize: 10,
    marginTop: 1,
  },
  cardBody: {
    marginTop: 6,
    color: 'rgba(221,228,238,0.84)',
    fontSize: 12,
    lineHeight: 17,
    paddingRight: 8,
  },
  unreadDot: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#60A5FA',
  },
  emptyWrap: {
    marginTop: 80,
    alignItems: 'center',
    paddingHorizontal: 28,
  },
  emptyTitle: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 18,
  },
  emptyBody: {
    marginTop: 8,
    color: 'rgba(214,223,236,0.75)',
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 20,
  },
});

