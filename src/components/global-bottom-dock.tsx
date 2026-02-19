import React, { useRef, useEffect, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet, useColorScheme, Vibration, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Colors, Spacing } from '@/constants/theme';
import { GlassView } from '@/components/glass-view';
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
const BTN_SIZE = 42;
const BTN_GAP = Spacing.two;
const INDICATOR_WIDTH = 22;

function normalizePath(pathname: string) {
  return pathname.endsWith('/') && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
}

function shouldHideDock(pathname: string, cinemaHasEvent: boolean) {
  return (
    pathname.startsWith('/(auth)') ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/register') ||
    (pathname.startsWith('/cinema') && cinemaHasEvent) ||
    pathname.startsWith('/onboarding-watched') ||
    pathname.startsWith('/admin')
  );
}

function DockButton({
  active,
  icon,
  onPress,
  activeColor,
}: {
  active: boolean;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  activeColor: string;
}) {
  const scale = useRef(new Animated.Value(active ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(scale, {
      toValue: active ? 1 : 0,
      useNativeDriver: true,
      damping: 14,
      stiffness: 180,
    }).start();
  }, [active, scale]);

  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.dockBtn, pressed && styles.pressed]}>
      <Animated.View
        style={{
          transform: [
            {
              scale: scale.interpolate({
                inputRange: [0, 1],
                outputRange: [0.95, 1.08],
              }),
            },
          ],
        }}>
        <Ionicons name={icon} size={20} color={active ? activeColor : '#fff'} />
      </Animated.View>
    </Pressable>
  );
}

export function GlobalBottomDock() {
  const router = useRouter();
  const pathnameRaw = usePathname() || '/';
  const pathname = normalizePath(pathnameRaw);
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];
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
  const activeIndex = Math.max(
    0,
    ROUTES.findIndex((route) => route.href === activeHref)
  );
  const indicatorX = useRef(new Animated.Value(activeIndex * (BTN_SIZE + BTN_GAP))).current;

  useEffect(() => {
    Animated.spring(indicatorX, {
      toValue: activeIndex * (BTN_SIZE + BTN_GAP),
      useNativeDriver: true,
      damping: 18,
      stiffness: 220,
    }).start();
  }, [activeIndex, indicatorX]);

  if (hidden) return null;

  const onDockPress = (href: DockRoute['href']) => {
    if (Platform.OS !== 'web') {
      Vibration.vibrate(8);
    }
    router.push(href);
  };

  return (
    <View pointerEvents="box-none" style={styles.host}>
      <View style={[styles.wrap, { bottom: Math.max(insets.bottom, Spacing.two) }]}>
        <GlassView intensity={30} tint={scheme === 'dark' ? 'dark' : 'light'} style={styles.glass}>
          <View
            style={[
              styles.inner,
              {
                borderColor: scheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
                backgroundColor: scheme === 'dark' ? 'rgba(20,20,20,0.45)' : 'rgba(255,255,255,0.6)',
              },
            ]}>
            <Animated.View
              pointerEvents="none"
              style={[
                styles.activeIndicator,
                {
                  width: INDICATOR_WIDTH,
                  transform: [{ translateX: indicatorX }],
                },
              ]}
            />
            {ROUTES.map((route) => (
              <DockButton
                key={route.key}
                icon={route.icon}
                active={activeHref === route.href}
                activeColor={colors.text}
                onPress={() => onDockPress(route.href)}
              />
            ))}
          </View>
        </GlassView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    ...StyleSheet.absoluteFillObject,
  },
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.three,
    alignItems: 'center',
  },
  glass: {
    borderRadius: 999,
    overflow: 'hidden',
  },
  inner: {
    position: 'relative',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.five,
    paddingVertical: Spacing.two,
    borderWidth: 1,
    borderRadius: 999,
  },
  dockBtn: {
    width: BTN_SIZE,
    height: BTN_SIZE,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  activeIndicator: {
    position: 'absolute',
    left: Spacing.five + (BTN_SIZE - INDICATOR_WIDTH) / 2,
    bottom: 4,
    height: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.95)',
  },
  pressed: {
    opacity: 0.7,
  },
});
