import {
  Tabs,
  TabList,
  TabTrigger,
  TabSlot,
  TabTriggerSlotProps,
  TabListProps,
} from 'expo-router/ui';
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Pressable, useColorScheme, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { GlassView } from '@/components/glass-view';

import { ThemedText } from './themed-text';
import { ThemedView } from './themed-view';

import { Colors, MaxContentWidth, Spacing } from '@/constants/theme';

export default function AppTabs() {
  return (
    <Tabs>
      <TabSlot style={{ height: '100%' }} />
      <TabList asChild>
        <CustomTabList>
          <TabTrigger name="index" href="/" asChild>
            <TabButton icon="home" />
          </TabTrigger>
          <TabTrigger name="gallery" href="/gallery" asChild>
            <TabButton icon="images" />
          </TabTrigger>
          <TabTrigger name="cinema" href="/cinema" asChild>
            <TabButton icon="videocam" />
          </TabTrigger>
          <TabTrigger name="profile" href="/profile" asChild>
            <TabButton icon="person" />
          </TabTrigger>
        </CustomTabList>
      </TabList>
    </Tabs>
  );
}

function TabButton({
  icon,
  isFocused,
  ...props
}: TabTriggerSlotProps & { icon: keyof typeof Ionicons.glyphMap }) {
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'unspecified' ? 'light' : scheme];
  const scale = useRef(new Animated.Value(isFocused ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(scale, {
      toValue: isFocused ? 1 : 0,
      useNativeDriver: true,
      damping: 14,
      stiffness: 180,
    }).start();
  }, [isFocused, scale]);

  const animatedStyle = useMemo(
    () => ({
      transform: [
        {
          scale: scale.interpolate({
            inputRange: [0, 1],
            outputRange: [0.95, 1.08],
          }),
        },
      ],
    }),
    [scale]
  );

  return (
    <Pressable {...props} style={({ pressed }) => pressed && styles.pressed}>
      <ThemedView
        type={isFocused ? 'backgroundSelected' : 'backgroundElement'}
        style={styles.tabButtonView}>
        <Animated.View style={animatedStyle}>
          <Ionicons
            name={icon}
            size={20}
            color={isFocused ? colors.text : colors.textSecondary}
          />
        </Animated.View>
        <ThemedText type="small" style={styles.hiddenLabel}>
          {isFocused ? 'active' : 'idle'}
        </ThemedText>
      </ThemedView>
    </Pressable>
  );
}

function CustomTabList(props: TabListProps) {
  const scheme = useColorScheme();
  return (
    <View {...props} style={styles.tabListContainer}>
      <View style={styles.glassShell}>
        <GlassView intensity={30} tint={scheme === 'dark' ? 'dark' : 'light'} style={styles.blur}>
          <View
            style={[
              styles.innerContainer,
              {
                borderColor: scheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
                backgroundColor: scheme === 'dark'
                  ? 'rgba(20,20,20,0.45)'
                  : 'rgba(255,255,255,0.6)',
              },
            ]}>
            {props.children}
          </View>
        </GlassView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tabListContainer: {
    position: 'absolute',
    width: '100%',
    bottom: Spacing.three,
    padding: Spacing.three,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
  },
  glassShell: {
    borderRadius: 999,
    overflow: 'hidden',
  },
  blur: {
    borderRadius: 999,
  },
  innerContainer: {
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.five,
    borderRadius: 999,
    flexDirection: 'row',
    alignItems: 'center',
    flexGrow: 1,
    gap: Spacing.two,
    maxWidth: MaxContentWidth,
    justifyContent: 'space-evenly',
    borderWidth: 1,
  },
  pressed: {
    opacity: 0.7,
  },
  tabButtonView: {
    paddingVertical: Spacing.one,
    paddingHorizontal: Spacing.three,
    borderRadius: 999,
    alignItems: 'center',
    flexDirection: 'row',
    gap: Spacing.one,
  },
  hiddenLabel: {
    height: 0,
    width: 0,
    opacity: 0,
  },
});
