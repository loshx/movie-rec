import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';
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
const BTN_GAP = 6;
const ACTIVE_PILL_WIDTH = 62;

function normalizePath(pathname: string) {
  return pathname.endsWith('/') && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
}

function shouldHideDock(pathname: string, cinemaIsLive: boolean) {
  return (
    pathname.startsWith('/(auth)') ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/register') ||
    pathname.startsWith('/movie/') ||
    pathname.startsWith('/notifications') ||
    pathname.startsWith('/discover-picks') ||
    (pathname.startsWith('/cinema') && cinemaIsLive) ||
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
    <Pressable onPress={onPress} style={styles.dockBtnPressable}>
      {({ pressed }) => (
        <View
          style={[
            styles.dockBtnVisual,
            active ? styles.dockBtnVisualActive : null,
            pressed ? styles.dockBtnVisualPressed : null,
          ]}>
          <Ionicons name={icon} size={22} color={active ? '#121821' : '#F1F4FA'} />
        </View>
      )}
    </Pressable>
  );
}

export function GlobalBottomDock() {
  const router = useRouter();
  const pathnameRaw = usePathname() || '/';
  const pathname = normalizePath(pathnameRaw);
  const insets = useSafeAreaInsets();
  const [cinemaIsLive, setCinemaIsLive] = useState(false);
  const [dockWidth, setDockWidth] = useState(0);
  const activePlateX = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let active = true;
    let checking = false;
    if (!pathname.startsWith('/cinema')) {
      setCinemaIsLive(false);
      return () => {
        active = false;
      };
    }

    const refreshCinemaLiveState = async () => {
      if (checking) return;
      checking = true;
      try {
        const event = await getCinemaEventByStatusNow();
        if (!active) return;
        if (!event) {
          setCinemaIsLive(false);
          return;
        }
        const now = Date.now();
        const start = Date.parse(String(event.start_at ?? ''));
        const end = Date.parse(String(event.end_at ?? ''));
        const liveNow =
          Number.isFinite(start) &&
          Number.isFinite(end) &&
          now >= start &&
          now <= end;
        setCinemaIsLive(liveNow);
      } catch {
        if (!active) return;
        setCinemaIsLive(false);
      } finally {
        checking = false;
      }
    };

    void refreshCinemaLiveState();
    const timer = setInterval(() => {
      void refreshCinemaLiveState();
    }, 2000);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [pathname]);

  const hidden = shouldHideDock(pathname, cinemaIsLive);
  const activeHref =
    pathname.startsWith('/gallery')
      ? '/gallery'
      : pathname.startsWith('/cinema')
        ? '/cinema'
        : pathname.startsWith('/profile') || pathname.startsWith('/user') || pathname.startsWith('/profile-edit')
          ? '/profile'
          : '/';

  const activeIndex = useMemo(
    () => Math.max(0, ROUTES.findIndex((route) => route.href === activeHref)),
    [activeHref]
  );

  useEffect(() => {
    if (dockWidth <= 0) return;
    const slotWidth = dockWidth / ROUTES.length;
    const targetX = slotWidth * activeIndex + (slotWidth - ACTIVE_PILL_WIDTH) / 2;
    Animated.timing(activePlateX, {
      toValue: targetX,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [activeIndex, activePlateX, dockWidth]);

  if (hidden) return null;

  const onDockPress = (href: DockRoute['href']) => {
    if (href === activeHref) return;
    router.push(href);
  };

  const onDockLayout = (event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);
    if (next > 0 && next !== dockWidth) setDockWidth(next);
  };

  return (
    <View pointerEvents="box-none" style={styles.host}>
      <View
        style={[
          styles.wrap,
          {
            bottom: Math.max(insets.bottom + 4, Spacing.two),
          },
        ]}>
        <View style={styles.shell}>
          <View onLayout={onDockLayout} style={styles.inner}>
            {dockWidth > 0 ? (
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.activePlate,
                  {
                    transform: [{ translateX: activePlateX }],
                  },
                ]}
              />
            ) : null}
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
  },
  shell: {
    width: '100%',
    maxWidth: 320,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 8,
    backgroundColor: 'rgba(12,16,24,0.94)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: BTN_GAP,
    position: 'relative',
  },
  activePlate: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: ACTIVE_PILL_WIDTH,
    borderRadius: 999,
    backgroundColor: '#EFF3F9',
  },
  dockBtnPressable: {
    flex: 1,
    height: BTN_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  dockBtnVisual: {
    width: BTN_SIZE,
    height: BTN_SIZE,
    borderRadius: BTN_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dockBtnVisualActive: {
    backgroundColor: 'transparent',
  },
  dockBtnVisualPressed: {
    opacity: 0.82,
  },
});
