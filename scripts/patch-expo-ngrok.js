/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const projectRoot = process.cwd();
const ngrokDir = path.join(projectRoot, 'node_modules', '@expo', 'ngrok');
const ngrokPkgPath = path.join(ngrokDir, 'package.json');
const ngrokIndexPath = path.join(ngrokDir, 'index.js');

function patchNgrokPackageJson() {
  if (!fs.existsSync(ngrokPkgPath)) return false;

  let pkg;
  try {
    const raw = fs.readFileSync(ngrokPkgPath, 'utf8').replace(/^\uFEFF/, '');
    pkg = JSON.parse(raw);
  } catch (err) {
    console.warn('[patch-expo-ngrok] Could not parse @expo/ngrok/package.json:', err?.message || err);
    return false;
  }

  let changed = false;
  if (pkg.version !== '4.1.3') {
    // Expo resolver checks for @expo/ngrok@^4.1.0.
    pkg.version = '4.1.3';
    changed = true;
  }

  const expectedExports = {
    '.': './index.js',
    './download': './download.js',
    './package.json': './package.json',
  };
  const hasExpectedExports =
    pkg.exports &&
    typeof pkg.exports === 'object' &&
    pkg.exports['.'] === expectedExports['.'] &&
    pkg.exports['./download'] === expectedExports['./download'] &&
    pkg.exports['./package.json'] === expectedExports['./package.json'];

  if (!hasExpectedExports) {
    pkg.exports = expectedExports;
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(ngrokPkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  }

  return changed;
}

function patchNgrokRetryLogic() {
  if (!fs.existsSync(ngrokIndexPath)) return false;

  let content = fs.readFileSync(ngrokIndexPath, 'utf8');
  if (content.includes('const retryOpts = { ...opts };')) {
    return false;
  }

  const search = `async function connectRetry(opts, retryCount = 0) {
  opts.name = String(opts.name || uuid.v4());
  try {
    const response = await ngrokClient.startTunnel(opts);
`;
  const replacement = `async function connectRetry(opts, retryCount = 0) {
  const retryOpts = { ...opts };
  // ngrok v3+ can keep a tunnel name reserved after transient failures.
  // Regenerate the tunnel name on retries to avoid "already exists" loops.
  retryOpts.name = String(
    retryCount > 0 ? uuid.v4() : retryOpts.name || uuid.v4()
  );
  try {
    const response = await ngrokClient.startTunnel(retryOpts);
`;

  if (!content.includes(search)) {
    console.warn('[patch-expo-ngrok] Retry patch pattern not found in @expo/ngrok/index.js');
    return false;
  }

  content = content.replace(search, replacement);
  fs.writeFileSync(ngrokIndexPath, content, 'utf8');
  return true;
}

const changedPkg = patchNgrokPackageJson();
const changedRetry = patchNgrokRetryLogic();

if (changedPkg || changedRetry) {
  console.log('[patch-expo-ngrok] Applied compatibility patch.');
}
