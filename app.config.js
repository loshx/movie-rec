const fs = require('fs');
const path = require('path');

function resolveEnvValue(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

module.exports = ({ config }) => {
  const extra = config?.extra ?? {};
  const localGoogleServicesFile = './android/app/google-services.json';
  const localGoogleServicesPath = path.join(__dirname, 'android', 'app', 'google-services.json');
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON
    ? process.env.GOOGLE_SERVICES_JSON
    : fs.existsSync(localGoogleServicesPath)
      ? localGoogleServicesFile
      : undefined;

  const androidConfig = {
    ...(config?.android ?? {}),
  };

  if (googleServicesFile) {
    androidConfig.googleServicesFile = googleServicesFile;
  } else {
    delete androidConfig.googleServicesFile;
  }

  return {
    ...config,
    android: androidConfig,
    extra: {
      ...extra,
      EXPO_PUBLIC_TMDB_API_KEY: resolveEnvValue(process.env.EXPO_PUBLIC_TMDB_API_KEY, extra.EXPO_PUBLIC_TMDB_API_KEY ?? ''),
      EXPO_PUBLIC_TMDB_TOKEN: resolveEnvValue(process.env.EXPO_PUBLIC_TMDB_TOKEN, extra.EXPO_PUBLIC_TMDB_TOKEN ?? ''),
      EXPO_PUBLIC_ML_API_URL: resolveEnvValue(process.env.EXPO_PUBLIC_ML_API_URL, extra.EXPO_PUBLIC_ML_API_URL ?? ''),
      EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME: resolveEnvValue(
        process.env.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME,
        extra.EXPO_PUBLIC_CLOUDINARY_CLOUD_NAME ?? ''
      ),
      EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET: resolveEnvValue(
        process.env.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET,
        extra.EXPO_PUBLIC_CLOUDINARY_UPLOAD_PRESET ?? ''
      ),
      EXPO_PUBLIC_BACKEND_URL: resolveEnvValue(process.env.EXPO_PUBLIC_BACKEND_URL, extra.EXPO_PUBLIC_BACKEND_URL ?? ''),
      EXPO_PUBLIC_CINEMA_WS_URL: resolveEnvValue(process.env.EXPO_PUBLIC_CINEMA_WS_URL, extra.EXPO_PUBLIC_CINEMA_WS_URL ?? ''),
      EXPO_PUBLIC_CINEMA_EMPTY_IMAGE_URL: resolveEnvValue(
        process.env.EXPO_PUBLIC_CINEMA_EMPTY_IMAGE_URL,
        extra.EXPO_PUBLIC_CINEMA_EMPTY_IMAGE_URL ?? ''
      ),
      EXPO_PUBLIC_ADMIN_AUTH0_SUBS: resolveEnvValue(
        process.env.EXPO_PUBLIC_ADMIN_AUTH0_SUBS,
        extra.EXPO_PUBLIC_ADMIN_AUTH0_SUBS ?? ''
      ),
      EXPO_PUBLIC_ADMIN_EMAILS: resolveEnvValue(
        process.env.EXPO_PUBLIC_ADMIN_EMAILS,
        extra.EXPO_PUBLIC_ADMIN_EMAILS ?? ''
      ),
    },
  };
};
