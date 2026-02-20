import { Platform } from 'react-native';

import '@/global.css';

export const Colors = {
  light: {
    text: '#1A1A1A',
    background: '#F6EAD1',
    backgroundElement: '#FFFFFF',
    backgroundSelected: '#F0DCC0',
    textSecondary: '#5A5448',
    accent: '#C1121F',
  },
  dark: {
    text: '#F5F5F5',
    background: '#121212',
    backgroundElement: '#1E1E1E',
    backgroundSelected: '#2A2A2A',
    textSecondary: '#9A9A9A',
    accent: '#C1121F',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

const platformFonts = Platform.select({
  ios: {
    light: 'Verdana',
    bold: 'Verdana-Bold',
  },
  android: {
    // Verdana is not guaranteed on Android, so we use the closest stable fallback.
    light: 'sans-serif',
    bold: 'sans-serif-medium',
  },
  web: {
    light: 'Verdana, Geneva, sans-serif',
    bold: 'Verdana, Geneva, sans-serif',
  },
  default: {
    light: 'sans-serif',
    bold: 'sans-serif',
  },
})!;

export const Fonts = {
  light: platformFonts.light,
  bold: platformFonts.bold,
  sans: platformFonts.light,
  serif: platformFonts.light,
  rounded: platformFonts.light,
  mono: platformFonts.bold,
} as const;

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
