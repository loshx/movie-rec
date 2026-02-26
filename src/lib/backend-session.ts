type UserBackendSession = {
  userId: number;
  token: string;
};

let userSession: UserBackendSession | null = null;

export function setBackendUserSession(session: UserBackendSession | null) {
  if (!session || !Number.isFinite(Number(session.userId)) || Number(session.userId) <= 0) {
    userSession = null;
    return;
  }
  const token = String(session.token ?? '').trim();
  if (!token) {
    userSession = null;
    return;
  }
  userSession = {
    userId: Number(session.userId),
    token,
  };
}

export function clearBackendUserSession() {
  userSession = null;
}

export function getBackendUserSession() {
  if (!userSession) return null;
  return { ...userSession };
}

export function getBackendUserTokenForUser(userId?: number | null) {
  if (!userSession) return null;
  void userId;
  return userSession.token;
}

export function resolveBackendUserId(userId?: number | null) {
  if (userSession?.userId && Number.isFinite(Number(userSession.userId)) && Number(userSession.userId) > 0) {
    return Number(userSession.userId);
  }
  if (Number.isFinite(Number(userId)) && Number(userId) > 0) {
    return Number(userId);
  }
  return null;
}
