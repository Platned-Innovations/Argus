import { type LoginResponse, type MeDto, type Permission } from '@argus/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo } from 'react';
import { api, ApiError, onUnauthorized } from './api';

interface AuthContextValue {
  me: MeDto | null;
  loading: boolean;
  setMe(me: MeDto): void;
  login(username: string, password: string): Promise<LoginResponse>;
  verifyMfa(mfaToken: string, code: string): Promise<LoginResponse>;
  logout(): Promise<void>;
  can(permission: Permission): boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const ME_KEY = ['auth', 'me'];

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await api<MeDto>('/auth/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  const setMe = useCallback((me: MeDto | null) => qc.setQueryData(ME_KEY, me), [qc]);

  useEffect(
    () =>
      onUnauthorized(() => {
        qc.clear();
        setMe(null);
      }),
    [qc, setMe],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      me: data ?? null,
      loading: isLoading,
      setMe,
      async login(username, password) {
        const res = await api<LoginResponse>('/auth/login', { method: 'POST', body: { username, password } });
        if (res.status === 'ok') setMe(res.user);
        return res;
      },
      async verifyMfa(mfaToken, code) {
        const res = await api<LoginResponse>('/auth/mfa/verify', { method: 'POST', body: { mfaToken, code } });
        if (res.status === 'ok') setMe(res.user);
        return res;
      },
      async logout() {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        qc.clear();
        setMe(null);
      },
      can: (p) => data?.permissions.includes(p) ?? false,
    }),
    [data, isLoading, qc, setMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
