import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import React, { useMemo, useState } from 'react';
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

import { useAuth } from '@/contexts/AuthContext';
import { Fonts, Spacing } from '@/constants/theme';

WebBrowser.maybeCompleteAuthSession();

export default function LoginScreen() {
  const { login, loginWithAuth0, error, clearError, isReady } = useAuth();
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const extra = Constants.expoConfig?.extra as
    | {
        auth0?: {
          domain?: string;
          clientId?: string;
          audience?: string;
        };
      }
    | undefined;

  const auth0Domain = extra?.auth0?.domain;
  const auth0ClientId = extra?.auth0?.clientId;
  const auth0Audience = extra?.auth0?.audience;
  const hasAuth0Config = !!auth0Domain && !!auth0ClientId;

  const redirectUri = AuthSession.makeRedirectUri({
    scheme: 'movierec',
    path: 'login',
  });

  const discovery = useMemo(
    () =>
      auth0Domain
        ? {
            authorizationEndpoint: `https://${auth0Domain}/authorize`,
            tokenEndpoint: `https://${auth0Domain}/oauth/token`,
            userInfoEndpoint: `https://${auth0Domain}/userinfo`,
          }
        : null,
    [auth0Domain]
  );

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: auth0ClientId ?? '',
      redirectUri,
      responseType: AuthSession.ResponseType.Token,
      scopes: ['openid', 'profile', 'email'],
      extraParams: {
        connection: 'google-oauth2',
        ...(auth0Audience ? { audience: auth0Audience } : {}),
      },
    },
    discovery
  );

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

  React.useEffect(() => {
    (async () => {
      if (response?.type !== 'success') return;
      const accessToken = response.authentication?.accessToken;
      if (!accessToken || !discovery?.userInfoEndpoint) {
        setLocalError('Auth0 error.');
        return;
      }
      try {
        const userInfoRes = await fetch(discovery.userInfoEndpoint, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const profile = await userInfoRes.json();
        if (!profile?.sub) {
          setLocalError('Invalid Auth0 profile.');
          return;
        }
        await loginWithAuth0(profile);
        router.replace('/(tabs)');
      } catch {
        setLocalError('Auth0 error.');
      }
    })();
  }, [response, discovery, loginWithAuth0]);

  const onLogin = async () => {
    if (!isReady) {
      setLocalError('Preparing local database. Try again in a second.');
      return;
    }
    const cleanNickname = nickname.trim();

    if (!cleanNickname || !password) {
      setLocalError('Fill in nickname and password.');
      return;
    }

    setLocalError(null);

    try {
      await login(cleanNickname, password);
      router.replace('/(tabs)');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login error.';
      setLocalError(message);
    }
  };

  const onAuth0Login = async () => {
    if (!isReady) {
      setLocalError('Preparing local database. Try again in a second.');
      return;
    }
    if (!hasAuth0Config || !request) {
      setLocalError('Auth0 is not configured.');
      return;
    }

    setLocalError(null);

    try {
      await promptAsync();
    } catch {
      setLocalError('Auth0 error.');
    }
  };

  return (
    <View style={styles.root}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Animated.View style={[styles.cardWrap, { opacity, transform: [{ translateY }] }]}> 
          <GlassView intensity={24} tint="dark" style={styles.card}>
            <Text style={styles.title}>Sign in</Text>
            <Text style={styles.subtitle}>Sign in with nickname and password.</Text>
            {!isReady ? <Text style={styles.subtitle}>Initializing local database...</Text> : null}

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

            {localError ? <Text style={styles.error}>{localError}</Text> : null}
            {!localError && error ? <Text style={styles.error}>{error}</Text> : null}

            <Pressable onPress={onLogin} disabled={!isReady} style={[styles.primaryBtn, !isReady && styles.btnDisabled]}>
              <Text style={styles.primaryBtnText}>Sign in</Text>
            </Pressable>

            <Pressable
              onPress={onAuth0Login}
              disabled={!isReady || !hasAuth0Config || !request}
              style={[styles.auth0Btn, (!isReady || !hasAuth0Config || !request) && styles.auth0BtnDisabled]}>
              <Text style={styles.auth0BtnText}>Sign in with Google</Text>
            </Pressable>

            <Pressable onPress={() => router.push('/register')} style={styles.linkBtn}>
              <Text style={styles.linkText}>No account? Sign up</Text>
            </Pressable>
          </GlassView>
        </Animated.View>
      </KeyboardAvoidingView>
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
    marginBottom: Spacing.four,
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
  error: {
    color: '#ffb4b4',
    marginBottom: Spacing.three,
    fontFamily: Fonts.mono,
  },
  primaryBtn: {
    backgroundColor: '#C1121F',
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#fff',
    fontFamily: Fonts.mono,
  },
  btnDisabled: {
    opacity: 0.5,
  },
  auth0Btn: {
    marginTop: Spacing.two,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
    alignItems: 'center',
  },
  auth0BtnDisabled: {
    opacity: 0.5,
  },
  auth0BtnText: {
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
});
