import React, { useEffect, useMemo, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Picker } from '@react-native-picker/picker';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';

import { useAuth } from '@/contexts/AuthContext';
import { addGalleryItem, clearGalleryAll, type GalleryDetails } from '@/db/gallery';
import { createCinemaEvent, getLatestCinemaEvent } from '@/db/cinema';
import { getFeaturedMovie, setFeaturedMovie } from '@/db/featured';
import { hasCloudinaryConfig, uploadImageToCloudinary, uploadVideoToCloudinary } from '@/lib/cloudinary';
import { backendResetAllData, hasBackendApi } from '@/lib/cinema-backend';
import { setRuntimeAdminKey } from '@/lib/admin-session';
import { getMovieById, getMovieCredits } from '@/lib/tmdb';
import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type ImportEntry = {
  index?: number;
  shotid?: string;
  title_header?: string;
  image_id?: string;
  image_url?: string;
  image_file?: string;
  palette_hex?: string[];
  details?: Record<string, unknown>;
};

function roundToNextFiveMinutes(d = new Date()) {
  const date = new Date(d);
  date.setSeconds(0, 0);
  const m = date.getMinutes();
  const next = Math.ceil(m / 5) * 5;
  if (next >= 60) {
    date.setHours(date.getHours() + 1);
    date.setMinutes(0);
  } else {
    date.setMinutes(next);
  }
  return date;
}

function normalizeDurationSeconds(value?: number | null) {
  if (!Number.isFinite(Number(value))) return null;
  const raw = Number(value);
  if (raw <= 0) return null;
  if (raw > 1000) return Math.round(raw / 1000);
  return Math.round(raw);
}

function toIsoFromPicker(dayOffset: number, hour: number, minute: number) {
  const base = new Date();
  base.setSeconds(0, 0);
  base.setDate(base.getDate() + dayOffset);
  base.setHours(hour, minute, 0, 0);
  return base.toISOString();
}

