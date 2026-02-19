import React from 'react';
import { Platform, StyleSheet, View, ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';

type GlassViewProps = {
  intensity?: number;
  tint?: 'light' | 'dark' | 'default';
  style?: ViewStyle | ViewStyle[];
  children?: React.ReactNode;
};

export function GlassView({
  intensity = 24,
  tint = 'dark',
  style,
  children,
}: GlassViewProps) {
  if (Platform.OS === 'android') {
    return (
      <BlurView intensity={intensity} tint={tint} style={[style, styles.androidBlur]}>
        <View pointerEvents="none" style={styles.androidOverlay} />
        {children}
      </BlurView>
    );
  }

  return (
    <BlurView intensity={intensity} tint={tint} style={style}>
      {children}
    </BlurView>
  );
}

const styles = StyleSheet.create({
  androidBlur: {
    backgroundColor: 'rgba(20,20,20,0.35)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  androidOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(20,20,20,0.28)',
    borderColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
  },
});
