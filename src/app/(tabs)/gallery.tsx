import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Image as ExpoImage } from 'expo-image';
import {
  Alert,
  Animated,
  Image as RNImage,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Fonts, Spacing } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import {
  addGalleryComment,
  deleteGalleryItem,
  getGalleryComments,
  getGalleryItems,
  type GalleryComment,
  type GalleryDetails,
  type GalleryFeedItem,
  toggleGalleryFavorite,
  toggleGalleryLike,
} from '@/db/gallery';
import { useTheme } from '@/hooks/use-theme';
import { backendDeleteCloudinaryImage, hasBackendApi } from '@/lib/cinema-backend';

function normalizeCardHeight(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 240;
  return Math.max(160, Math.min(620, Math.round(parsed)));
}

function detailsPairs(details: GalleryDetails) {
  return Object.entries(details).filter(([key, value]) => key.trim() && String(value).trim());
}

function parseAspectRatioFromText(value?: string | null): number | null {
  if (!value) return null;
  const m = value.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function getItemAspectFallback(item: GalleryFeedItem): number {
  const fromDetails = parseAspectRatioFromText(item.details?.['ASPECT RATIO']);
  if (fromDetails) return fromDetails;
  return 4 / 3;
}

function splitColumns<T>(items: T[], count: number) {
  const cols: T[][] = Array.from({ length: count }, () => []);
  items.forEach((item, index) => {
    cols[index % count].push(item);
  });
  return cols;
}

function formatCommentTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function GalleryScreen() {
  const theme = useTheme();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ open?: string }>();
  const userId = user?.id ?? 0;
  const isAdmin = user?.role === 'admin';
  const { width } = useWindowDimensions();

  const [query, setQuery] = useState('');
  const [items, setItems] = useState<GalleryFeedItem[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [comments, setComments] = useState<GalleryComment[]>([]);
  const [commentInput, setCommentInput] = useState('');
  const [replyTo, setReplyTo] = useState<GalleryComment | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [selectedAspectRatio, setSelectedAspectRatio] = useState<number>(4 / 3);
  const modalOpacity = useState(() => new Animated.Value(0))[0];
  const modalTranslateY = useState(() => new Animated.Value(16))[0];

  const refresh = async (search = query) => {
    try {
      const next = await getGalleryItems({ userId, query: search });
      setItems(next);
      setError(null);
    } catch {
      setError('Could not load gallery.');
    } finally {
      setReady(true);
    }
  };

  useEffect(() => {
    const openId = String(params.open ?? '').trim();
    if (!openId) return;
    if (!items.length) return;
    const exists = items.some((x) => x.id === openId);
    if (exists) setSelectedId(openId);
  }, [items, params.open]);

  useEffect(() => {
    setReady(false);
    void refresh('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      void refresh(query);
    }, 320);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, userId]);

  const selectedItem = useMemo(() => items.find((x) => x.id === selectedId) ?? null, [items, selectedId]);

  useEffect(() => {
    if (!selectedItem) return;
    modalOpacity.setValue(0);
    modalTranslateY.setValue(16);
    Animated.parallel([
      Animated.timing(modalOpacity, {
        toValue: 1,
        duration: 240,
        useNativeDriver: true,
      }),
      Animated.timing(modalTranslateY, {
        toValue: 0,
        duration: 260,
        useNativeDriver: true,
      }),
    ]).start();
  }, [modalOpacity, modalTranslateY, selectedItem]);

  useEffect(() => {
    if (!selectedItem) return;
    const fallback = getItemAspectFallback(selectedItem);
    setSelectedAspectRatio(fallback);
    let active = true;
    RNImage.getSize(
      selectedItem.image,
      (w, h) => {
        if (!active || !w || !h) return;
        setSelectedAspectRatio(w / h);
      },
      () => {
        if (!active) return;
        setSelectedAspectRatio(fallback);
      }
    );
    return () => {
      active = false;
    };
  }, [selectedItem]);

  useEffect(() => {
    const id = Number(selectedId ?? 0);
    if (!id) {
      setComments([]);
      setReplyTo(null);
      return;
    }
    void getGalleryComments(id).then(setComments).catch(() => setComments([]));
  }, [selectedId]);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (event) => {
      setKeyboardHeight(event.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const columnWidth = Math.max(130, (width - Spacing.four * 2 - Spacing.two) / 2);
  const columns = useMemo(() => {
    const left: GalleryFeedItem[] = [];
    const right: GalleryFeedItem[] = [];
    let leftHeight = 0;
    let rightHeight = 0;
    items.forEach((item) => {
      const h = normalizeCardHeight(item.height);
      if (leftHeight <= rightHeight) {
        left.push(item);
        leftHeight += h;
      } else {
        right.push(item);
        rightHeight += h;
      }
    });
    return { left, right };
  }, [items]);

  const detailData = useMemo(() => {
    if (!selectedItem) return { tags: '', groups: [[], []] as [string, string][][] };
    const pairs = detailsPairs(selectedItem.details);
    const tags = pairs.find(([k]) => k.toUpperCase() === 'TAGS')?.[1] ?? '';
    const rest = pairs.filter(([k]) => k.toUpperCase() !== 'TAGS');
    const colCount = width > 900 ? 3 : 2;
    return { tags, groups: splitColumns(rest, colCount) };
  }, [selectedItem, width]);

  const rootComments = useMemo(
    () =>
      comments
        .filter((c) => !c.parentId)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [comments]
  );
  const repliesByParent = useMemo(
    () =>
      comments.reduce<Record<number, GalleryComment[]>>((acc, c) => {
        if (!c.parentId) return acc;
        acc[c.parentId] = acc[c.parentId] ?? [];
        acc[c.parentId].push(c);
        acc[c.parentId].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        return acc;
      }, {}),
    [comments]
  );

  const onDelete = (id: string) => {
    if (!isAdmin) return;
    const doDelete = async () => {
      try {
        if (hasBackendApi() && /^https?:\/\/res\.cloudinary\.com\//i.test(id === selectedId ? (selectedItem?.image ?? '') : (items.find((x) => x.id === id)?.image ?? ''))) {
          const imageUrl = id === selectedId
            ? selectedItem?.image
            : items.find((x) => x.id === id)?.image;
          if (imageUrl) {
            try {
              await backendDeleteCloudinaryImage(imageUrl);
            } catch {
              // Keep local delete flow even if Cloudinary delete fails.
            }
          }
        }
        await deleteGalleryItem(id);
        if (selectedId === id) setSelectedId(null);
        setItems((prev) => prev.filter((item) => item.id !== id));
      } catch {
        setError('Delete failed.');
      }
    };

    if (Platform.OS === 'web') {
      const ok = typeof window !== 'undefined'
        ? window.confirm('Delete frame? This action cannot be undone.')
        : false;
      if (ok) {
        void doDelete();
      }
      return;
    }

    Alert.alert('Delete frame?', 'This action cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void doDelete();
        },
      },
    ]);
  };

  const onDeleteSelected = () => {
    if (!selectedItem) return;
    onDelete(selectedItem.id);
  };

  const onToggleLike = async () => {
    if (!selectedItem || !userId) return;
    try {
      const nextLiked = await toggleGalleryLike(userId, Number(selectedItem.id));
      setItems((prev) =>
        prev.map((item) => {
          if (item.id !== selectedItem.id) return item;
          return {
            ...item,
            likedByMe: nextLiked,
            likesCount: Math.max(0, item.likesCount + (nextLiked ? 1 : -1)),
          };
        })
      );
    } catch {
      setError('Like failed.');
    }
  };

  const onToggleFavorite = async () => {
    if (!selectedItem || !userId) return;
    try {
      const nextFavorited = await toggleGalleryFavorite(userId, Number(selectedItem.id));
      setItems((prev) =>
        prev.map((item) => {
          if (item.id !== selectedItem.id) return item;
          return {
            ...item,
            favoritedByMe: nextFavorited,
          };
        })
      );
    } catch {
      setError('Save failed.');
    }
  };

  const onSendComment = async () => {
    if (!selectedItem || !userId) return;
    const text = commentInput.trim();
    if (!text) return;
    try {
      await addGalleryComment(userId, Number(selectedItem.id), text, replyTo?.id ?? null);
      setCommentInput('');
      setReplyTo(null);
      const nextComments = await getGalleryComments(Number(selectedItem.id));
      setComments(nextComments);
      setItems((prev) =>
        prev.map((item) =>
          item.id === selectedItem.id
            ? {
                ...item,
                commentsCount: item.commentsCount + 1,
              }
            : item
        )
      );
    } catch {
      setError('Comment failed.');
    }
  };

  const openUserProfileFromModal = (targetUserId: number) => {
    Keyboard.dismiss();
    setSelectedId(null);
    setTimeout(() => {
      router.push(`/user/${targetUserId}` as any);
    }, 0);
  };

  const estimatedKeyboardHeight = Platform.OS === 'ios' ? 320 : 280;
  const primeKeyboardOffset = useCallback(() => {
    // Android does not emit keyboardWillShow, so we pre-shift on focus.
    setKeyboardHeight((prev) => (prev > 0 ? prev : estimatedKeyboardHeight));
  }, [estimatedKeyboardHeight]);

  const commentsKeyboardOffset = Math.max(0, keyboardHeight - insets.bottom);
  const commentsComposerBottom = Math.max(insets.bottom + 10, 14);

  return (
    <View style={[styles.root, { backgroundColor: theme.background }]}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.container}>
        <Text style={[styles.title, { color: theme.text }]}>Gallery</Text>

        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search title, tag, details..."
          placeholderTextColor={theme.textSecondary}
          style={[styles.search, { color: theme.text }]}
        />

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {!ready ? <Text style={styles.hint}>Loading...</Text> : null}

        <View style={styles.columns}>
          <View style={styles.column}>
            {columns.left.map((item) => (
              <GalleryCard
                key={item.id}
                item={item}
                columnWidth={columnWidth}
                onPress={() => setSelectedId(item.id)}
              />
            ))}
          </View>
          <View style={styles.column}>
            {columns.right.map((item) => (
              <GalleryCard
                key={item.id}
                item={item}
                columnWidth={columnWidth}
                onPress={() => setSelectedId(item.id)}
              />
            ))}
          </View>
        </View>
      </ScrollView>

      <Modal
        visible={!!selectedItem}
        animationType="slide"
        onRequestClose={() => {
          Keyboard.dismiss();
          setSelectedId(null);
        }}>
        <Animated.View
          style={[
            styles.modalRoot,
            {
              opacity: modalOpacity,
              transform: [{ translateY: modalTranslateY }],
            },
          ]}>
          <View style={styles.modalTop}>
            <Text style={styles.modalTitle} numberOfLines={2} ellipsizeMode="tail">
              {selectedItem?.titleHeader || selectedItem?.title || 'Frame'}
            </Text>
            <Pressable
              onPress={() => {
                Keyboard.dismiss();
                setSelectedId(null);
              }}
              style={styles.closeBtn}>
              <Text style={styles.closeText}>X</Text>
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={styles.modalContent}
            showsVerticalScrollIndicator={false}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled">
            {selectedItem ? (
              <ExpoImage
                source={{ uri: selectedItem.image }}
                style={[styles.heroImage, { aspectRatio: selectedAspectRatio }]}
                contentFit="contain"
                transition={120}
                cachePolicy="memory-disk"
              />
            ) : null}

            {selectedItem?.paletteHex?.length ? (
              <View style={styles.paletteContainer}>
                {selectedItem.paletteHex.map((hex, idx) => (
                  <View key={`${hex}-${idx}`} style={[styles.paletteSwatch, { backgroundColor: hex }]} />
                ))}
              </View>
            ) : null}

            <View style={styles.modalActions}>
              <Pressable onPress={onToggleLike} style={styles.actionBtn}>
                <Ionicons
                  name={selectedItem?.likedByMe ? 'heart' : 'heart-outline'}
                  size={17}
                  color={selectedItem?.likedByMe ? '#EF4444' : '#FFFFFF'}
                />
                <Text style={styles.actionText}>{selectedItem?.likesCount ?? 0}</Text>
              </Pressable>
              <Pressable onPress={onToggleFavorite} style={styles.actionBtn}>
                <Ionicons
                  name={selectedItem?.favoritedByMe ? 'bookmark' : 'bookmark-outline'}
                  size={17}
                  color={selectedItem?.favoritedByMe ? '#FBBF24' : '#FFFFFF'}
                />
                <Text style={styles.actionText}>{selectedItem?.favoritedByMe ? 'Saved' : 'Save'}</Text>
              </Pressable>
              {isAdmin ? (
                <Pressable onPress={onDeleteSelected} style={styles.actionBtnDanger}>
                  <Ionicons name="trash-outline" size={17} color="#F87171" />
                  <Text style={styles.actionTextDanger}>Delete</Text>
                </Pressable>
              ) : null}
            </View>

            {!!detailData.tags && (
              <View style={styles.tagsBlock}>
                <Text style={styles.tagsLabel}>TAGS</Text>
                <Text style={styles.tagsValue}>{detailData.tags}</Text>
              </View>
            )}

            <View style={styles.detailsGrid}>
              {detailData.groups.map((group, gi) => (
                <View key={`group-${gi}`} style={styles.detailCol}>
                  {group.map(([key, value]) => (
                    <View key={`${gi}-${key}`} style={styles.detailRow}>
                      <Text style={styles.detailKey}>{key}</Text>
                      <Text style={styles.detailValue}>{value}</Text>
                    </View>
                  ))}
                </View>
              ))}
            </View>

            <Text style={styles.commentsHeader}>COMMENTS</Text>
            <View style={styles.commentsList}>
              {rootComments.map((comment) => (
                <View key={comment.id} style={styles.commentCard}>
                  <Pressable onPress={() => openUserProfileFromModal(comment.userId)}>
                    {comment.avatarUrl ? (
                      <ExpoImage
                        source={{ uri: comment.avatarUrl }}
                        style={styles.commentAvatar}
                        contentFit="cover"
                        transition={80}
                        cachePolicy="memory-disk"
                      />
                    ) : (
                      <View style={styles.commentAvatarFallback}>
                        <Text style={styles.commentAvatarText}>?</Text>
                      </View>
                    )}
                  </Pressable>
                  <View style={styles.commentBody}>
                    <View style={styles.commentMeta}>
                      <Pressable onPress={() => openUserProfileFromModal(comment.userId)}>
                        <Text style={styles.commentNickname}>{comment.nickname}</Text>
                      </Pressable>
                      <Text style={styles.commentTime}>{formatCommentTime(comment.createdAt)}</Text>
                    </View>
                    <Text style={styles.commentText}>{comment.text}</Text>
                    <Pressable onPress={() => setReplyTo(comment)}>
                      <Text style={styles.replyBtn}>Reply</Text>
                    </Pressable>
                    {(repliesByParent[comment.id] ?? []).map((reply) => (
                      <View key={reply.id} style={styles.replyCard}>
                        <Pressable onPress={() => openUserProfileFromModal(reply.userId)}>
                          {reply.avatarUrl ? (
                            <ExpoImage
                              source={{ uri: reply.avatarUrl }}
                              style={styles.replyAvatar}
                              contentFit="cover"
                              transition={80}
                              cachePolicy="memory-disk"
                            />
                          ) : (
                            <View style={styles.replyAvatarFallback}>
                              <Text style={styles.replyAvatarFallbackText}>?</Text>
                            </View>
                          )}
                        </Pressable>
                        <View style={styles.replyBody}>
                          <View style={styles.commentMeta}>
                            <Pressable onPress={() => openUserProfileFromModal(reply.userId)}>
                              <Text style={styles.commentNickname}>{reply.nickname}</Text>
                            </Pressable>
                            <Text style={styles.commentTime}>{formatCommentTime(reply.createdAt)}</Text>
                          </View>
                          <Text style={styles.commentText}>{reply.text}</Text>
                        </View>
                      </View>
                    ))}
                  </View>
                </View>
              ))}
            </View>
          </ScrollView>
          <View
            style={[
              styles.commentComposer,
              {
                paddingBottom: commentsComposerBottom,
                transform: [{ translateY: -commentsKeyboardOffset }],
              },
            ]}>
            {replyTo ? (
              <View style={styles.replyingRow}>
                <Text style={styles.replyingText}>Replying to @{replyTo.nickname}</Text>
                <Pressable onPress={() => setReplyTo(null)}>
                  <Text style={styles.replyCancel}>Cancel</Text>
                </Pressable>
              </View>
            ) : null}
            <View style={styles.commentRow}>
              <TextInput
                value={commentInput}
                onChangeText={setCommentInput}
                placeholder="Write a comment..."
                placeholderTextColor="rgba(255,255,255,0.55)"
                onFocus={primeKeyboardOffset}
                returnKeyType="send"
                onSubmitEditing={onSendComment}
                blurOnSubmit={false}
                style={styles.commentInput}
              />
              <Pressable onPress={onSendComment} style={styles.sendBtn}>
                <Text style={styles.sendText}>Send</Text>
              </Pressable>
            </View>
          </View>
        </Animated.View>
      </Modal>
    </View>
  );
}

