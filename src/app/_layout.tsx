import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import React, { useEffect } from 'react';
import { Platform, useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { GlobalBottomDock } from '@/components/global-bottom-dock';
import { AuthProvider } from '@/contexts/AuthContext';

export default function RootLayout() {
  const colorScheme = useColorScheme();

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

  return (
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
        <AnimatedSplashOverlay />
      </ThemeProvider>
    </AuthProvider>
  );
}
