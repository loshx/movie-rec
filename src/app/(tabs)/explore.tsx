import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Colors, Fonts, Spacing } from '@/constants/theme';

export default function ExploreScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Explore</Text>
      <Text style={styles.sub}>
        Aici vei integra TMDB ?i selec?ia de filme.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: Spacing.four,
    justifyContent: 'center',
    backgroundColor: Colors.light.background,
  },
  title: {
    fontSize: 24,
    fontFamily: Fonts.serif,
    marginBottom: Spacing.two,
  },
  sub: {
    fontFamily: Fonts.serif,
    color: Colors.light.textSecondary,
  },
});
