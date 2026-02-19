import Constants from 'expo-constants';
import { Platform } from 'react-native';

const extra = (Constants.expoConfig?.extra ?? {}) as {
  EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME?: string;
  EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET?: string;
};

const CLOUD_NAME = extra.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME?.trim() ?? '';
const UPLOAD_PRESET = extra.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET?.trim() ?? '';

export function hasCloudinaryConfig() {
  return !!CLOUD_NAME && !!UPLOAD_PRESET;
}

export type CloudinaryVideoUploadResult = {
  secureUrl: string;
  durationSec: number | null;
  posterUrl: string | null;
};

export type CloudinaryImageUploadResult = {
  secureUrl: string;
};

export async function uploadVideoToCloudinary(fileUri: string) {
  if (!hasCloudinaryConfig()) {
    throw new Error('Cloudinary config missing.');
  }
  const endpoint = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/video/upload`;
  const filename = `cinema-${Date.now()}.mp4`;
  const form = new FormData();
  form.append('upload_preset', UPLOAD_PRESET);
  if (Platform.OS === 'web') {
    const blobRes = await fetch(fileUri);
    const blob = await blobRes.blob();
    form.append('file', blob, filename);
  } else {
    form.append('file', {
      uri: fileUri,
      type: 'video/mp4',
      name: filename,
    } as any);
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (!res.ok || !data?.secure_url) {
    throw new Error(data?.error?.message || 'Cloudinary upload failed.');
  }
  const secureUrl = String(data.secure_url);
  const durationSec = Number.isFinite(Number(data.duration)) ? Number(data.duration) : null;
  const publicId = typeof data.public_id === 'string' ? data.public_id : '';
  const posterUrl = publicId ? `https://res.cloudinary.com/${CLOUD_NAME}/video/upload/so_1/${publicId}.jpg` : null;

  return {
    secureUrl,
    durationSec,
    posterUrl,
  } as CloudinaryVideoUploadResult;
}

export async function uploadImageToCloudinary(fileUri: string) {
  if (!hasCloudinaryConfig()) {
    throw new Error('Cloudinary config missing.');
  }
  const endpoint = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`;
  const filename = `cinema-poster-${Date.now()}.jpg`;
  const form = new FormData();
  form.append('upload_preset', UPLOAD_PRESET);

  if (Platform.OS === 'web') {
    const blobRes = await fetch(fileUri);
    const blob = await blobRes.blob();
    form.append('file', blob, filename);
  } else {
    form.append('file', {
      uri: fileUri,
      type: 'image/jpeg',
      name: filename,
    } as any);
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (!res.ok || !data?.secure_url) {
    throw new Error(data?.error?.message || 'Cloudinary image upload failed.');
  }

  return {
    secureUrl: String(data.secure_url),
  } as CloudinaryImageUploadResult;
}
