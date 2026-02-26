import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, usePathname, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo } from 'react';
import { Platform, StyleSheet, useColorScheme, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { GlobalBottomDock } from '@/components/global-bottom-dock';
import { AuthProvider } from '@/contexts/AuthContext';

const ROOT_TAB_PATHS = new Set(['/', '/gallery', '/cinema', '/profile']);
const BACK_EDGE_SIZE = 56;
const BACK_EDGE_TOP_GUARD = 172;
const BACK_EDGE_BOTTOM_GUARD = 84;
const BACK_SWIPE_DISTANCE = 70;
const BACK_SWIPE_VELOCITY = 760;

function normalizePath(pathname: string) {
  if (!pathname) return '/';
  if (pathname.endsWith('/') && pathname.length > 1) return pathname.slice(0, -1);
  return pathname;
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const router = useRouter();
  const pathnameRaw = usePathname() || '/';
  const pathname = normalizePath(pathnameRaw);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const color = media.matches ? '#000000' : '#FFFFFF';
      document.documentElement.style.backgroundColor = color;
      document.body.style.backgroundColor = color;
      let meta = document.querySelector('meta[name="theme-color"]');
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', 'theme-color');
        document.head.appendChild(meta);
      }
      meta.setAttribute('content', color);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);

  const shouldDisableBackSwipe = useMemo(
    () =>
      ROOT_TAB_PATHS.has(pathname) ||
      pathname.startsWith('/login') ||
      pathname.startsWith('/register') ||
      pathname.startsWith('/(auth)'),
    [pathname]
  );

  const goBack = useCallback(() => {
    if (shouldDisableBackSwipe) return;
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace('/');
  }, [router, shouldDisableBackSwipe]);

  const backSwipeGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-20, 20])
        .failOffsetY([-12, 12])
        .onEnd((event) => {
          if (shouldDisableBackSwipe) return;
          const farRight = event.translationX > BACK_SWIPE_DISTANCE;
          const fastRight = event.velocityX > BACK_SWIPE_VELOCITY;
          if (farRight || fastRight) runOnJS(goBack)();
        }),
    [goBack, shouldDisableBackSwipe]
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="onboarding-watched" />
            <Stack.Screen name="admin" />
            <Stack.Screen name="index" />
          </Stack>
          <GlobalBottomDock />
          {!shouldDisableBackSwipe ? (
            <View pointerEvents="box-none" style={styles.edgeHost}>
              <GestureDetector gesture={backSwipeGesture}>
                <View style={styles.leftEdgeZone} />
              </GestureDetector>
            </View>
          ) : null}
          <AnimatedSplashOverlay />
        </ThemeProvider>
      </AuthProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  edgeHost: {
    ...StyleSheet.absoluteFillObject,
  },
  leftEdgeZone: {
    position: 'absolute',
    left: 0,
    top: BACK_EDGE_TOP_GUARD,
    bottom: BACK_EDGE_BOTTOM_GUARD,
    width: BACK_EDGE_SIZE,
  },
});
