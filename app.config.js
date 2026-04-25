module.exports = ({ config }) => {
  const googleServicesFile =
    process.env.GOOGLE_SERVICES_JSON ||
    config?.android?.googleServicesFile ||
    './android/app/google-services.json';

  return {
    ...config,
    android: {
      ...config.android,
      googleServicesFile,
    },
  };
};
