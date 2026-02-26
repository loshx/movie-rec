import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';

import { Fonts, Spacing } from '@/constants/theme';

const ABOUT_SECTIONS = [
  {
    icon: '🎬',
    title: 'Smart Discovery',
    description:
      'Movie Rec mixes your favorites, watched titles and ratings to suggest better films and series.',
  },
  {
    icon: '🧠',
    title: 'ML + Similarity',
    description:
      'Recommendations combine ML signals with similar-title matching so suggestions stay close to your taste.',
  },
  {
    icon: '👥',
    title: 'Social Taste',
    description:
      'You can follow people, share public taste, and discover titles from profiles with similar interests.',
  },
  {
    icon: '📷',
    title: 'Gallery + Cinema',
    description:
      'Save movie shots, comment on visuals, and join Cinema live events and polls when available.',
  },
];

export default function AboutAppScreen() {
  return (
    <View style={styles.root}>
      <LinearGradient
        colors={['#05060A', '#080D16', '#06070A']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.bg}
      />

      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={18} color="#fff" />
        </Pressable>
        <Text style={styles.headerTitle}>About App</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.heroCard}>
          <Text style={styles.heroTitle}>Movie Rec</Text>
          <Text style={styles.heroText}>
            Built to make discovery personal, clean and fast.
          </Text>
        </View>

        {ABOUT_SECTIONS.map((item) => (
          <View key={item.title} style={styles.sectionCard}>
            <Text style={styles.sectionIcon}>{item.icon}</Text>
            <View style={styles.sectionBody}>
              <Text style={styles.sectionTitle}>{item.title}</Text>
              <Text style={styles.sectionText}>{item.description}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#05070C',
  },
  bg: {
    ...StyleSheet.absoluteFillObject,
  },
  header: {
    paddingTop: 58,
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.two,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.26)',
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 15,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  headerSpacer: {
    width: 38,
    height: 38,
  },
  content: {
    paddingHorizontal: Spacing.three,
    paddingBottom: 120,
    gap: 12,
  },
  heroCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    backgroundColor: 'rgba(14,18,28,0.8)',
    padding: Spacing.three,
  },
  heroTitle: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 28,
    lineHeight: 32,
  },
  heroText: {
    marginTop: 8,
    color: 'rgba(255,255,255,0.82)',
    fontFamily: Fonts.mono,
    fontSize: 12,
    lineHeight: 18,
  },
  sectionCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(11,14,21,0.78)',
    padding: Spacing.two,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  sectionIcon: {
    fontSize: 22,
    lineHeight: 24,
  },
  sectionBody: {
    flex: 1,
  },
  sectionTitle: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  sectionText: {
    marginTop: 6,
    color: 'rgba(255,255,255,0.8)',
    fontFamily: Fonts.serif,
    fontSize: 13,
    lineHeight: 18,
  },
});
