import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

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
import { clearBackendUserSession } from '@/lib/backend-session';
import { bootstrapBackendUserSession, deletePublicAccount } from '@/lib/social-backend';
import {
  BackendLocalAuthError,
  backendLocalLogin,
  backendLocalNicknameAvailable,
  backendLocalRegister,
  backendLocalSyncCredentials,
} from '@/lib/local-auth-backend';

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
        const current = await getCurrentUser();
        if (current?.id && current?.nickname) {
          void bootstrapBackendUserSession(current.id, current.nickname).catch(() => {});
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
        setError(null);
        clearBackendUserSession();
        const cleanNickname = String(nickname || '').trim();
        const cleanPassword = String(password || '');
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
          }
        } catch (err) {
          if (!(err instanceof BackendLocalAuthError) || err.status !== 404) {
            throw err;
          }
          remoteNotFoundError = err;
        }

        if (!u) {
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

        setUser(u);
        await bootstrapBackendUserSession(u.id, u.nickname).catch(() => null);
        if (usedLocalFallback && u.role !== 'admin') {
          await backendLocalSyncCredentials({
            userId: u.id,
            nickname: u.nickname,
            password: cleanPassword,
          }).catch(() => null);
        }
        void syncUserHistoryToMl(u.id).catch(() => {});
      },
      register: async (input) => {
        setError(null);
        clearBackendUserSession();
        const cleanNickname = String(input.nickname || '').trim();
        const cleanPassword = String(input.password || '');
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
          }
        } catch (err) {
          if (err instanceof BackendLocalAuthError) {
            throw err;
          }
          throw err;
        }

        if (!u) {
          usedLocalFallback = true;
          u = await registerUser(input);
        }

        setUser(u);
        await bootstrapBackendUserSession(u.id, u.nickname).catch(() => null);
        if (usedLocalFallback && u.role !== 'admin') {
          await backendLocalSyncCredentials({
            userId: u.id,
            nickname: u.nickname,
            password: cleanPassword,
          }).catch(() => null);
        }
        void syncUserHistoryToMl(u.id).catch(() => {});
      },
      loginWithAuth0: async (profile) => {
        setError(null);
        clearBackendUserSession();
        const u = await upsertAuth0User(profile);
        setUser(u);
        void bootstrapBackendUserSession(u.id, u.nickname).catch(() => {});
        void syncUserHistoryToMl(u.id).catch(() => {});
      },
      checkNicknameAvailability: async (nickname, excludeUserId) => {
        setError(null);
        const remoteAvailable = await backendLocalNicknameAvailable(nickname, excludeUserId ?? null);
        if (typeof remoteAvailable === 'boolean') {
          return remoteAvailable;
        }
        return isNicknameAvailable(nickname, excludeUserId);
      },
      updateProfile: async (input) => {
        if (!user) return;
        setError(null);
        const u = await updateUserProfile(user.id, input);
        setUser(u);
      },
      deleteAccount: async () => {
        if (!user) return;
        setError(null);
        if (user.role === 'admin') {
          throw new Error('Admin account cannot be deleted.');
        }
        await bootstrapBackendUserSession(user.id, user.nickname).catch(() => null);
        await deletePublicAccount(user.id);
        await deleteUserAccount(user.id);
        clearBackendUserSession();
        setUser(null);
      },
      logout: async () => {
        setError(null);
        await logoutUser();
        clearBackendUserSession();
        setUser(null);
      },
      resetToAdminOnly: async () => {
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
