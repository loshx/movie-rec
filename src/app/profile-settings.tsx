import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';

import { Fonts, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import { getUserListPrivacy, setUserListPrivacy } from '@/db/user-movies';

function buildUnifiedPrivacy(isPublic: boolean) {
  return {
    watchlist: isPublic,
    favorites: isPublic,
    watched: isPublic,
    rated: isPublic,
  };
}

export default function ProfileSettingsScreen() {
  const { user, logout } = useAuth();
  const [loadingPrivacy, setLoadingPrivacy] = useState(true);
  const [updatingPrivacy, setUpdatingPrivacy] = useState(false);
  const [isTastePublic, setIsTastePublic] = useState(false);

  const loadPrivacy = useCallback(async () => {
    if (!user?.id) {
      setLoadingPrivacy(false);
      return;
    }
    setLoadingPrivacy(true);
    try {
      const privacy = await getUserListPrivacy(user.id);
      setIsTastePublic(!!privacy.watchlist && !!privacy.favorites && !!privacy.watched && !!privacy.rated);
    } finally {
      setLoadingPrivacy(false);
    }
  }, [user?.id]);

  useEffect(() => {
    void loadPrivacy();
  }, [loadPrivacy]);

  const tasteLabel = useMemo(
    () => (isTastePublic ? 'Public taste profile' : 'Private taste profile'),
    [isTastePublic]
  );

  const toggleTaste = useCallback(async () => {
    if (!user?.id || updatingPrivacy) return;
    const next = !isTastePublic;
    setUpdatingPrivacy(true);
    setIsTastePublic(next);
    try {
      await setUserListPrivacy(user.id, buildUnifiedPrivacy(next));
    } catch {
      setIsTastePublic(!next);
    } finally {
      setUpdatingPrivacy(false);
    }
  }, [isTastePublic, updatingPrivacy, user?.id]);

  const handleSignOut = useCallback(async () => {
    await logout();
    router.replace('/login');
  }, [logout]);

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={['#05060A', '#090E16', '#06070A']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.bg}
      />

      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={18} color="#fff" />
        </Pressable>
        <Text style={styles.headerTitle}>Settings</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.statusCard}>
          <Text style={styles.statusTitle}>Taste visibility</Text>
          {loadingPrivacy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.statusText}>{tasteLabel}</Text>
          )}
          <Pressable
            onPress={() => void toggleTaste()}
            disabled={loadingPrivacy || updatingPrivacy}
            style={[styles.primaryBtn, (loadingPrivacy || updatingPrivacy) ? styles.primaryBtnDisabled : null]}>
            <Text style={styles.primaryBtnText}>
              {updatingPrivacy ? 'Updating...' : isTastePublic ? 'Make Private Taste' : 'Make Public Taste'}
            </Text>
          </Pressable>
        </View>

        <View style={styles.menuCard}>
          <Pressable onPress={() => router.push('/about-app' as any)} style={styles.menuItem}>
            <Ionicons name="information-circle-outline" size={18} color="#fff" />
            <Text style={styles.menuText}>About App</Text>
          </Pressable>

          <Pressable onPress={() => router.push('/profile-edit')} style={styles.menuItem}>
            <Ionicons name="create-outline" size={18} color="#fff" />
            <Text style={styles.menuText}>Edit Profile</Text>
          </Pressable>

          {user?.role === 'admin' ? (
            <Pressable onPress={() => router.push('/admin')} style={styles.menuItem}>
              <Ionicons name="shield-checkmark-outline" size={18} color="#fff" />
              <Text style={styles.menuText}>Admin Panel</Text>
            </Pressable>
          ) : null}

          <Pressable onPress={() => void handleSignOut()} style={[styles.menuItem, styles.menuItemDanger]}>
            <Ionicons name="log-out-outline" size={18} color="#ffd8d8" />
            <Text style={styles.menuTextDanger}>Sign Out</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#05070C',
  },
  bg: {
    ...StyleSheet.absoluteFillObject,
  },
  header: {
    paddingTop: 58,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.26)',
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 15,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  headerSpacer: {
    width: 38,
    height: 38,
  },
  content: {
    paddingHorizontal: Spacing.three,
    paddingBottom: 120,
    gap: 12,
  },
  statusCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    backgroundColor: 'rgba(14,18,28,0.84)',
    padding: Spacing.three,
    gap: 10,
  },
  statusTitle: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  statusText: {
    color: 'rgba(255,255,255,0.84)',
    fontFamily: Fonts.serif,
    fontSize: 16,
  },
  primaryBtn: {
    marginTop: 4,
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.32)',
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  primaryBtnDisabled: {
    opacity: 0.65,
  },
  primaryBtnText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 12,
  },
  menuCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(10,13,20,0.82)',
    padding: Spacing.two,
    gap: 8,
  },
  menuItem: {
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  menuText: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 14,
  },
  menuItemDanger: {
    borderColor: 'rgba(255,120,120,0.46)',
    backgroundColor: 'rgba(120,14,20,0.26)',
  },
  menuTextDanger: {
    color: '#ffd8d8',
    fontFamily: Fonts.serif,
    fontSize: 14,
  },
});
