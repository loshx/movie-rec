import React, { useMemo, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Image,
} from 'react-native';

import { router } from 'expo-router';
import { GlassView } from '@/components/glass-view';
import { useAuth } from '@/contexts/AuthContext';
import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { syncCommentAvatarsForUser } from '@/db/user-movies';
import { syncGalleryCommentAvatarsForUser } from '@/db/gallery';

const NICKNAME_RE = /^[a-zA-Z0-9._-]+$/;

function isValidAvatarUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return /^(https?:\/\/|file:\/\/|content:\/\/|ph:\/\/|data:image\/|blob:)/i.test(trimmed);
}

export default function ProfileEditScreen() {
  const { user, updateProfile } = useAuth();
  const theme = useTheme();

  const [name, setName] = useState(user?.name ?? '');
  const [nickname, setNickname] = useState(user?.nickname ?? '');
  const [bio, setBio] = useState((user as any)?.bio ?? '');
  const [avatarUrl, setAvatarUrl] = useState((user as any)?.avatar_url ?? '');
  const [message, setMessage] = useState<string | null>(null);

  const imageUrl = (avatarUrl || (user as any)?.avatar_url || '').trim();
  const hasAvatar = !!imageUrl;
  const title = useMemo(() => {
    const base = name.trim();
    return base.length ? base : 'Edit profile';
  }, [name]);

  const onPickAvatar = async () => {
    setMessage(null);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (permission.status !== 'granted') {
        setMessage('Gallery permission is required.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
        base64: true,
      });

      if (!result.canceled) {
        const asset = result.assets?.[0];
        if (!asset) return;
        if (asset.base64) {
          const mime = asset.mimeType || 'image/jpeg';
          setAvatarUrl(`data:${mime};base64,${asset.base64}`);
          return;
        }
        if (asset.uri) setAvatarUrl(asset.uri);
      }
    } catch {
      setMessage('Could not open gallery.');
    }
  };

  const onSave = async () => {
    setMessage(null);
    const cleanNickname = nickname.trim();
    const cleanAvatarUrl = avatarUrl.trim();
    if (!cleanNickname) {
      setMessage('Nickname is required.');
      return;
    }
    if (cleanNickname.length < 3 || cleanNickname.length > 20) {
      setMessage('Nickname must be 3-20 characters.');
      return;
    }
    if (!NICKNAME_RE.test(cleanNickname)) {
      setMessage('Nickname can contain only letters, numbers, ".", "_" or "-".');
      return;
    }
    if (!isValidAvatarUrl(cleanAvatarUrl)) {
      setMessage('Invalid avatar. Use Select photo or a valid URL.');
      return;
    }
    try {
      await updateProfile({
        name,
        nickname: cleanNickname,
        bio,
        avatarUrl: cleanAvatarUrl,
      });
      if (user?.id) {
        await syncCommentAvatarsForUser(user.id, cleanAvatarUrl || null);
        await syncGalleryCommentAvatarsForUser(user.id, cleanAvatarUrl || null);
      }
      setMessage('Profile updated.');
      router.back();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Save failed.');
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          <GlassView
            intensity={32}
            tint={theme.mode === 'light' ? 'light' : 'dark'}
            style={styles.card}>
            <View style={styles.header}>
              <Pressable onPress={() => router.back()} style={styles.backBtn}>
                <Text style={styles.backText}>×</Text>
              </Pressable>
              <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
            </View>

            <Pressable style={styles.avatarWrap} onPress={onPickAvatar}>
              {hasAvatar ? (
                <Image source={{ uri: imageUrl }} style={styles.avatar} />
              ) : (
                <View style={styles.avatarFallback}>
                  <Text style={styles.avatarFallbackText}>?</Text>
                </View>
              )}
              <View style={styles.avatarLabel}>
                <Text style={styles.avatarLabelText}>Select photo</Text>
              </View>
            </Pressable>

            <Text style={[styles.label, { color: theme.textSecondary }]}>Name</Text>
            <TextInput
              style={[styles.input, { color: theme.text }]}
              value={name}
              onChangeText={setName}
              placeholder="Full name"
              placeholderTextColor={theme.textSecondary}
            />

            <Text style={[styles.label, { color: theme.textSecondary }]}>Nickname</Text>
            <TextInput
              style={[styles.input, { color: theme.text }]}
              value={nickname}
              onChangeText={setNickname}
              placeholder="Nickname"
              placeholderTextColor={theme.textSecondary}
              autoCapitalize="none"
            />

            <Text style={[styles.label, { color: theme.textSecondary }]}>Bio</Text>
            <TextInput
              style={[styles.input, styles.inputMultiline, { color: theme.text }]}
              value={bio}
              onChangeText={setBio}
              placeholder="Short bio"
              placeholderTextColor={theme.textSecondary}
              multiline
            />

            {message ? (
              <Text style={[styles.message, { color: theme.text }]}>{message}</Text>
            ) : null}

            <Pressable onPress={onSave} style={styles.saveBtn}>
              <Text style={styles.saveText}>Save</Text>
            </Pressable>
          </GlassView>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  scroll: {
    padding: Spacing.four,
    paddingBottom: 120,
  },
  card: {
    padding: Spacing.four,
    borderRadius: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginBottom: Spacing.three,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backText: {
    color: '#fff',
    fontSize: 20,
    lineHeight: 20,
  },
  title: {
    fontFamily: Fonts.serif,
    fontSize: 20,
  },
  avatarWrap: {
    alignSelf: 'center',
    marginBottom: Spacing.three,
  },
  avatar: {
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.35)',
  },
  avatarFallback: {
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111111',
  },
  avatarFallbackText: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 64,
    lineHeight: 70,
  },
  avatarLabel: {
    position: 'absolute',
    bottom: -6,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  avatarLabelText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 11,
    paddingHorizontal: Spacing.two,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  label: {
    fontFamily: Fonts.mono,
    fontSize: 11,
    marginBottom: Spacing.one,
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
    marginBottom: Spacing.three,
    fontFamily: Fonts.serif,
  },
  inputMultiline: {
    minHeight: 84,
    textAlignVertical: 'top',
  },
  message: {
    marginBottom: Spacing.two,
    fontFamily: Fonts.mono,
  },
  saveBtn: {
    backgroundColor: '#C1121F',
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
    alignItems: 'center',
  },
  saveText: {
    color: '#fff',
    fontFamily: Fonts.mono,
  },
});
