import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { ADMIN_LOCAL_LOGIN } from '@/constants/auth';
import { initDb } from '@/db/database';
import {
  getCurrentUser,
  loginUser,
  logoutUser,
  registerUser,
  ensureDefaultAdmin,
  upsertAuth0User,
  isNicknameAvailable,
  updateUserProfile,
  User,
  resetDatabaseKeepAdminOnly,
  deleteUserAccount,
  upsertLocalUserFromBackend,
} from '@/db/auth';
import { syncUserHistoryToMl } from '@/lib/ml-sync';
import { clearBackendUserSession, getBackendUserSession, resolveBackendUserId } from '@/lib/backend-session';
import { bootstrapBackendUserSession, deletePublicAccount } from '@/lib/social-backend';
import {
  BackendLocalAuthError,
  backendLocalLogin,
  backendLocalNicknameAvailable,
  backendLocalRegister,
  backendLocalSyncCredentials,
} from '@/lib/local-auth-backend';
import { hasBackendApi } from '@/lib/cinema-backend';

type AuthContextValue = {
  user: User | null;
  isReady: boolean;
  login: (nickname: string, password: string) => Promise<void>;
  register: (input: {
    name?: string;
    nickname: string;
    email?: string;
    dateOfBirth?: string;
    country?: string;
    password: string;
    role?: 'user' | 'admin';
  }) => Promise<void>;
  loginWithAuth0: (profile: {
    sub: string;
    email?: string | null;
    name?: string | null;
    given_name?: string | null;
    family_name?: string | null;
  }) => Promise<void>;
  checkNicknameAvailability: (nickname: string, excludeUserId?: number) => Promise<boolean>;
  updateProfile: (input: {
    name?: string | null;
    email?: string | null;
    dateOfBirth?: string | null;
    country?: string | null;
    nickname?: string | null;
    bio?: string | null;
    avatarUrl?: string | null;
  }) => Promise<void>;
  deleteAccount: () => Promise<void>;
  logout: () => Promise<void>;
  resetToAdminOnly: () => Promise<void>;
  error: string | null;
  clearError: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await initDb();
        await ensureDefaultAdmin();
        let current = await getCurrentUser();
        const backendEnabled = hasBackendApi();
        if (current?.id && current?.nickname) {
          const bootstrapUserId = Number(current.backend_user_id ?? current.id);
          await bootstrapBackendUserSession(bootstrapUserId, current.nickname).catch(() => null);
          if (backendEnabled && current.role !== 'admin') {
            const session = getBackendUserSession();
            if (!session?.token) {
              await logoutUser();
              current = null;
              if (mounted) {
                setError('Backend session missing. Sign in again.');
              }
            }
          }
        }
        if (mounted) setUser(current ?? null);
      } catch (err) {
        if (mounted) setError((err as Error).message);
      } finally {
        if (mounted) setIsReady(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isReady,
      error,
      clearError: () => setError(null),
      login: async (nickname, password) => {
        await initDb();
        setError(null);
        clearBackendUserSession();
        const cleanNickname = String(nickname || '').trim();
        const cleanPassword = String(password || '');
        const backendEnabled = hasBackendApi();
        const isAdminLogin =
          cleanNickname.toLowerCase() === ADMIN_LOCAL_LOGIN.toLowerCase() ||
          cleanNickname.toLowerCase() === 'admin';
        let u: User | null = null;
        let usedLocalFallback = false;
        let remoteNotFoundError: BackendLocalAuthError | null = null;

        try {
          const remote = await backendLocalLogin({
            nickname: cleanNickname,
            password: cleanPassword,
          });
          if (remote?.user) {
            u = await upsertLocalUserFromBackend({ user: remote.user, password: cleanPassword });
          } else if (backendEnabled && !isAdminLogin) {
            throw new Error('Cannot reach backend login right now. Check backend/server and try again.');
          }
        } catch (err) {
          if (!(err instanceof BackendLocalAuthError) || err.status !== 404) {
            throw err;
          }
          remoteNotFoundError = err;
        }

        if (!u) {
          if (backendEnabled && !isAdminLogin) {
            throw new Error(
              remoteNotFoundError?.message ||
                'Account not found on backend. Use your existing nickname or register from backend-connected device.'
            );
          }
          usedLocalFallback = true;
          try {
            u = await loginUser(cleanNickname, cleanPassword);
          } catch (localErr) {
            if (remoteNotFoundError) {
              throw remoteNotFoundError;
            }
            throw localErr;
          }
        }

        const bootstrapUserId = Number(u.backend_user_id ?? u.id);
        await bootstrapBackendUserSession(bootstrapUserId, u.nickname).catch(() => null);
        if (backendEnabled && u.role !== 'admin') {
          const session = getBackendUserSession();
          if (!session?.token) {
            await logoutUser();
            clearBackendUserSession();
            throw new Error('Backend session could not be established. Check server and retry login.');
          }
        }
        setUser(u);
        if (usedLocalFallback && u.role !== 'admin') {
          await backendLocalSyncCredentials({
            userId: u.id,
            nickname: u.nickname,
            password: cleanPassword,
          }).catch(() => null);
        }
        void syncUserHistoryToMl(Number(u.backend_user_id ?? u.id)).catch(() => {});
      },
      register: async (input) => {
        await initDb();
        setError(null);
        clearBackendUserSession();
        const cleanNickname = String(input.nickname || '').trim();
        const cleanPassword = String(input.password || '');
        const backendEnabled = hasBackendApi();
        let u: User | null = null;
        let usedLocalFallback = false;

        try {
          const remote = await backendLocalRegister({
            nickname: cleanNickname,
            password: cleanPassword,
            name: input.name ?? null,
          });
          if (remote?.user) {
            u = await upsertLocalUserFromBackend({ user: remote.user, password: cleanPassword });
          } else if (backendEnabled) {
            throw new Error('Cannot reach backend register right now. Check backend/server and try again.');
          }
        } catch (err) {
          if (err instanceof BackendLocalAuthError) {
            throw err;
          }
          throw err;
        }

        if (!u) {
          if (backendEnabled) {
            throw new Error('Registration needs backend connection to keep accounts synced across devices.');
          }
          usedLocalFallback = true;
          u = await registerUser(input);
        }

        const bootstrapUserId = Number(u.backend_user_id ?? u.id);
        await bootstrapBackendUserSession(bootstrapUserId, u.nickname).catch(() => null);
        if (backendEnabled && u.role !== 'admin') {
          const session = getBackendUserSession();
          if (!session?.token) {
            await logoutUser();
            clearBackendUserSession();
            throw new Error('Backend session could not be established. Check server and retry register.');
          }
        }
        setUser(u);
        if (usedLocalFallback && u.role !== 'admin') {
          await backendLocalSyncCredentials({
            userId: u.id,
            nickname: u.nickname,
            password: cleanPassword,
          }).catch(() => null);
        }
        void syncUserHistoryToMl(Number(u.backend_user_id ?? u.id)).catch(() => {});
      },
      loginWithAuth0: async (profile) => {
        await initDb();
        setError(null);
        clearBackendUserSession();
        const u = await upsertAuth0User(profile);
        const backendEnabled = hasBackendApi();
        const bootstrapUserId = Number(u.backend_user_id ?? u.id);
        await bootstrapBackendUserSession(bootstrapUserId, u.nickname).catch(() => null);
        if (backendEnabled && u.role !== 'admin') {
          const session = getBackendUserSession();
          if (!session?.token) {
            await logoutUser();
            clearBackendUserSession();
            throw new Error('Backend session could not be established for Auth0 login.');
          }
        }
        setUser(u);
        void syncUserHistoryToMl(Number(u.backend_user_id ?? u.id)).catch(() => {});
      },
      checkNicknameAvailability: async (nickname, excludeUserId) => {
        await initDb();
        setError(null);
        const backendEnabled = hasBackendApi();
        const canonicalExcludeUserId =
          resolveBackendUserId() ??
          (Number.isFinite(Number(excludeUserId)) && Number(excludeUserId) > 0
            ? Number(excludeUserId)
            : null);
        const remoteAvailable = await backendLocalNicknameAvailable(nickname, canonicalExcludeUserId);
        if (typeof remoteAvailable === 'boolean') {
          return remoteAvailable;
        }
        if (backendEnabled) {
          return false;
        }
        return isNicknameAvailable(nickname, excludeUserId);
      },
      updateProfile: async (input) => {
        await initDb();
        if (!user) return;
        setError(null);
        const u = await updateUserProfile(user.id, input);
        setUser(u);
      },
      deleteAccount: async () => {
        await initDb();
        if (!user) return;
        setError(null);
        if (user.role === 'admin') {
          throw new Error('Admin account cannot be deleted.');
        }
        await bootstrapBackendUserSession(Number(user.backend_user_id ?? user.id), user.nickname).catch(() => null);
        await deletePublicAccount(Number(user.backend_user_id ?? user.id));
        await deleteUserAccount(user.id);
        clearBackendUserSession();
        setUser(null);
      },
      logout: async () => {
        await initDb();
        setError(null);
        await logoutUser();
        clearBackendUserSession();
        setUser(null);
      },
      resetToAdminOnly: async () => {
        await initDb();
        setError(null);
        await resetDatabaseKeepAdminOnly();
        const current = await getCurrentUser();
        clearBackendUserSession();
        setUser(current ?? null);
      },
    }),
    [user, isReady, error]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider.');
  return ctx;
}