function fmtShortIso(iso: string) {
  try {
    const d = new Date(iso);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day} ${hh}:${mm}`;
  } catch {
    return iso;
  }
}

function stripTrailingCommas(input: string) {
  return input.replace(/,\s*([}\]])/g, '$1');
}

function autoCloseJson(input: string) {
  let source = input;
  let braces = 0;
  let brackets = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') braces += 1;
    else if (ch === '}') braces -= 1;
    else if (ch === '[') brackets += 1;
    else if (ch === ']') brackets -= 1;
  }

  while (brackets > 0) {
    source += ']';
    brackets -= 1;
  }
  while (braces > 0) {
    source += '}';
    braces -= 1;
  }

  return source;
}

function parseJsonPayload(raw: string): ImportEntry[] {
  const base = raw.trim();
  const variants: string[] = [];
  variants.push(base);
  variants.push(stripTrailingCommas(base));

  if (!base.startsWith('{') && !base.startsWith('[')) {
    variants.push(`{${base}}`);
    variants.push(stripTrailingCommas(`{${base}}`));
  }

  const closed = autoCloseJson(base);
  variants.push(closed);
  variants.push(stripTrailingCommas(closed));

  if (!closed.startsWith('{') && !closed.startsWith('[')) {
    variants.push(`{${closed}}`);
    variants.push(stripTrailingCommas(`{${closed}}`));
  }

  let lastError: unknown = null;
  for (const candidate of variants) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed as ImportEntry[];
      if (parsed && Array.isArray((parsed as { items?: unknown[] }).items)) {
        return (parsed as { items: ImportEntry[] }).items;
      }
      return [parsed as ImportEntry];
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Invalid JSON payload.');
}

function normalizeDetails(input: unknown): GalleryDetails {
  if (!input || typeof input !== 'object') return {};
  const out: GalleryDetails = {};
  Object.entries(input as Record<string, unknown>).forEach(([key, value]) => {
    const cleanKey = String(key).trim();
    const cleanValue = String(value ?? '').trim();
    if (cleanKey && cleanValue) out[cleanKey] = cleanValue;
  });
  const rawTags = String(out.TAGS ?? '').trim();
  if (!rawTags.includes('\n')) return out;
  const lines = rawTags
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return out;
  const detailLine = /^([A-Z][A-Z0-9 /&().'_-]{1,80}):\s*(.+)$/;
  let tags = lines[0];
  let changed = false;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^SIMILAR SHOTS\b/i.test(line) || /^SEE MORE SIMILAR SHOTS\b/i.test(line)) {
      changed = true;
      continue;
    }
    const match = line.match(detailLine);
    if (match) {
      const detailKey = match[1].trim();
      const detailValue = match[2].trim();
      if (detailKey && detailValue) {
        if (!out[detailKey]) out[detailKey] = detailValue;
        changed = true;
        continue;
      }
    }
    tags = tags ? `${tags}, ${line}` : line;
    changed = true;
  }
  if (changed) out.TAGS = tags;
  return out;
}

function parsePalette(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => String(x).trim())
    .filter((x) => /^#[0-9a-fA-F]{6}$/.test(x));
}

function normalizeTag(value: string) {
  const clean = value.trim().toLowerCase();
  if (!clean) return '';
  return clean.replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
}

function normalizeCardHeight(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 240;
  return Math.max(160, Math.min(560, Math.round(parsed)));
}

function isRemoteHttpUrl(value: string) {
  return /^https?:\/\//i.test(value.trim());
}

export default function AdminScreen() {
  const { user, resetToAdminOnly } = useAuth();
  const theme = useTheme();

  const [tmdbId, setTmdbId] = useState('');
  const [adminApiKey, setAdminApiKey] = useState('');
  const [title, setTitle] = useState('');
  const [overview, setOverview] = useState('');
  const [backdropPath, setBackdropPath] = useState('');
  const [posterPath, setPosterPath] = useState('');
  const [featuredMessage, setFeaturedMessage] = useState<string | null>(null);

  const rounded = useMemo(() => roundToNextFiveMinutes(), []);
  const [cinemaTitle, setCinemaTitle] = useState('');
  const [cinemaDesc, setCinemaDesc] = useState('');
  const [cinemaTmdbId, setCinemaTmdbId] = useState('');
  const [startDayOffset, setStartDayOffset] = useState(0);
  const [startHour, setStartHour] = useState(rounded.getHours());
  const [startMinute, setStartMinute] = useState(rounded.getMinutes() - (rounded.getMinutes() % 5));
  const [videoInput, setVideoInput] = useState('');
  const [posterInput, setPosterInput] = useState('');
  const [cinemaMessage, setCinemaMessage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [latestCinemaInfo, setLatestCinemaInfo] = useState<string>('');
  const [pickedDurationSec, setPickedDurationSec] = useState<number | null>(null);
  const [resetConfirm, setResetConfirm] = useState('');
  const [galleryImageInputs, setGalleryImageInputs] = useState<string[]>([]);
  const [galleryJsonInput, setGalleryJsonInput] = useState('');
  const [galleryMessage, setGalleryMessage] = useState<string | null>(null);
  const [gallerySubmitting, setGallerySubmitting] = useState(false);
  const [galleryPalettePreview, setGalleryPalettePreview] = useState<string[]>([]);

  const cloudinaryReady = hasCloudinaryConfig();
  const cleanAdminKey = adminApiKey.trim();

  useEffect(() => {
    setRuntimeAdminKey(cleanAdminKey);
    return () => {
      setRuntimeAdminKey('');
    };
  }, [cleanAdminKey]);

  useEffect(() => {
    if (!galleryJsonInput.trim()) {
      setGalleryPalettePreview([]);
      return;
    }
    try {
      const entries = parseJsonPayload(galleryJsonInput.trim());
      setGalleryPalettePreview(parsePalette(entries[0]?.palette_hex));
    } catch {
      setGalleryPalettePreview([]);
    }
  }, [galleryJsonInput]);

  useEffect(() => {
    (async () => {
      const featured = await getFeaturedMovie();
      if (featured) {
        setTmdbId(featured.tmdb_id ? String(featured.tmdb_id) : '');
        setTitle(featured.title ?? '');
        setOverview(featured.overview ?? '');
        setBackdropPath(featured.backdrop_path ?? '');
        setPosterPath(featured.poster_path ?? '');
      }
      const latest = await getLatestCinemaEvent();
      if (latest) {
        setLatestCinemaInfo(`${latest.title} (${fmtShortIso(latest.start_at)})`);
      }
    })();
  }, []);

  const isAdmin = user?.role === 'admin';
  const startIso = useMemo(
    () => toIsoFromPicker(startDayOffset, startHour, startMinute),
    [startDayOffset, startHour, startMinute]
  );
  const estimatedDurationSec = pickedDurationSec ?? 2 * 3600;
  const estimatedEndIso = useMemo(
    () => new Date(Date.parse(startIso) + estimatedDurationSec * 1000).toISOString(),
    [startIso, estimatedDurationSec]
  );

  if (!isAdmin) {
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <Text style={styles.title}>Access restricted</Text>
      </View>
    );
  }

  const onFetchFeatured = async () => {
    setFeaturedMessage(null);
    const id = Number(tmdbId);
    if (!id) {
      setFeaturedMessage('Invalid TMDB ID.');
      return;
    }
    try {
      const movie = await getMovieById(id);
      setTitle(movie.title ?? '');
      setOverview(movie.overview ?? '');
      setBackdropPath(movie.backdrop_path ?? '');
      setPosterPath(movie.poster_path ?? '');
    } catch (err) {
      setFeaturedMessage(err instanceof Error ? err.message : 'TMDB error.');
    }
  };

  const onSaveFeatured = async () => {
    setFeaturedMessage(null);
    await setFeaturedMovie({
      tmdbId: tmdbId ? Number(tmdbId) : null,
      title: title || null,
      overview: overview || null,
      backdropPath: backdropPath || null,
      posterPath: posterPath || null,
    });
    setFeaturedMessage('Featured movie saved.');
  };

  const onPickVideo = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (permission.status !== 'granted') {
        setCinemaMessage('Gallery permission is required.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Videos,
        quality: 0.9,
      });
      if (!result.canceled) {
        const asset = result.assets?.[0];
        if (!asset?.uri) return;
        setVideoInput(asset.uri);
        setPickedDurationSec(normalizeDurationSeconds((asset as any).duration));
        setCinemaMessage('Video selected.');
      }
    } catch {
      setCinemaMessage('Could not open gallery.');
    }
  };

  const onPickPoster = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (permission.status !== 'granted') {
        setCinemaMessage('Gallery permission is required.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.9,
      });
      if (!result.canceled) {
        const asset = result.assets?.[0];
        if (!asset?.uri) return;
        setPosterInput(asset.uri);
        setCinemaMessage('Poster selected.');
      }
    } catch {
      setCinemaMessage('Could not open gallery.');
    }
  };

  const onPickGalleryImages = async () => {
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (permission.status !== 'granted') {
        setGalleryMessage('Gallery permission is required.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: true,
        quality: 0.9,
      });
      if (result.canceled) return;
      const uris = (result.assets ?? [])
        .map((asset) => String(asset?.uri ?? '').trim())
        .filter(Boolean);
      if (!uris.length) return;
      setGalleryImageInputs(uris);
      setGalleryMessage(`${uris.length} image(s) selected.`);
    } catch {
      setGalleryMessage('Could not pick image.');
    }
  };

  const onAddGalleryFromJson = async () => {
    setGalleryMessage(null);
    if (!galleryJsonInput.trim()) {
      setGalleryMessage('JSON code is required.');
      return;
    }
    setGallerySubmitting(true);
    try {
      const entries = parseJsonPayload(galleryJsonInput.trim());
      const selectedImages = galleryImageInputs
        .map((x) => String(x).trim())
        .filter(Boolean);
      const uploadedSelectedImageUrls: string[] = [];
      if (selectedImages.length) {
        if (!cloudinaryReady) {
          setGalleryMessage('Upload service missing. Configure backend Cloudinary credentials or client upload preset.');
          return;
        }
        if (hasBackendApi() && !cleanAdminKey) {
          setGalleryMessage('Admin API key is required for backend Cloudinary upload.');
          return;
        }
        for (let i = 0; i < selectedImages.length; i += 1) {
          const uri = selectedImages[i];
          setGalleryMessage(`Uploading image ${i + 1}/${selectedImages.length} to Cloudinary...`);
          if (isRemoteHttpUrl(uri)) {
            uploadedSelectedImageUrls.push(uri);
          } else {
            const uploaded = await uploadImageToCloudinary(uri, { adminKey: cleanAdminKey || null });
            uploadedSelectedImageUrls.push(uploaded.secureUrl);
          }
        }
      }

      let inserted = 0;

      for (let idx = 0; idx < entries.length; idx += 1) {
        const entry = entries[idx];
        const details = normalizeDetails(entry.details);
        const palette = parsePalette(entry.palette_hex);
        const titleHeader = String(entry.title_header ?? '').trim();
        const title = titleHeader || String(entry.image_id ?? entry.shotid ?? entry.index ?? 'Frame').trim();
        const imageFromJson = String(entry.image_url ?? '').trim();
        const imageFromSelected =
          uploadedSelectedImageUrls[idx] ||
          (uploadedSelectedImageUrls.length === 1 ? uploadedSelectedImageUrls[0] : '');
        const image = imageFromSelected || (isRemoteHttpUrl(imageFromJson) ? imageFromJson : '');
        if (!title || !image) continue;

        const detailsGenre = String(details.GENRE ?? '').split(',')[0] ?? '';
        const tag = normalizeTag(detailsGenre) || 'gallery';
        await addGalleryItem({
          title,
          image,
          tag,
          height: normalizeCardHeight(240),
          shotId: String(entry.shotid ?? '').trim() || null,
          titleHeader: titleHeader || null,
          imageId: String(entry.image_id ?? '').trim() || null,
          imageUrl: imageFromJson || null,
          paletteHex: palette,
          details,
        });
        inserted += 1;
      }
      if (!inserted) {
        setGalleryMessage('No valid item inserted. Check image/json fields.');
        return;
      }
      setGalleryMessage(`Added ${inserted} image(s) to gallery.`);
      setGalleryImageInputs([]);
      setGalleryJsonInput('');
    } catch {
      setGalleryMessage('Invalid JSON or import failed.');
    } finally {
      setGallerySubmitting(false);
    }
  };

  const onClearGallery = async () => {
    const confirmed = Platform.OS === 'web'
      ? (typeof window !== 'undefined' ? window.confirm('Delete ALL gallery items, likes, favorites and comments?') : false)
      : true;
    if (!confirmed) return;
    try {
      await clearGalleryAll();
      setGalleryMessage('Gallery cleared.');
      setGalleryPalettePreview([]);
      setGalleryImageInputs([]);
      setGalleryJsonInput('');
    } catch {
      setGalleryMessage('Could not clear gallery.');
    }
  };

  const onCreateCinema = async () => {
    setCinemaMessage(null);
    const movieId = Number(cinemaTmdbId);
    if (!Number.isFinite(movieId) || movieId <= 0) {
      setCinemaMessage('TMDB ID is required for cinema event.');
      return;
    }
    const cleanTitle = cinemaTitle.trim();
    if (!cleanTitle) {
      setCinemaMessage('Cinema title is required.');
      return;
    }
    if (!videoInput.trim()) {
      setCinemaMessage('Video URL or local video is required.');
      return;
    }
    if (hasBackendApi() && !cleanAdminKey) {
      setCinemaMessage('Admin API key is required for backend publish.');
      return;
    }

    const now = Date.now();
    const startMs = Date.parse(startIso);
    if (!Number.isFinite(startMs) || startMs <= now) {
      setCinemaMessage('Start must be in the future.');
      return;
    }

    try {
      setUploading(true);
      let finalVideoUrl = videoInput.trim();
      let finalPosterUrl = posterInput.trim() || null;
      let durationSec = pickedDurationSec;

      if (!/^https?:\/\//i.test(finalVideoUrl)) {
        if (!cloudinaryReady) {
          setCinemaMessage('Upload service missing. Configure backend Cloudinary credentials or client upload preset.');
          return;
        }
        const uploaded = await uploadVideoToCloudinary(finalVideoUrl, { adminKey: cleanAdminKey || null });
        finalVideoUrl = uploaded.secureUrl;
        durationSec = uploaded.durationSec ?? durationSec;
      }
      if (!finalPosterUrl) {
        setCinemaMessage('Poster image is required.');
        return;
      }
      if (!/^https?:\/\//i.test(finalPosterUrl)) {
        if (!cloudinaryReady) {
          setCinemaMessage('Upload service missing. Configure backend Cloudinary credentials or client upload preset.');
          return;
        }
        const uploadedPoster = await uploadImageToCloudinary(finalPosterUrl, { adminKey: cleanAdminKey || null });
        finalPosterUrl = uploadedPoster.secureUrl;
      }

      const finalDuration = durationSec ?? 2 * 3600;
      const endIso = new Date(startMs + finalDuration * 1000).toISOString();

      await createCinemaEvent(
        {
          title: cleanTitle,
          description: cinemaDesc.trim() || null,
          videoUrl: finalVideoUrl,
          posterUrl: finalPosterUrl,
          tmdbId: movieId,
          startAt: startIso,
          endAt: endIso,
          createdBy: user?.id ?? null,
        },
        { adminKey: cleanAdminKey || null }
      );
      const latest = await getLatestCinemaEvent();
      if (latest) setLatestCinemaInfo(`${latest.title} (${fmtShortIso(latest.start_at)})`);
      setCinemaMessage(`Cinema event published. End auto: ${fmtShortIso(endIso)}`);
    } catch (err) {
      setCinemaMessage(err instanceof Error ? err.message : 'Could not publish cinema event.');
    } finally {
      setUploading(false);
    }
  };

  const onFetchCinemaFromTmdb = async () => {
    setCinemaMessage(null);
    const movieId = Number(cinemaTmdbId);
    if (!Number.isFinite(movieId) || movieId <= 0) {
      setCinemaMessage('Invalid cinema TMDB ID.');
      return;
    }
    try {
      const [movie, credits] = await Promise.all([getMovieById(movieId), getMovieCredits(movieId)]);
      const director = (credits.crew ?? []).find((p) => p.job === 'Director')?.name ?? 'Unknown director';
      setCinemaTitle(movie.title ?? '');
      setCinemaDesc(movie.overview ?? '');
      setCinemaMessage(`Fetched movie details. Director: ${director}`);
    } catch (err) {
      setCinemaMessage(err instanceof Error ? err.message : 'TMDB fetch failed.');
    }
  };

  const onResetDb = async () => {
    setCinemaMessage(null);
    if (resetConfirm.trim().toUpperCase() !== 'RESET') {
      setCinemaMessage('Type RESET to confirm full reset.');
      return;
    }
    if (hasBackendApi() && !cleanAdminKey) {
      setCinemaMessage('Admin API key is required for backend reset.');
      return;
    }
    try {
      await resetToAdminOnly();
      if (hasBackendApi()) {
        await backendResetAllData({ adminKey: cleanAdminKey || null });
      }
      setResetConfirm('');
      setCinemaMessage('Full reset done. Only admin is kept. Cinema/comments/social data cleared.');
      setLatestCinemaInfo('');
    } catch (err) {
      setCinemaMessage(err instanceof Error ? err.message : 'Reset failed.');
    }
  };

  const dayOptions = ['Today', 'Tomorrow', 'In 2 days', 'In 3 days', 'In 4 days', 'In 5 days'];
  const hourOptions = Array.from({ length: 24 }, (_, i) => i);
  const minuteOptions = Array.from({ length: 12 }, (_, i) => i * 5);

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme.background }]} contentContainerStyle={styles.scroll}>
      <Pressable style={styles.backBtn} onPress={() => router.back()}>
        <Ionicons name="arrow-back" size={18} color="#fff" />
        <Text style={styles.backText}>Go back</Text>
      </Pressable>

      <View style={styles.card}>
        <Text style={styles.title}>Admin Panel</Text>
        <Text style={styles.subtitle}>Featured movie editor.</Text>
        <Text style={styles.label}>Admin API key (runtime only)</Text>
        <TextInput
          style={styles.input}
          value={adminApiKey}
          onChangeText={setAdminApiKey}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Paste Render ADMIN_API_KEY"
          placeholderTextColor="rgba(255,255,255,0.55)"
        />

        <Text style={styles.label}>TMDB ID</Text>
        <TextInput
          style={styles.input}
          value={tmdbId}
          onChangeText={setTmdbId}
          placeholder="ex: 603692"
          placeholderTextColor="rgba(255,255,255,0.55)"
          keyboardType="number-pad"
        />

        <Pressable onPress={onFetchFeatured} style={styles.fetchBtn}>
          <Text style={styles.fetchText}>Fetch from TMDB</Text>
        </Pressable>

        <Text style={styles.label}>Title</Text>
        <TextInput style={styles.input} value={title} onChangeText={setTitle} />

        <Text style={styles.label}>Overview</Text>
        <TextInput style={[styles.input, styles.textarea]} value={overview} onChangeText={setOverview} multiline />

        <Text style={styles.label}>Backdrop Path</Text>
        <TextInput style={styles.input} value={backdropPath} onChangeText={setBackdropPath} />

        <Text style={styles.label}>Poster Path</Text>
        <TextInput style={styles.input} value={posterPath} onChangeText={setPosterPath} />

        {featuredMessage ? <Text style={styles.message}>{featuredMessage}</Text> : null}

        <Pressable onPress={onSaveFeatured} style={styles.saveBtn}>
          <Text style={styles.saveText}>Save featured</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Cinema Scheduler</Text>
        <Text style={styles.subtitle}>Publish one live cinema event with MP4 + chat room.</Text>
        <Text style={styles.mini}>Latest event: {latestCinemaInfo || 'none'}</Text>
        <Text style={styles.mini}>Upload service: {cloudinaryReady ? 'configured' : 'missing config'}</Text>

        <Text style={styles.label}>TMDB ID (required)</Text>
        <TextInput
          style={styles.input}
          value={cinemaTmdbId}
          onChangeText={setCinemaTmdbId}
          placeholder="ex: 603692"
          placeholderTextColor="rgba(255,255,255,0.55)"
          keyboardType="number-pad"
        />
        <Pressable onPress={onFetchCinemaFromTmdb} style={styles.fetchBtn}>
          <Text style={styles.fetchText}>Fetch title/about/director/actors from TMDB</Text>
        </Pressable>

        <Text style={styles.label}>Event title</Text>
        <TextInput
          style={styles.input}
          value={cinemaTitle}
          onChangeText={setCinemaTitle}
          placeholder="Cinema Night #1"
          placeholderTextColor="rgba(255,255,255,0.55)"
        />

        <Text style={styles.label}>Description</Text>
        <TextInput
          style={[styles.input, styles.textarea]}
          value={cinemaDesc}
          onChangeText={setCinemaDesc}
          multiline
          placeholder="Live watch + chat"
          placeholderTextColor="rgba(255,255,255,0.55)"
        />

        <Text style={styles.label}>Start time</Text>
        <View style={styles.pickerRow}>
          <View style={styles.pickerBoxLarge}>
            <Picker
              selectedValue={startDayOffset}
              onValueChange={(v) => setStartDayOffset(Number(v))}
              style={styles.picker}>
              {dayOptions.map((label, idx) => (
                <Picker.Item key={label} label={label} value={idx} color="#fff" />
              ))}
            </Picker>
          </View>
          <View style={styles.pickerBoxSmall}>
            <Picker
              selectedValue={startHour}
              onValueChange={(v) => setStartHour(Number(v))}
              style={styles.picker}>
              {hourOptions.map((h) => (
                <Picker.Item key={h} label={String(h).padStart(2, '0')} value={h} color="#fff" />
              ))}
            </Picker>
          </View>
          <View style={styles.pickerBoxSmall}>
            <Picker
              selectedValue={startMinute}
              onValueChange={(v) => setStartMinute(Number(v))}
              style={styles.picker}>
              {minuteOptions.map((m) => (
                <Picker.Item key={m} label={String(m).padStart(2, '0')} value={m} color="#fff" />
              ))}
            </Picker>
          </View>
        </View>

        <Text style={styles.mini}>Start: {fmtShortIso(startIso)}</Text>
        <Text style={styles.mini}>End auto (estimated): {fmtShortIso(estimatedEndIso)}</Text>

        <Text style={styles.label}>Video URL or picked local video</Text>
        <TextInput
          style={styles.input}
          value={videoInput}
          onChangeText={setVideoInput}
          placeholder="https://...mp4 or pick from gallery"
          placeholderTextColor="rgba(255,255,255,0.55)"
        />
        <Pressable onPress={onPickVideo} style={styles.fetchBtn}>
          <Text style={styles.fetchText}>Select local MP4</Text>
        </Pressable>

        <Text style={styles.label}>Poster image (required)</Text>
        <Pressable onPress={onPickPoster} style={styles.fetchBtn}>
          <Text style={styles.fetchText}>Select local poster</Text>
        </Pressable>
        <TextInput
          style={styles.input}
          value={posterInput}
          onChangeText={setPosterInput}
          placeholder="Selected poster URI (auto-upload to Cloudinary)"
          placeholderTextColor="rgba(255,255,255,0.55)"
        />

        {cinemaMessage ? <Text style={styles.message}>{cinemaMessage}</Text> : null}

        <Pressable onPress={onCreateCinema} style={styles.saveBtn} disabled={uploading}>
          <Text style={styles.saveText}>{uploading ? 'Publishing...' : 'Publish cinema event'}</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Gallery Import</Text>
        <Text style={styles.subtitle}>Upload image + paste JSON. Title/details/palette are extracted automatically.</Text>

        <Text style={styles.label}>Images</Text>
        <Pressable onPress={onPickGalleryImages} style={styles.fetchBtn}>
          <Text style={styles.fetchText}>
            {galleryImageInputs.length ? `${galleryImageInputs.length} image(s) selected` : 'Select photos'}
          </Text>
        </Pressable>

        <Text style={styles.label}>JSON code</Text>
        <TextInput
          style={[styles.input, styles.galleryJson]}
          value={galleryJsonInput}
          onChangeText={setGalleryJsonInput}
          placeholder="Paste JSON object/array from results.json"
          placeholderTextColor="rgba(255,255,255,0.55)"
          multiline
        />

        {galleryPalettePreview.length > 0 ? (
          <View style={styles.paletteWrap}>
            {galleryPalettePreview.map((hex, idx) => (
              <View key={`${hex}-${idx}`} style={styles.paletteItem}>
                <View style={[styles.paletteColor, { backgroundColor: hex }]} />
                <Text style={styles.paletteText}>{hex}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {galleryMessage ? <Text style={styles.message}>{galleryMessage}</Text> : null}

        <Pressable onPress={onAddGalleryFromJson} style={styles.saveBtn} disabled={gallerySubmitting}>
          <Text style={styles.saveText}>{gallerySubmitting ? 'Adding...' : 'Add to gallery'}</Text>
        </Pressable>
        <Pressable onPress={onClearGallery} style={styles.resetBtn}>
          <Text style={styles.saveText}>Clear gallery</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Danger Zone</Text>
        <Text style={styles.subtitle}>Full reset: delete all users and data, keep only admin.</Text>
        <TextInput
          style={styles.input}
          value={resetConfirm}
          onChangeText={setResetConfirm}
          placeholder='Type "RESET"'
          placeholderTextColor="rgba(255,255,255,0.55)"
        />
        <Pressable onPress={onResetDb} style={styles.resetBtn}>
          <Text style={styles.saveText}>Reset DB (keep admin)</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: Spacing.four,
  },
  scroll: {
    paddingBottom: 100,
    gap: Spacing.four,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  backText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 11,
  },
  card: {
    backgroundColor: '#101215',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: Spacing.four,
    padding: Spacing.four,
  },
  title: {
    fontSize: 22,
    fontFamily: Fonts.serif,
    color: '#fff',
  },
  subtitle: {
    marginTop: Spacing.one,
    marginBottom: Spacing.three,
    fontFamily: Fonts.serif,
    color: 'rgba(255,255,255,0.74)',
  },
  mini: {
    fontFamily: Fonts.mono,
    fontSize: 11,
    marginBottom: 4,
    color: 'rgba(255,255,255,0.66)',
  },
  label: {
    fontFamily: Fonts.mono,
    fontSize: 11,
    marginBottom: Spacing.one,
    color: 'rgba(255,255,255,0.66)',
  },
  input: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    color: '#fff',
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
    marginBottom: Spacing.three,
    fontFamily: Fonts.serif,
  },
  pickerRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  pickerBoxLarge: {
    flex: 1.4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
    overflow: 'hidden',
  },
  pickerBoxSmall: {
    flex: 0.7,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.06)',
    overflow: 'hidden',
  },
  picker: {
    color: '#fff',
  },
  textarea: {
    height: 90,
    textAlignVertical: 'top',
  },
  galleryJson: {
    minHeight: 120,
    textAlignVertical: 'top',
  },
  paletteWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: Spacing.two,
  },
  paletteItem: {
    width: 74,
  },
  paletteColor: {
    height: 34,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.24)',
  },
  paletteText: {
    marginTop: 4,
    color: 'rgba(255,255,255,0.78)',
    fontFamily: Fonts.mono,
    fontSize: 9,
  },
  fetchBtn: {
    alignItems: 'center',
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
    backgroundColor: '#C1121F',
    marginBottom: Spacing.three,
  },
  fetchText: {
    color: '#fff',
    fontFamily: Fonts.mono,
  },
  message: {
    marginBottom: Spacing.two,
    fontFamily: Fonts.mono,
    color: '#fff',
  },
  saveBtn: {
    backgroundColor: '#111',
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
    alignItems: 'center',
  },
  saveText: {
    color: '#fff',
    fontFamily: Fonts.mono,
  },
  resetBtn: {
    backgroundColor: '#8B0A16',
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
    alignItems: 'center',
  },
});
