import React, { useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { GlassView } from '@/components/glass-view';
import { router } from 'expo-router';

import { useAuth } from '@/contexts/AuthContext';
import { Fonts, Spacing } from '@/constants/theme';

const NICKNAME_RE = /^[a-zA-Z0-9._-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const now = new Date();
const currentYear = now.getUTCFullYear();
const YEARS = Array.from({ length: 90 }, (_, i) => String(currentYear - i));
const MONTHS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0'));
const DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0'));

const ITEM_HEIGHT = 40;
const VISIBLE_ITEMS = 5;
const WHEEL_HEIGHT = ITEM_HEIGHT * VISIBLE_ITEMS;

function isValidDateString(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === value;
}

type WheelProps = {
  data: string[];
  value: string;
  onChange: (v: string) => void;
};

function WheelPicker({ data, value, onChange }: WheelProps) {
  const scrollY = useRef(new Animated.Value(0)).current;
  const listRef = useRef<Animated.FlatList<string>>(null);

  const selectedIndex = Math.max(0, data.indexOf(value));

  React.useEffect(() => {
    const offset = selectedIndex * ITEM_HEIGHT;
    listRef.current?.scrollToOffset({ offset, animated: false });
  }, [selectedIndex]);

  return (
    <View style={styles.wheelWrap}>
      <Animated.FlatList
        ref={listRef}
        data={data}
        keyExtractor={(item) => item}
        showsVerticalScrollIndicator={false}
        snapToInterval={ITEM_HEIGHT}
        decelerationRate="fast"
        bounces={false}
        onMomentumScrollEnd={(e) => {
          const idx = Math.round(e.nativeEvent.contentOffset.y / ITEM_HEIGHT);
          onChange(data[idx] ?? data[0]);
        }}
        onScroll={Animated.event(
          [{ nativeEvent: { contentOffset: { y: scrollY } } }],
          { useNativeDriver: true }
        )}
        scrollEventThrottle={16}
        contentContainerStyle={styles.wheelContent}
        getItemLayout={(_, index) => ({
          length: ITEM_HEIGHT,
          offset: ITEM_HEIGHT * index,
          index,
        })}
        renderItem={({ item, index }) => {
          const inputRange = [
            (index - 2) * ITEM_HEIGHT,
            (index - 1) * ITEM_HEIGHT,
            index * ITEM_HEIGHT,
            (index + 1) * ITEM_HEIGHT,
            (index + 2) * ITEM_HEIGHT,
          ];

          const opacity = scrollY.interpolate({
            inputRange,
            outputRange: [0.2, 0.5, 1, 0.5, 0.2],
            extrapolate: 'clamp',
          });

          const scale = scrollY.interpolate({
            inputRange,
            outputRange: [0.9, 0.95, 1.05, 0.95, 0.9],
            extrapolate: 'clamp',
          });

          return (
            <Animated.View style={[styles.wheelItem, { opacity, transform: [{ scale }] }]}> 
              <Text style={styles.wheelText}>{item}</Text>
            </Animated.View>
          );
        }}
      />
      <View style={styles.wheelHighlight} />
    </View>
  );
}

export default function RegisterScreen() {
  const { register, error, clearError, checkNicknameAvailability } = useAuth();

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [nickname, setNickname] = useState('');
  const [email, setEmail] = useState('');
  const [birthYear, setBirthYear] = useState(String(currentYear - 20));
  const [birthMonth, setBirthMonth] = useState('01');
  const [birthDay, setBirthDay] = useState('01');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [dobVisible, setDobVisible] = useState(false);
  const [nicknameStatus, setNicknameStatus] = useState<
    'idle' | 'invalid' | 'checking' | 'available' | 'taken'
  >('idle');
  const nicknameStatusOpacity = useMemo(() => new Animated.Value(0), []);

  const opacity = useMemo(() => new Animated.Value(0), []);
  const translateY = useMemo(() => new Animated.Value(14), []);

  React.useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 420,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 520,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [opacity, translateY]);

  const birthDate = `${birthYear}-${birthMonth}-${birthDay}`;

  React.useEffect(() => {
    if (step !== 1) {
      setNicknameStatus('idle');
      return;
    }

    const clean = nickname.trim();
    if (!clean) {
      setNicknameStatus('idle');
      return;
    }

    if (clean.length < 3 || clean.length > 20 || !NICKNAME_RE.test(clean)) {
      setNicknameStatus('invalid');
      return;
    }

    let active = true;
    setNicknameStatus('checking');
    const timer = setTimeout(async () => {
      try {
        const available = await checkNicknameAvailability(clean);
        if (!active) return;
        setNicknameStatus(available ? 'available' : 'taken');
      } catch {
        if (!active) return;
        setNicknameStatus('idle');
      }
    }, 280);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [checkNicknameAvailability, nickname, step]);

  React.useEffect(() => {
    if (nicknameStatus === 'idle') {
      Animated.timing(nicknameStatusOpacity, {
        toValue: 0,
        duration: 120,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return;
    }

    nicknameStatusOpacity.setValue(0);
    Animated.timing(nicknameStatusOpacity, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [nicknameStatus, nicknameStatusOpacity]);

  const nicknameStatusMeta = useMemo(() => {
    switch (nicknameStatus) {
      case 'checking':
        return {
          text: 'Checking availability...',
          style: styles.nicknameChecking,
        };
      case 'available':
        return {
          text: 'Nickname available.',
          style: styles.nicknameAvailable,
        };
      case 'taken':
        return {
          text: 'Nickname already used.',
          style: styles.nicknameTaken,
        };
      case 'invalid':
        return {
          text: '3-20 characters, letters/numbers and . _ - only',
          style: styles.nicknameTaken,
        };
      default:
        return null;
    }
  }, [nicknameStatus]);

  const validateStep = () => {
    if (step === 0 && !name.trim()) return 'Name is required.';
    if (step === 1) {
      const clean = nickname.trim();
      if (!clean) return 'Nickname is required.';
      if (clean.length < 3 || clean.length > 20) return 'Nickname must be 3-20 characters.';
      if (!NICKNAME_RE.test(clean)) return 'Nickname can contain only letters, numbers, ".", "_" or "-".';
    }
    if (step === 2) {
      const cleanEmail = email.trim();
      if (cleanEmail && !EMAIL_RE.test(cleanEmail)) return 'Email invalid.';
    }
    if (step === 3 && !isValidDateString(birthDate)) return 'Invalid birth date.';
    if (step === 4) {
      if (!password || password.length < 8) return 'Password must be at least 8 characters.';
      if (password !== confirm) return 'Passwords do not match.';
    }
    return null;
  };

  const nextStep = async () => {
    const msg = validateStep();
    if (msg) {
      setLocalError(msg);
      return;
    }

    if (step === 1) {
      const available = await checkNicknameAvailability(nickname.trim());
      if (!available) {
        setLocalError('Nickname already used.');
        setNicknameStatus('taken');
        return;
      }
      setNicknameStatus('available');
    }

    setLocalError(null);
    setStep((prev) => Math.min(prev + 1, 4));
  };

  const prevStep = () => {
    setLocalError(null);
    setStep((prev) => Math.max(prev - 1, 0));
  };

  const onRegister = async () => {
    const msg = validateStep();
    if (msg) {
      setLocalError(msg);
      return;
    }

    try {
      await register({
        name,
        nickname,
        email,
        dateOfBirth: birthDate,
        password,
      });
      router.replace('/onboarding-watched');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Registration error.';
      setLocalError(message);
    }
  };

  return (
    <View style={styles.root}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Animated.View style={[styles.cardWrap, { opacity, transform: [{ translateY }] }]}> 
          <GlassView intensity={24} tint="dark" style={styles.card}>
            <Text style={styles.title}>Sign up</Text>
            <Text style={styles.subtitle}>Step {step + 1} of 5</Text>

            <View style={styles.progressRow}>
              {Array.from({ length: 5 }).map((_, i) => (
                <View key={i} style={[styles.dot, i <= step && styles.dotActive]} />
              ))}
            </View>

            <View style={styles.stepContent}>
              {step === 0 && (
                <>
                  <Text style={styles.label}>Name</Text>
                  <TextInput
                    style={styles.input}
                    value={name}
                    onChangeText={(v) => {
                      clearError();
                      setLocalError(null);
                      setName(v);
                    }}
                    placeholder="Your name"
                    placeholderTextColor="rgba(255,255,255,0.5)"
                  />
                </>
              )}

              {step === 1 && (
                <>
                  <Text style={styles.label}>Nickname</Text>
                  <TextInput
                    style={styles.input}
                    autoCapitalize="none"
                    value={nickname}
                    onChangeText={(v) => {
                      clearError();
                      setLocalError(null);
                      setNickname(v);
                    }}
                    placeholder="nickname"
                    placeholderTextColor="rgba(255,255,255,0.5)"
                  />
                  {nicknameStatusMeta ? (
                    <Animated.Text
                      style={[
                        styles.nicknameStatus,
                        nicknameStatusMeta.style,
                        { opacity: nicknameStatusOpacity },
                      ]}>
                      {nicknameStatusMeta.text}
                    </Animated.Text>
                  ) : null}
                </>
              )}

              {step === 2 && (
                <>
                  <Text style={styles.label}>Email (optional)</Text>
                  <TextInput
                    style={styles.input}
                    autoCapitalize="none"
                    value={email}
                    onChangeText={(v) => {
                      clearError();
                      setLocalError(null);
                      setEmail(v);
                    }}
                    placeholder="email"
                    placeholderTextColor="rgba(255,255,255,0.5)"
                  />
                </>
              )}

              {step === 3 && (
                <>
                  <Text style={styles.label}>Date of birth</Text>
                  <Pressable onPress={() => setDobVisible(true)} style={styles.dobButton}>
                    <Text style={styles.dobText}>{birthDay}.{birthMonth}.{birthYear}</Text>
                    <Text style={styles.dobHint}>Select</Text>
                  </Pressable>
                </>
              )}

              {step === 4 && (
                <>
                  <Text style={styles.label}>Password</Text>
                  <TextInput
                    style={styles.input}
                    secureTextEntry
                    value={password}
                    onChangeText={(v) => {
                      clearError();
                      setLocalError(null);
                      setPassword(v);
                    }}
                    placeholder="••••••••"
                    placeholderTextColor="rgba(255,255,255,0.5)"
                  />

                  <Text style={styles.label}>Confirm password</Text>
                  <TextInput
                    style={styles.input}
                    secureTextEntry
                    value={confirm}
                    onChangeText={(v) => {
                      clearError();
                      setLocalError(null);
                      setConfirm(v);
                    }}
                    placeholder="••••••••"
                    placeholderTextColor="rgba(255,255,255,0.5)"
                  />
                </>
              )}
            </View>

            {localError ? <Text style={styles.error}>{localError}</Text> : null}
            {!localError && error ? <Text style={styles.error}>{error}</Text> : null}

            <View style={styles.navRow}>
              <Pressable onPress={prevStep} style={[styles.navBtn, step === 0 && styles.navBtnDisabled]}>
                <Text style={styles.navText}>‹</Text>
              </Pressable>
              {step < 4 ? (
                <Pressable onPress={nextStep} style={styles.primaryBtn}>
                  <Text style={styles.primaryBtnText}>›</Text>
                </Pressable>
              ) : (
                <Pressable onPress={onRegister} style={styles.primaryBtn}>
                  <Text style={styles.primaryBtnText}>Sign up</Text>
                </Pressable>
              )}
            </View>

            <Pressable onPress={() => router.push('/login')} style={styles.linkBtn}>
              <Text style={styles.linkText}>Already have an account? Sign in</Text>
            </Pressable>
          </GlassView>
        </Animated.View>
      </KeyboardAvoidingView>

      {dobVisible ? (
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Select your date of birth</Text>
            <View style={styles.modalWheelRow}>
              <WheelPicker data={MONTHS} value={birthMonth} onChange={setBirthMonth} />
              <WheelPicker data={DAYS} value={birthDay} onChange={setBirthDay} />
              <WheelPicker data={YEARS} value={birthYear} onChange={setBirthYear} />
            </View>
            <Pressable onPress={() => setDobVisible(false)} style={styles.modalConfirm}>
              <Text style={styles.modalConfirmText}>Confirm</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000000',
  },
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: Spacing.four,
  },
  cardWrap: {
    borderRadius: Spacing.four,
    overflow: 'hidden',
  },
  card: {
    padding: Spacing.four,
    borderRadius: Spacing.four,
    backgroundColor: 'rgba(20,20,20,0.5)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  title: {
    fontSize: 28,
    fontFamily: Fonts.serif,
    marginBottom: Spacing.one,
    color: '#fff',
  },
  subtitle: {
    fontFamily: Fonts.serif,
    color: 'rgba(255,255,255,0.7)',
    marginBottom: Spacing.two,
  },
  progressRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: Spacing.three,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  dotActive: {
    backgroundColor: '#C1121F',
  },
  stepContent: {
    minHeight: 160,
  },
  label: {
    fontFamily: Fonts.mono,
    fontSize: 12,
    marginBottom: Spacing.one,
    color: 'rgba(255,255,255,0.7)',
  },
  input: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    marginBottom: Spacing.three,
    fontFamily: Fonts.serif,
    color: '#fff',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  dobButton: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: Spacing.two,
    paddingVertical: Spacing.three,
    paddingHorizontal: Spacing.three,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  dobText: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 16,
  },
  dobHint: {
    color: 'rgba(255,255,255,0.6)',
    fontFamily: Fonts.mono,
    fontSize: 11,
    marginTop: Spacing.one,
  },
  error: {
    color: '#ffb4b4',
    marginBottom: Spacing.three,
    fontFamily: Fonts.mono,
  },
  nicknameStatus: {
    marginTop: -8,
    marginBottom: Spacing.two,
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  nicknameChecking: {
    color: 'rgba(255,255,255,0.65)',
  },
  nicknameAvailable: {
    color: '#8AF5B1',
  },
  nicknameTaken: {
    color: '#ffb4b4',
  },
  navRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  navBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    borderRadius: Spacing.two,
    alignItems: 'center',
    paddingVertical: Spacing.two,
  },
  navBtnDisabled: {
    opacity: 0.4,
  },
  navText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 18,
  },
  primaryBtn: {
    flex: 2,
    backgroundColor: '#C1121F',
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#fff',
    fontFamily: Fonts.mono,
  },
  linkBtn: {
    marginTop: Spacing.three,
    alignItems: 'center',
  },
  linkText: {
    fontFamily: Fonts.mono,
    color: 'rgba(255,255,255,0.7)',
  },
  modalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: Spacing.four,
  },
  modalCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#fff',
    borderRadius: Spacing.four,
    padding: Spacing.four,
  },
  modalTitle: {
    fontFamily: Fonts.serif,
    fontSize: 18,
    color: '#222',
    textAlign: 'center',
    marginBottom: Spacing.three,
  },
  modalWheelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  wheelWrap: {
    flex: 1,
    height: WHEEL_HEIGHT,
    overflow: 'hidden',
  },
  wheelContent: {
    paddingVertical: (WHEEL_HEIGHT - ITEM_HEIGHT) / 2,
  },
  wheelItem: {
    height: ITEM_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
  },
  wheelText: {
    fontFamily: Fonts.serif,
    fontSize: 16,
    color: '#222',
  },
  wheelHighlight: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: (WHEEL_HEIGHT - ITEM_HEIGHT) / 2,
    height: ITEM_HEIGHT,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: 'rgba(0,0,0,0.08)',
  },
  modalConfirm: {
    marginTop: Spacing.three,
    backgroundColor: '#111',
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
    alignItems: 'center',
  },
  modalConfirmText: {
    color: '#fff',
    fontFamily: Fonts.mono,
  },
});
