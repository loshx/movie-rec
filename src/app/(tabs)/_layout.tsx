import React, { useCallback, useMemo } from 'react';
import { Stack } from 'expo-router';
import { usePathname, useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';

const TAB_ORDER = ['/', '/gallery', '/cinema', '/profile'] as const;
const EDGE_SIZE = 56;
const EDGE_TOP_GUARD = 188;
const EDGE_BOTTOM_GUARD = 96;
const SWIPE_DISTANCE = 72;
const SWIPE_VELOCITY = 760;

function normalizePath(pathname: string) {
  if (!pathname) return '/';
  if (pathname.endsWith('/') && pathname.length > 1) return pathname.slice(0, -1);
  return pathname;
}

export default function TabsLayout() {
  const router = useRouter();
  const pathnameRaw = usePathname() || '/';
  const pathname = normalizePath(pathnameRaw);

  const switchTab = useCallback(
    (direction: 'next' | 'prev') => {
      const currentIndex = TAB_ORDER.indexOf(pathname as (typeof TAB_ORDER)[number]);
      if (currentIndex < 0) return;
      const targetIndex = direction === 'next' ? currentIndex + 1 : currentIndex - 1;
      if (targetIndex < 0 || targetIndex >= TAB_ORDER.length) return;
      router.replace(TAB_ORDER[targetIndex]);
    },
    [pathname, router]
  );

  const goPrevTab = useCallback(() => switchTab('prev'), [switchTab]);
  const goNextTab = useCallback(() => switchTab('next'), [switchTab]);

  const leftEdgeGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-20, 20])
        .failOffsetY([-12, 12])
        .onEnd((event) => {
          const farRight = event.translationX > SWIPE_DISTANCE;
          const fastRight = event.velocityX > SWIPE_VELOCITY;
          if (farRight || fastRight) runOnJS(goPrevTab)();
        }),
    [goPrevTab]
  );

  const rightEdgeGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-20, 20])
        .failOffsetY([-12, 12])
        .onEnd((event) => {
          const farLeft = event.translationX < -SWIPE_DISTANCE;
          const fastLeft = event.velocityX < -SWIPE_VELOCITY;
          if (farLeft || fastLeft) runOnJS(goNextTab)();
        }),
    [goNextTab]
  );

  return (
    <View style={styles.root}>
      <Stack screenOptions={{ headerShown: false }} />
      <View pointerEvents="box-none" style={styles.edgesHost}>
        <GestureDetector gesture={leftEdgeGesture}>
          <View style={[styles.edgeZone, styles.leftEdge]} />
        </GestureDetector>
        <GestureDetector gesture={rightEdgeGesture}>
          <View style={[styles.edgeZone, styles.rightEdge]} />
        </GestureDetector>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  edgesHost: {
    ...StyleSheet.absoluteFillObject,
  },
  edgeZone: {
    position: 'absolute',
    top: EDGE_TOP_GUARD,
    bottom: EDGE_BOTTOM_GUARD,
    width: EDGE_SIZE,
  },
  leftEdge: {
    left: 0,
  },
  rightEdge: {
    right: 0,
  },
});
