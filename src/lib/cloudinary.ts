import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { backendGetCloudinaryUploadSignature, hasBackendApi } from '@/lib/cinema-backend';

const extra = (Constants.expoConfig?.extra ?? {}) as {
  EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME?: string;
  EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET?: string;
};

const CLOUD_NAME = extra.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME?.trim() ?? '';
const UPLOAD_PRESET = extra.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET?.trim() ?? '';

function hasUnsignedCloudinaryConfig() {
  return !!CLOUD_NAME && !!UPLOAD_PRESET;
}

export function hasCloudinaryConfig() {
  return hasBackendApi() || hasUnsignedCloudinaryConfig();
}

export type CloudinaryVideoUploadResult = {
  secureUrl: string;
  durationSec: number | null;
  posterUrl: string | null;
};

export type CloudinaryImageUploadResult = {
  secureUrl: string;
};

function isRemoteHttpUrl(value: string) {
  return /^https?:\/\//i.test(String(value ?? '').trim());
}

async function appendCloudinaryFile(
  form: FormData,
  fileUri: string,
  filename: string,
  mimeType: string
) {
  if (isRemoteHttpUrl(fileUri)) {
    form.append('file', fileUri);
    return;
  }
  if (Platform.OS === 'web') {
    const blobRes = await fetch(fileUri);
    const blob = await blobRes.blob();
    form.append('file', blob, filename);
    return;
  }
  form.append('file', {
    uri: fileUri,
    type: mimeType,
    name: filename,
  } as any);
}

async function uploadSignedAsset(fileUri: string, resourceType: 'image' | 'video') {
  if (!hasBackendApi()) return null;
  const signature = await backendGetCloudinaryUploadSignature(resourceType);
  if (!signature) return null;

  const form = new FormData();
  form.append('timestamp', String(signature.timestamp));
  form.append('api_key', signature.api_key);
  form.append('signature', signature.signature);
  form.append('public_id', signature.public_id);
  await appendCloudinaryFile(
    form,
    fileUri,
    `${resourceType}-${Date.now()}.${resourceType === 'video' ? 'mp4' : 'jpg'}`,
    resourceType === 'video' ? 'video/mp4' : 'image/jpeg'
  );

  const res = await fetch(signature.upload_url, {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (!res.ok || !data?.secure_url) {
    throw new Error(data?.error?.message || 'Cloudinary signed upload failed.');
  }
  return {
    ...(data as {
      secure_url: string;
      duration?: number;
      public_id?: string;
    }),
    cloud_name: signature.cloud_name,
  } as {
    secure_url: string;
    duration?: number;
    public_id?: string;
    cloud_name?: string;
  };
}

export async function uploadVideoToCloudinary(fileUri: string) {
  const signedData = await uploadSignedAsset(fileUri, 'video');
  if (signedData?.secure_url) {
    const secureUrl = String(signedData.secure_url);
    const durationSec = Number.isFinite(Number(signedData.duration)) ? Number(signedData.duration) : null;
    const publicId = typeof signedData.public_id === 'string' ? signedData.public_id : '';
    const cloudName = String(signedData.cloud_name ?? CLOUD_NAME ?? '').trim();
    const posterUrl = cloudName && publicId ? `https://res.cloudinary.com/${cloudName}/video/upload/so_1/${publicId}.jpg` : null;
    return {
      secureUrl,
      durationSec,
      posterUrl,
    } as CloudinaryVideoUploadResult;
  }

  if (!hasUnsignedCloudinaryConfig()) {
    throw new Error('Cloudinary upload is not configured. Set backend Cloudinary credentials or upload preset.');
  }
  const endpoint = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/video/upload`;
  const filename = `cinema-${Date.now()}.mp4`;
  const form = new FormData();
  form.append('upload_preset', UPLOAD_PRESET);
  await appendCloudinaryFile(form, fileUri, filename, 'video/mp4');

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
  const signedData = await uploadSignedAsset(fileUri, 'image');
  if (signedData?.secure_url) {
    return {
      secureUrl: String(signedData.secure_url),
    } as CloudinaryImageUploadResult;
  }

  if (!hasUnsignedCloudinaryConfig()) {
    throw new Error('Cloudinary upload is not configured. Set backend Cloudinary credentials or upload preset.');
  }
  const endpoint = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`;
  const filename = `cinema-poster-${Date.now()}.jpg`;
  const form = new FormData();
  form.append('upload_preset', UPLOAD_PRESET);
  await appendCloudinaryFile(form, fileUri, filename, 'image/jpeg');

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
