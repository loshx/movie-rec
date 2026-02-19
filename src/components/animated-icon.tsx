import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, useColorScheme, View } from 'react-native';
import LottieView from 'lottie-react-native';
import * as SplashScreen from 'expo-splash-screen';
import Animated, { Keyframe, Easing } from 'react-native-reanimated';
import { Image } from 'expo-image';

import classes from './animated-icon.module.css';
const DURATION = 300;

SplashScreen.preventAutoHideAsync().catch(() => {});

export function AnimatedSplashOverlay() {
  const [hidden, setHidden] = useState(false);
  const systemScheme = useColorScheme();
  const splashScheme: 'dark' | 'light' = systemScheme === 'light' ? 'light' : 'dark';
  const [minDelayDone, setMinDelayDone] = useState(false);
  const [animationDone, setAnimationDone] = useState(false);
  const assetId =
    splashScheme === 'dark'
      ? require('@/assets/videos/b.json')
      : require('@/assets/videos/w.json');

  useEffect(() => {
    const minDelayMs = Platform.OS === 'web' ? 600 : 2000;
    const maxDelayMs = Platform.OS === 'web' ? 2500 : 6000;
    const t = setTimeout(() => setMinDelayDone(true), minDelayMs);
    const fallback = setTimeout(() => setAnimationDone(true), maxDelayMs);
    return () => {
      clearTimeout(t);
      clearTimeout(fallback);
    };
  }, []);

  useEffect(() => {
    if (!minDelayDone || !animationDone) return;
    SplashScreen.hideAsync().catch(() => {});
    setHidden(true);
  }, [minDelayDone, animationDone]);

  if (hidden) return null;

  return (
    <View
      style={[
        styles.splashOverlay,
        { backgroundColor: splashScheme === 'light' ? '#FFFFFF' : '#000000' },
      ]}>
      <View style={styles.videoWrap}>
        <LottieView
          source={assetId}
          autoPlay
          loop={false}
          renderMode="SOFTWARE"
          style={[
            styles.video,
            { backgroundColor: splashScheme === 'light' ? '#FFFFFF' : '#000000' },
          ]}
          onAnimationFinish={() => setAnimationDone(true)}
        />
      </View>
    </View>
  );
}

const keyframe = new Keyframe({
  0: {
    transform: [{ scale: 0 }],
  },
  60: {
    transform: [{ scale: 1.2 }],
    easing: Easing.elastic(1.2),
  },
  100: {
    transform: [{ scale: 1 }],
    easing: Easing.elastic(1.2),
  },
});

const logoKeyframe = new Keyframe({
  0: {
    opacity: 0,
  },
  60: {
    transform: [{ scale: 1.2 }],
    opacity: 0,
    easing: Easing.elastic(1.2),
  },
  100: {
    transform: [{ scale: 1 }],
    opacity: 1,
    easing: Easing.elastic(1.2),
  },
});

const glowKeyframe = new Keyframe({
  0: {
    transform: [{ rotateZ: '-180deg' }, { scale: 0.8 }],
    opacity: 0,
  },
  [DURATION / 1000]: {
    transform: [{ rotateZ: '0deg' }, { scale: 1 }],
    opacity: 1,
    easing: Easing.elastic(0.7),
  },
  100: {
    transform: [{ rotateZ: '7200deg' }],
  },
});

export function AnimatedIcon() {
  return (
    <View style={styles.iconContainer}>
      <Animated.View entering={glowKeyframe.duration(60 * 1000 * 4)} style={styles.glow}>
        <Image style={styles.glow} source={require('@/assets/images/logo-glow.png')} />
      </Animated.View>

      <Animated.View style={styles.background} entering={keyframe.duration(DURATION)}>
        <div className={classes.expoLogoBackground} />
      </Animated.View>

      <Animated.View style={styles.imageContainer} entering={logoKeyframe.duration(DURATION)}>
        <Image style={styles.image} source={require('@/assets/images/expo-logo.png')} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  splashOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    elevation: 1000,
  },
  video: {
    width: '100%',
    height: '100%',
    backgroundColor: '#000000',
  },
  videoWrap: {
    width: '70%',
    maxWidth: 320,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  glow: {
    width: 201,
    height: 201,
    position: 'absolute',
  },
  iconContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 128,
    height: 128,
  },
  image: {
    position: 'absolute',
    width: 76,
    height: 71,
  },
  background: {
    width: 128,
    height: 128,
    position: 'absolute',
  },
  container: {
    alignItems: 'center',
    width: '100%',
    zIndex: 1000,
    position: 'absolute',
    top: 128 / 2 + 138,
  },
});