function GalleryCard({
  item,
  columnWidth,
  onPress,
}: {
  item: GalleryFeedItem;
  columnWidth: number;
  onPress: () => void;
}) {
  const backupImage = useMemo(() => {
    const label = encodeURIComponent(String(item.title || 'Movie').slice(0, 30));
    return `https://placehold.co/600x900/101010/E8E8E8/png?text=${label}`;
  }, [item.title]);
  const [imageUri, setImageUri] = useState(item.image);
  const [failed, setFailed] = useState(false);
  const aspectRatio = getItemAspectFallback(item);

  const dynamicHeight = Math.max(60, Math.round(columnWidth / aspectRatio));

  useEffect(() => {
    setImageUri(item.image);
    setFailed(false);
  }, [item.id, item.image]);

  return (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        { height: dynamicHeight },
        pressed ? styles.cardPressed : null,
      ]}
      onPress={onPress}>
      {!failed ? (
        <>
          <ExpoImage
            source={{ uri: imageUri }}
            style={styles.cardImage}
            contentFit="contain"
            transition={120}
            cachePolicy="memory-disk"
            onError={() => {
              if (imageUri !== backupImage) {
                setImageUri(backupImage);
                return;
              }
              setFailed(true);
            }}
          />
        </>
      ) : (
        <View style={styles.cardFallback}>
          <Text style={styles.cardFallbackText}>{item.title}</Text>
        </View>
      )}

    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  container: {
    padding: Spacing.four,
    paddingBottom: 120,
  },
  title: {
    fontFamily: Fonts.serif,
    fontSize: 34,
    marginBottom: Spacing.two,
  },
  search: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    fontFamily: Fonts.serif,
    marginBottom: Spacing.two,
  },
  error: {
    color: '#ff8e8e',
    fontFamily: Fonts.mono,
    fontSize: 11,
    marginBottom: Spacing.one,
  },
  hint: {
    color: 'rgba(255,255,255,0.6)',
    fontFamily: Fonts.mono,
    fontSize: 11,
    marginBottom: Spacing.two,
  },
  columns: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  column: {
    flex: 1,
  },
  card: {
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    backgroundColor: '#111',
    marginBottom: Spacing.two,
  },
  cardPressed: {
    transform: [{ scale: 0.985 }],
    opacity: 0.93,
  },
  cardImage: {
    width: '100%',
    height: '100%',
  },
  cardFallback: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.two,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  cardFallbackText: {
    color: 'rgba(255,255,255,0.75)',
    fontFamily: Fonts.serif,
    fontSize: 12,
    textAlign: 'center',
  },
  modalRoot: {
    flex: 1,
    backgroundColor: '#000',
    paddingTop: 44,
  },
  modalTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  modalTitle: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 22,
    lineHeight: 28,
    flex: 1,
    paddingRight: 10,
  },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 12,
  },
  modalContent: {
    paddingHorizontal: 14,
    paddingBottom: 184,
    gap: 12,
  },
  heroImage: {
    width: '100%',
    borderRadius: 14,
    backgroundColor: '#111',
  },
  paletteContainer: {
    flexDirection: 'row',
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  paletteSwatch: {
    flex: 1,
    minHeight: 38,
    borderRightWidth: 1,
    borderRightColor: 'rgba(255,255,255,0.18)',
  },
  modalActions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  actionBtnDanger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(248,113,113,0.45)',
    backgroundColor: 'rgba(127,29,29,0.20)',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  actionText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 12,
  },
  actionTextDanger: {
    color: '#FCA5A5',
    fontFamily: Fonts.mono,
    fontSize: 12,
  },
  tagsBlock: {
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    paddingVertical: 12,
    gap: 8,
  },
  tagsLabel: {
    color: 'rgba(255,255,255,0.68)',
    fontFamily: Fonts.mono,
    fontSize: 11,
    letterSpacing: 0.7,
  },
  tagsValue: {
    color: 'rgba(255,255,255,0.96)',
    fontFamily: Fonts.serif,
    fontSize: 15,
    lineHeight: 24,
  },
  detailsGrid: {
    flexDirection: 'row',
    gap: 14,
    borderBottomWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    paddingTop: 6,
    paddingBottom: 12,
  },
  detailCol: {
    flex: 1,
    gap: 12,
  },
  detailRow: {
    gap: 5,
    borderLeftWidth: 1,
    borderLeftColor: 'rgba(255,255,255,0.08)',
    paddingLeft: 8,
  },
  detailKey: {
    color: 'rgba(255,255,255,0.62)',
    fontFamily: Fonts.mono,
    fontSize: 11,
    letterSpacing: 0.6,
  },
  detailValue: {
    color: 'rgba(255,255,255,0.98)',
    fontFamily: Fonts.serif,
    fontSize: 15,
    lineHeight: 22,
  },
  commentsHeader: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 16,
  },
  replyingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  replyingText: {
    color: 'rgba(255,255,255,0.8)',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  replyCancel: {
    color: '#FCA5A5',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  commentRow: {
    flexDirection: 'row',
    gap: 8,
  },
  commentComposer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 14,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.12)',
    backgroundColor: '#000',
    gap: 6,
  },
  commentInput: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    color: '#fff',
    fontFamily: Fonts.serif,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  sendBtn: {
    borderRadius: 10,
    backgroundColor: '#C1121F',
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  sendText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  commentsList: {
    gap: 8,
  },
  commentCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    padding: 8,
    flexDirection: 'row',
    gap: 8,
  },
  commentAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  commentAvatarFallback: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#2A2A2A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  commentAvatarText: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 16,
    lineHeight: 18,
  },
  commentBody: {
    flex: 1,
  },
  commentMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  commentNickname: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  commentTime: {
    color: 'rgba(255,255,255,0.58)',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  commentText: {
    color: 'rgba(255,255,255,0.9)',
    fontFamily: Fonts.serif,
    fontSize: 13,
    marginTop: 2,
    lineHeight: 18,
  },
  replyBtn: {
    marginTop: 4,
    color: 'rgba(255,255,255,0.75)',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  replyCard: {
    marginTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
    paddingTop: 8,
    flexDirection: 'row',
    gap: 8,
  },
  replyAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  replyAvatarFallback: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#2A2A2A',
    alignItems: 'center',
    justifyContent: 'center',
  },
  replyAvatarFallbackText: {
    color: '#fff',
    fontFamily: Fonts.serif,
    fontSize: 11,
    lineHeight: 12,
  },
  replyBody: {
    flex: 1,
  },
});
