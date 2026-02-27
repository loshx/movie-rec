import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { Dimensions, Platform, StyleSheet, useColorScheme, View } from 'react-native';
import LottieView from 'lottie-react-native';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';

const INITIAL_SCALE_FACTOR = Dimensions.get('screen').height / 90;
const DURATION = 600;

export function AnimatedSplashOverlay() {
  const [visible, setVisible] = useState(true);
  const [minDelayDone, setMinDelayDone] = useState(false);
  const [animationDone, setAnimationDone] = useState(false);
  const systemScheme = useColorScheme();
  const splashScheme: 'dark' | 'light' = systemScheme === 'light' ? 'light' : 'dark';
  const assetId =
    splashScheme === 'dark'
      ? require('../../assets/videos/b.json')
      : require('../../assets/videos/w.json');

  useEffect(() => {
    const minDelayMs = Platform.OS === 'web' ? 600 : 1600;
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
    setVisible(false);
  }, [minDelayDone, animationDone]);

  if (!visible) return null;

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
          renderMode="AUTOMATIC"
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
    transform: [{ scale: INITIAL_SCALE_FACTOR }],
  },
  100: {
    transform: [{ scale: 1 }],
    easing: Easing.elastic(0.7),
  },
});

const logoKeyframe = new Keyframe({
  0: {
    transform: [{ scale: 1.3 }],
    opacity: 0,
  },
  40: {
    transform: [{ scale: 1.3 }],
    opacity: 0,
    easing: Easing.elastic(0.7),
  },
  100: {
    opacity: 1,
    transform: [{ scale: 1 }],
    easing: Easing.elastic(0.7),
  },
});

const glowKeyframe = new Keyframe({
  0: {
    transform: [{ rotateZ: '0deg' }],
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

      <Animated.View entering={keyframe.duration(DURATION)} style={styles.background} />
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
    zIndex: 5000,
    elevation: 5000,
  },
  videoWrap: {
    width: '70%',
    maxWidth: 320,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  video: {
    width: '100%',
    height: '100%',
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
    zIndex: 100,
  },
  image: {
    position: 'absolute',
    width: 76,
    height: 71,
  },
  background: {
    borderRadius: 40,
    experimental_backgroundImage: `linear-gradient(180deg, #3C9FFE, #0274DF)`,
    width: 128,
    height: 128,
    position: 'absolute',
  },
});
