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

export function getBackendUserTokenForUser(userId?: number | null) {
  if (!userSession) return null;
  if (Number.isFinite(Number(userId)) && Number(userId) > 0 && Number(userId) !== userSession.userId) {
    return null;
  }
  return userSession.token;
}

