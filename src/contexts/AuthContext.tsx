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
} from '@/db/auth';
import { syncUserHistoryToMl } from '@/lib/ml-sync';

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
        const u = await loginUser(nickname, password);
        setUser(u);
        void syncUserHistoryToMl(u.id).catch(() => {});
      },
      register: async (input) => {
        setError(null);
        const u = await registerUser(input);
        setUser(u);
        void syncUserHistoryToMl(u.id).catch(() => {});
      },
      loginWithAuth0: async (profile) => {
        setError(null);
        const u = await upsertAuth0User(profile);
        setUser(u);
        void syncUserHistoryToMl(u.id).catch(() => {});
      },
      checkNicknameAvailability: async (nickname, excludeUserId) => {
        setError(null);
        return isNicknameAvailable(nickname, excludeUserId);
      },
      updateProfile: async (input) => {
        if (!user) return;
        setError(null);
        const u = await updateUserProfile(user.id, input);
        setUser(u);
      },
      logout: async () => {
        setError(null);
        await logoutUser();
        setUser(null);
      },
      resetToAdminOnly: async () => {
        setError(null);
        await resetDatabaseKeepAdminOnly();
        const current = await getCurrentUser();
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
