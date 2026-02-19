export async function getDb() {
  throw new Error('SQLite is not available on web in this build.');
}

export async function initDb() {
  // No-op for web (in-memory auth is used in auth.web.ts)
}
