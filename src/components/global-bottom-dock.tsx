import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Spacing } from '@/constants/theme';
import { getCinemaEventByStatusNow } from '@/db/cinema';

type DockRoute = {
  key: string;
  href: '/' | '/gallery' | '/cinema' | '/profile';
  icon: keyof typeof Ionicons.glyphMap;
};

const ROUTES: DockRoute[] = [
  { key: 'home', href: '/', icon: 'home' },
  { key: 'gallery', href: '/gallery', icon: 'images' },
  { key: 'cinema', href: '/cinema', icon: 'videocam' },
  { key: 'profile', href: '/profile', icon: 'person' },
];
const BTN_SIZE = 48;
const BTN_GAP = 8;

function normalizePath(pathname: string) {
  return pathname.endsWith('/') && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
}

function shouldHideDock(pathname: string, cinemaHasEvent: boolean) {
  return (
    pathname.startsWith('/(auth)') ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/register') ||
    pathname.startsWith('/movie/') ||
    (pathname.startsWith('/cinema') && cinemaHasEvent) ||
    pathname.startsWith('/onboarding-watched') ||
    pathname.startsWith('/admin')
  );
}

function DockButton({
  active,
  icon,
  onPress,
}: {
  active: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.dockBtn, active ? styles.dockBtnActive : null, pressed && styles.pressed]}>
      <Ionicons name={icon} size={22} color={active ? '#0E131A' : '#E8EEF7'} />
    </Pressable>
  );
}

export function GlobalBottomDock() {
  const router = useRouter();
  const pathnameRaw = usePathname() || '/';
  const pathname = normalizePath(pathnameRaw);
  const insets = useSafeAreaInsets();
  const [cinemaHasEvent, setCinemaHasEvent] = useState(false);

  useEffect(() => {
    let active = true;
    if (!pathname.startsWith('/cinema')) {
      setCinemaHasEvent(false);
      return () => {
        active = false;
      };
    }
    (async () => {
      try {
        const event = await getCinemaEventByStatusNow();
        if (!active) return;
        setCinemaHasEvent(!!event);
      } catch {
        if (!active) return;
        setCinemaHasEvent(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [pathname]);

  const hidden = shouldHideDock(pathname, cinemaHasEvent);
  const activeHref =
    pathname.startsWith('/gallery')
      ? '/gallery'
      : pathname.startsWith('/cinema')
        ? '/cinema'
        : pathname.startsWith('/profile') || pathname.startsWith('/user') || pathname.startsWith('/profile-edit')
          ? '/profile'
          : '/';

  if (hidden) return null;

  const onDockPress = (href: DockRoute['href']) => {
    if (href === activeHref) return;
    router.push(href);
  };

  return (
    <View pointerEvents="box-none" style={styles.host}>
      <View style={[styles.wrap, { bottom: Math.max(insets.bottom, Spacing.two) }]}>
        <View style={styles.shell}>
          <View style={styles.inner}>
            {ROUTES.map((route) => (
              <DockButton
                key={route.key}
                icon={route.icon}
                active={activeHref === route.href}
                onPress={() => onDockPress(route.href)}
              />
            ))}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1200,
    elevation: 1200,
  },
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.three,
    alignItems: 'center',
    zIndex: 1200,
    elevation: 1200,
  },
  shell: {
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#0E131A',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: BTN_GAP,
    paddingHorizontal: Spacing.three,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#0E131A',
  },
  dockBtn: {
    width: BTN_SIZE,
    height: BTN_SIZE,
    borderRadius: BTN_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#161E29',
  },
  dockBtnActive: {
    backgroundColor: '#E8EEF7',
  },
  pressed: {
    opacity: 0.85,
  },
});
