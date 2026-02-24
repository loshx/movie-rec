import React, { useEffect, useMemo, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';

import { useAuth } from '@/contexts/AuthContext';
import { addGalleryItem, clearGalleryAll, type GalleryDetails } from '@/db/gallery';
import { closeCinemaPoll, createCinemaEvent, createCinemaPoll, getCurrentCinemaPoll, getLatestCinemaEvent } from '@/db/cinema';
import { hasCloudinaryConfig, uploadImageToCloudinary, uploadVideoToCloudinary } from '@/lib/cloudinary';
import { hasBackendApi } from '@/lib/cinema-backend';
import { setRuntimeAdminKey } from '@/lib/admin-session';
import { getMovieById, getMovieCredits, posterUrl } from '@/lib/tmdb';
import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type ImportEntry = {
  index?: number;
  shotid?: string;
  shot_id?: string;
  shotId?: string;
  title?: string;
  title_header?: string;
  titleHeader?: string;
  image_id?: string;
  imageId?: string;
  image_url?: string;
  imageUrl?: string;
  url?: string;
  secure_url?: string;
  image_file?: string;
  palette_hex?: string[];
  paletteHex?: string[];
  details?: Record<string, unknown>;
  [key: string]: unknown;
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

function getImportEntryValue(entry: ImportEntry, keys: string[]): unknown {
  const row = entry as Record<string, unknown>;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      return row[key];
    }
  }
  const lower = new Map<string, unknown>();
  for (const [rawKey, rawValue] of Object.entries(row)) {
    lower.set(String(rawKey).trim().toLowerCase(), rawValue);
  }
  for (const key of keys) {
    const hit = lower.get(String(key).trim().toLowerCase());
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function getImportEntryString(entry: ImportEntry, keys: string[]) {
  const value = getImportEntryValue(entry, keys);
  if (value === null || value === undefined) return '';
  return String(value).trim();
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

function normalizeImportEntryDetails(entry: ImportEntry): GalleryDetails {
  const nested = normalizeDetails(entry.details);
  if (Object.keys(nested).length > 0) return nested;

  const flatSource = entry as Record<string, unknown>;
  const flat: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(flatSource)) {
    const key = String(rawKey || '').trim();
    if (!key) continue;
    const keyLower = key.toLowerCase();
    if (
      keyLower === 'index' ||
      keyLower === 'shotid' ||
      keyLower === 'shot_id' ||
      keyLower === 'title' ||
      keyLower === 'title_header' ||
      keyLower === 'titleheader' ||
      keyLower === 'image_id' ||
      keyLower === 'imageid' ||
      keyLower === 'image_url' ||
      keyLower === 'imageurl' ||
      keyLower === 'image_file' ||
      keyLower === 'palette_hex' ||
      keyLower === 'palettehex' ||
      keyLower === 'details' ||
      keyLower === 'tag' ||
      keyLower === 'height'
    ) {
      continue;
    }
    if (rawValue === null || rawValue === undefined || typeof rawValue === 'object') continue;
    if (!/^[A-Z][A-Z0-9 /&().'_-]{1,80}$/.test(key)) continue;
    flat[key] = rawValue;
  }

  return normalizeDetails(flat);
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
  const { user } = useAuth();
  const theme = useTheme();

  const [adminApiKey, setAdminApiKey] = useState('');
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
  const [pollQuestion, setPollQuestion] = useState('Choose next movie for Cinema');
  const [pollTmdb1, setPollTmdb1] = useState('');
  const [pollTmdb2, setPollTmdb2] = useState('');
  const [pollTmdb3, setPollTmdb3] = useState('');
  const [pollSubmitting, setPollSubmitting] = useState(false);
  const [pollCurrentId, setPollCurrentId] = useState<number | null>(null);
  const [pollMessage, setPollMessage] = useState<string | null>(null);
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
      const latest = await getLatestCinemaEvent();
      if (latest) {
        setLatestCinemaInfo(`${latest.title} (${fmtShortIso(latest.start_at)})`);
      }
      const currentPoll = await getCurrentCinemaPoll();
      if (currentPoll) {
        setPollCurrentId(Number(currentPoll.id));
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
  const dayOptions = useMemo(
    () =>
      Array.from({ length: 6 }, (_, offset) => {
        const date = new Date();
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() + offset);
        const day = String(date.getDate()).padStart(2, '0');
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const weekday = date.toLocaleDateString(undefined, { weekday: 'short' });
        const label =
          offset === 0 ? `Today (${weekday} ${day}/${month})` : offset === 1 ? `Tomorrow (${weekday} ${day}/${month})` : `${weekday} ${day}/${month}`;
        return { offset, label };
      }),
    []
  );

  if (!isAdmin) {
    return (
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <Text style={styles.title}>Access restricted</Text>
      </View>
    );
  }

  const shiftStartHour = (delta: number) => {
    setStartHour((prev) => {
      const next = (prev + delta) % 24;
      return next < 0 ? next + 24 : next;
    });
  };

  const shiftStartMinute = (deltaSteps: number) => {
    setStartMinute((prevMinute) => {
      let nextMinute = prevMinute + deltaSteps * 5;
      let hourCarry = 0;
      while (nextMinute >= 60) {
        nextMinute -= 60;
        hourCarry += 1;
      }
      while (nextMinute < 0) {
        nextMinute += 60;
        hourCarry -= 1;
      }
      if (hourCarry !== 0) {
        setStartHour((prevHour) => {
          const nextHour = (prevHour + hourCarry) % 24;
          return nextHour < 0 ? nextHour + 24 : nextHour;
        });
      }
      return nextMinute;
    });
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
      const parsedEntries = parseJsonPayload(galleryJsonInput.trim());
      const selectedImages = galleryImageInputs
        .map((x) => String(x).trim())
        .filter(Boolean);
      const entries =
        parsedEntries.length === 1 && selectedImages.length > 1
          ? selectedImages.map((_, idx) => ({
              ...parsedEntries[0],
              index: Number(parsedEntries[0].index ?? idx + 1),
            }))
          : parsedEntries;
      if (selectedImages.length > 0 && selectedImages.length !== entries.length) {
        setGalleryMessage(
          `Image count (${selectedImages.length}) must match JSON items (${entries.length}).`
        );
        return;
      }
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
            const uploaded = await uploadImageToCloudinary(uri, {
              adminKey: cleanAdminKey || null,
              folder: 'movie-rec-gallery',
            });
            uploadedSelectedImageUrls.push(uploaded.secureUrl);
          }
        }
      }

      let inserted = 0;

      for (let idx = 0; idx < entries.length; idx += 1) {
        const entry = entries[idx];
        const details = normalizeImportEntryDetails(entry);
        const palette = parsePalette(
          getImportEntryValue(entry, ['palette_hex', 'paletteHex', 'palette'])
        );
        const titleHeader = getImportEntryString(entry, ['title_header', 'titleHeader']);
        const explicitTitle = getImportEntryString(entry, ['title', 'name', 'movie_title']);
        const shotId = getImportEntryString(entry, ['shotid', 'shot_id', 'shotId']);
        const imageId = getImportEntryString(entry, ['image_id', 'imageId']);
        const imageFromJson = getImportEntryString(entry, [
          'image_url',
          'imageUrl',
          'url',
          'secure_url',
        ]);
        const detailTitle =
          String(details.TITLE ?? '').trim() ||
          String(details['MOVIE TITLE'] ?? '').trim() ||
          String(details.MOVIE ?? '').trim();
        const title =
          explicitTitle ||
          titleHeader ||
          detailTitle ||
          imageId ||
          shotId ||
          (Number.isFinite(Number(entry.index)) ? `Frame ${Number(entry.index)}` : '');
        const imageFromSelected =
          uploadedSelectedImageUrls[idx] ||
          (uploadedSelectedImageUrls.length === 1 ? uploadedSelectedImageUrls[0] : '');
        let image = imageFromSelected;
        if (!image && isRemoteHttpUrl(imageFromJson) && hasBackendApi() && cloudinaryReady && cleanAdminKey) {
          setGalleryMessage(`Uploading image ${idx + 1}/${entries.length} to Cloudinary...`);
          const uploaded = await uploadImageToCloudinary(imageFromJson, {
            adminKey: cleanAdminKey || null,
            folder: 'movie-rec-gallery',
          });
          image = uploaded.secureUrl;
        }
        if (!image) {
          image = isRemoteHttpUrl(imageFromJson) ? imageFromJson : '';
        }
        if (!title || !image) continue;

        const detailsGenre = String(details.GENRE ?? '').split(',')[0] ?? '';
        const tag = normalizeTag(detailsGenre) || 'gallery';
        await addGalleryItem({
          title,
          image,
          tag,
          height: normalizeCardHeight(240),
          shotId: shotId || null,
          titleHeader: titleHeader || null,
          imageId: imageId || null,
          imageUrl: image || imageFromJson || null,
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
    } catch (err) {
      setGalleryMessage(err instanceof Error ? err.message : 'Could not clear gallery.');
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

  const onPublishCinemaPoll = async () => {
    setPollMessage(null);
    if (!hasBackendApi()) {
      setPollMessage('Cinema poll requires backend URL.');
      return;
    }
    if (!cleanAdminKey) {
      setPollMessage('Admin API key is required for cinema poll.');
      return;
    }

    const ids = [pollTmdb1, pollTmdb2, pollTmdb3]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => Number(value));
    if (ids.length !== 3) {
      setPollMessage('Poll needs 3 valid TMDB IDs.');
      return;
    }
    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== 3) {
      setPollMessage('Poll TMDB IDs must be different.');
      return;
    }

    try {
      setPollSubmitting(true);
      const movies = await Promise.all(ids.map((tmdbId) => getMovieById(tmdbId)));
      const options = movies.map((movie, index) => {
        const poster = posterUrl(movie.poster_path, 'w500');
        if (!poster) {
          throw new Error(`Movie "${movie.title}" has no poster.`);
        }
        return {
          id: `opt_${index + 1}`,
          title: String(movie.title || `Movie ${index + 1}`).trim(),
          poster_url: poster,
          tmdb_id: Number(movie.id),
        };
      });
      const poll = await createCinemaPoll(
        {
          question: pollQuestion.trim() || 'Choose next movie',
          options,
        },
        { adminKey: cleanAdminKey || null }
      );
      setPollCurrentId(Number(poll.id));
      setPollMessage('Cinema poll published.');
    } catch (err) {
      setPollMessage(err instanceof Error ? err.message : 'Could not publish cinema poll.');
    } finally {
      setPollSubmitting(false);
    }
  };

  const onCloseCinemaPoll = async () => {
    setPollMessage(null);
    if (!hasBackendApi()) {
      setPollMessage('Cinema poll requires backend URL.');
      return;
    }
    if (!cleanAdminKey) {
      setPollMessage('Admin API key is required for closing cinema poll.');
      return;
    }
    if (!pollCurrentId) {
      setPollMessage('No active poll id in this session. Create a poll first.');
      return;
    }
    try {
      setPollSubmitting(true);
      await closeCinemaPoll(pollCurrentId, { adminKey: cleanAdminKey || null });
      setPollCurrentId(null);
      setPollMessage('Cinema poll closed.');
    } catch (err) {
      setPollMessage(err instanceof Error ? err.message : 'Could not close cinema poll.');
    } finally {
      setPollSubmitting(false);
    }
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: theme.background }]} contentContainerStyle={styles.scroll}>
      <Pressable style={styles.backBtn} onPress={() => router.back()}>
        <Ionicons name="arrow-back" size={18} color="#fff" />
        <Text style={styles.backText}>Go back</Text>
      </Pressable>

      <View style={styles.pageHeader}>
        <Text style={styles.pageEyebrow}>Control Center</Text>
        <Text style={styles.pageTitle}>Admin Dashboard</Text>
        <Text style={styles.pageHint}>Minimal setup for cinema scheduling, polls and gallery import.</Text>
        <View style={styles.pageHeaderStatuses}>
          <View style={[styles.statusPill, hasBackendApi() ? styles.statusOk : styles.statusWarn]}>
            <Text style={styles.statusText}>Backend {hasBackendApi() ? 'Connected' : 'Local only'}</Text>
          </View>
          <View style={[styles.statusPill, cloudinaryReady ? styles.statusOk : styles.statusWarn]}>
            <Text style={styles.statusText}>Cloudinary {cloudinaryReady ? 'Ready' : 'Missing config'}</Text>
          </View>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Admin Access</Text>
        <Text style={styles.subtitle}>Runtime key used for protected backend actions.</Text>
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
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Cinema Scheduler</Text>
        <Text style={styles.subtitle}>Publish one live cinema event with MP4 + chat room.</Text>
        <View style={styles.infoRow}>
          <View style={styles.infoBox}>
            <Text style={styles.infoLabel}>Latest event</Text>
            <Text style={styles.infoValue}>{latestCinemaInfo || 'none'}</Text>
          </View>
          <View style={styles.infoBox}>
            <Text style={styles.infoLabel}>Upload service</Text>
            <Text style={styles.infoValue}>{cloudinaryReady ? 'configured' : 'missing config'}</Text>
          </View>
        </View>

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
        <View style={styles.dayChipWrap}>
          {dayOptions.map((option) => (
            <Pressable
              key={option.offset}
              style={[styles.dayChip, startDayOffset === option.offset ? styles.dayChipActive : null]}
              onPress={() => setStartDayOffset(option.offset)}>
              <Text style={[styles.dayChipText, startDayOffset === option.offset ? styles.dayChipTextActive : null]}>
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.timeRow}>
          <View style={styles.timeControl}>
            <Text style={styles.timeLabel}>Hour</Text>
            <View style={styles.timeStepper}>
              <Pressable onPress={() => shiftStartHour(-1)} style={styles.timeBtn}>
                <Text style={styles.timeBtnText}>-</Text>
              </Pressable>
              <Text style={styles.timeValue}>{String(startHour).padStart(2, '0')}</Text>
              <Pressable onPress={() => shiftStartHour(1)} style={styles.timeBtn}>
                <Text style={styles.timeBtnText}>+</Text>
              </Pressable>
            </View>
          </View>
          <View style={styles.timeControl}>
            <Text style={styles.timeLabel}>Minute</Text>
            <View style={styles.timeStepper}>
              <Pressable onPress={() => shiftStartMinute(-1)} style={styles.timeBtn}>
                <Text style={styles.timeBtnText}>-</Text>
              </Pressable>
              <Text style={styles.timeValue}>{String(startMinute).padStart(2, '0')}</Text>
              <Pressable onPress={() => shiftStartMinute(1)} style={styles.timeBtn}>
                <Text style={styles.timeBtnText}>+</Text>
              </Pressable>
            </View>
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
        <Text style={styles.cardTitle}>Cinema Poll</Text>
        <Text style={styles.subtitle}>Run poll separately from scheduler.</Text>
        <View style={styles.infoRow}>
          <View style={styles.infoBox}>
            <Text style={styles.infoLabel}>Current poll</Text>
            <Text style={styles.infoValue}>{pollCurrentId ? `#${pollCurrentId}` : 'none'}</Text>
          </View>
        </View>
        <Text style={styles.label}>Poll question</Text>
        <TextInput
          style={styles.input}
          value={pollQuestion}
          onChangeText={setPollQuestion}
          placeholder="Choose next movie for Cinema"
          placeholderTextColor="rgba(255,255,255,0.55)"
        />
        <Text style={styles.label}>Poll option TMDB IDs (3 movies)</Text>
        <TextInput
          style={styles.input}
          value={pollTmdb1}
          onChangeText={setPollTmdb1}
          placeholder="Option 1 TMDB ID"
          placeholderTextColor="rgba(255,255,255,0.55)"
          keyboardType="number-pad"
        />
        <TextInput
          style={styles.input}
          value={pollTmdb2}
          onChangeText={setPollTmdb2}
          placeholder="Option 2 TMDB ID"
          placeholderTextColor="rgba(255,255,255,0.55)"
          keyboardType="number-pad"
        />
        <TextInput
          style={styles.input}
          value={pollTmdb3}
          onChangeText={setPollTmdb3}
          placeholder="Option 3 TMDB ID"
          placeholderTextColor="rgba(255,255,255,0.55)"
          keyboardType="number-pad"
        />
        <View style={styles.inlineRow}>
          <Pressable onPress={onPublishCinemaPoll} style={[styles.fetchBtn, styles.inlineBtn]} disabled={pollSubmitting}>
            <Text style={styles.fetchText}>{pollSubmitting ? 'Publishing poll...' : 'Publish poll'}</Text>
          </Pressable>
          <Pressable onPress={onCloseCinemaPoll} style={[styles.resetBtn, styles.inlineBtn]} disabled={pollSubmitting}>
            <Text style={styles.resetText}>Close poll</Text>
          </Pressable>
        </View>
        {pollMessage ? <Text style={styles.message}>{pollMessage}</Text> : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Gallery Import</Text>
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
          <Text style={styles.resetText}>Clear gallery</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: Spacing.four,
  },
  scroll: {
    alignSelf: 'center',
    width: '100%',
    maxWidth: 980,
    paddingTop: Spacing.three,
    paddingBottom: 120,
    gap: Spacing.four,
  },
  pageHeader: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.03)',
    padding: Spacing.three,
    gap: 6,
  },
  pageEyebrow: {
    fontFamily: Fonts.mono,
    fontSize: 10,
    letterSpacing: 1.2,
    color: 'rgba(255,255,255,0.55)',
    textTransform: 'uppercase',
  },
  pageTitle: {
    fontFamily: Fonts.serif,
    fontSize: 26,
    color: '#fff',
  },
  pageHint: {
    fontFamily: Fonts.serif,
    fontSize: 13,
    lineHeight: 18,
    color: 'rgba(255,255,255,0.72)',
  },
  pageHeaderStatuses: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  statusPill: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  statusOk: {
    borderColor: 'rgba(34,197,94,0.45)',
    backgroundColor: 'rgba(34,197,94,0.15)',
  },
  statusWarn: {
    borderColor: 'rgba(245,158,11,0.45)',
    backgroundColor: 'rgba(245,158,11,0.14)',
  },
  statusText: {
    fontFamily: Fonts.mono,
    fontSize: 10,
    color: '#fff',
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  backText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  card: {
    backgroundColor: '#0f1114',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 16,
    padding: Spacing.four,
  },
  title: {
    fontSize: 22,
    fontFamily: Fonts.serif,
    color: '#fff',
  },
  cardTitle: {
    fontSize: 18,
    fontFamily: Fonts.mono,
    color: '#fff',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  subtitle: {
    marginTop: Spacing.one,
    marginBottom: Spacing.three,
    fontFamily: Fonts.serif,
    fontSize: 13,
    lineHeight: 18,
    color: 'rgba(255,255,255,0.68)',
  },
  mini: {
    fontFamily: Fonts.mono,
    fontSize: 11,
    marginBottom: 4,
    color: 'rgba(255,255,255,0.66)',
  },
  infoRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: Spacing.three,
  },
  infoBox: {
    flex: 1,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.03)',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  infoLabel: {
    fontFamily: Fonts.mono,
    fontSize: 9,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.58)',
    marginBottom: 3,
  },
  infoValue: {
    fontFamily: Fonts.serif,
    fontSize: 12,
    color: '#fff',
  },
  label: {
    fontFamily: Fonts.mono,
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: Spacing.one,
    color: 'rgba(255,255,255,0.56)',
  },
  input: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.035)',
    color: '#fff',
    borderRadius: 12,
    paddingHorizontal: Spacing.two,
    paddingVertical: 11,
    marginBottom: Spacing.two + 2,
    fontFamily: Fonts.serif,
    fontSize: 14,
  },
  dayChipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: Spacing.two + 2,
  },
  dayChip: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  dayChipActive: {
    borderColor: 'rgba(96,165,250,0.65)',
    backgroundColor: 'rgba(96,165,250,0.2)',
  },
  dayChipText: {
    color: 'rgba(255,255,255,0.78)',
    fontFamily: Fonts.mono,
    fontSize: 10,
  },
  dayChipTextActive: {
    color: '#fff',
  },
  timeRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  timeControl: {
    flex: 1,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.035)',
    padding: 10,
    gap: 8,
  },
  timeLabel: {
    fontFamily: Fonts.mono,
    fontSize: 10,
    color: 'rgba(255,255,255,0.56)',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  timeStepper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  timeBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  timeBtnText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 16,
    lineHeight: 18,
  },
  timeValue: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 19,
    minWidth: 38,
    textAlign: 'center',
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
  inlineRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: Spacing.two,
    marginBottom: Spacing.one,
  },
  inlineBtn: {
    flex: 1,
  },
  fetchBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingVertical: Spacing.one + 2,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginBottom: Spacing.two + 2,
  },
  fetchText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 12,
  },
  message: {
    marginBottom: Spacing.two + 2,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontFamily: Fonts.mono,
    fontSize: 11,
    color: '#fff',
  },
  saveBtn: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    backgroundColor: '#f2f4f8',
    minHeight: 44,
    justifyContent: 'center',
    paddingVertical: Spacing.one + 2,
    borderRadius: 12,
    alignItems: 'center',
  },
  saveText: {
    color: '#0c0f13',
    fontFamily: Fonts.mono,
    fontSize: 12,
    fontWeight: '700',
  },
  resetText: {
    color: '#fff',
    fontFamily: Fonts.mono,
    fontSize: 12,
    fontWeight: '700',
  },
  resetBtn: {
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.42)',
    backgroundColor: 'rgba(239,68,68,0.18)',
    minHeight: 44,
    justifyContent: 'center',
    paddingVertical: Spacing.one + 2,
    borderRadius: 12,
    alignItems: 'center',
  },
});
