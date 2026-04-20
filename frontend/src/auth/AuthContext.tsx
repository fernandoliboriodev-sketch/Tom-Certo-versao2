// Authentication context: handles token activation, persistence and revalidation.
import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import Constants from 'expo-constants';
import * as storage from './storage';
import { getDeviceId } from './deviceId';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface SessionInfo {
  session: string;
  token_id: string;
  expires_at?: string | null;
  customer_name?: string | null;
  duration_minutes?: number | null;
}

export interface AuthContextValue {
  status: AuthStatus;
  session: SessionInfo | null;
  errorMessage: string | null;
  activate: (code: string) => Promise<{ ok: boolean; reason?: string }>;
  logout: () => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const SESSION_KEY = 'tc_session_v1';

// URL de produção: fallback final caso env var não esteja disponível no APK
const PROD_BACKEND_URL = 'https://tom-certo.preview.emergentagent.com';

function getBackendUrl(): string {
  const url =
    (process.env.EXPO_PUBLIC_BACKEND_URL as string | undefined) ||
    (Constants.expoConfig?.extra as any)?.backendUrl ||
    PROD_BACKEND_URL;
  return (url || '').replace(/\/+$/g, '');
}

function reasonToMessage(reason?: string | null): string {
  switch (reason) {
    case 'not_found':
      return 'Token inválido. Verifique e tente novamente.';
    case 'revoked':
      return 'Token revogado. Entre em contato com o suporte.';
    case 'expired':
      return 'Token expirado. Solicite um novo acesso.';
    case 'device_limit':
      return 'Este token já foi usado no limite máximo de dispositivos.';
    case 'session_expired':
    case 'session_invalid':
      return 'Sessão expirada. Digite seu token novamente.';
    case 'device_mismatch':
      return 'Este dispositivo não está autorizado.';
    default:
      return 'Falha ao validar token.';
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // ── Arranca em 'unauthenticated' para EVITAR tela de loading antes do login ──
  // A revalidação acontece em background e só vira 'authenticated' se houver sessão válida.
  const [status, setStatus] = useState<AuthStatus>('unauthenticated');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const boot = useRef(false);

  const loadAndRevalidate = async () => {
    try {
      const raw = await storage.getItem(SESSION_KEY);
      if (!raw) {
        // Sem sessão salva → já está em 'unauthenticated', não precisa mudar
        return;
      }

      // Tem sessão salva → revalida em background
      const parsed: SessionInfo = JSON.parse(raw);
      const deviceId = await getDeviceId();
      const base = getBackendUrl();

      const res = await fetch(`${base}/api/auth/revalidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session: parsed.session,
          device_id: deviceId,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.valid) {
        setSession({
          ...parsed,
          expires_at: data.expires_at ?? parsed.expires_at,
          customer_name: data.customer_name ?? parsed.customer_name,
          duration_minutes: data.duration_minutes ?? parsed.duration_minutes,
        });
        setStatus('authenticated');
      } else {
        await storage.removeItem(SESSION_KEY);
        setSession(null);
        // Permanece em 'unauthenticated' — ActivationScreen já está visível
        if (data?.reason) {
          setErrorMessage(reasonToMessage(data.reason));
        }
      }
    } catch (err) {
      // Erro de rede na revalidação: mantém 'unauthenticated' silenciosamente
      // (Se a internet voltar, próxima abertura do app resolve)
      await storage.removeItem(SESSION_KEY);
    }
  };

  useEffect(() => {
    if (boot.current) return;
    boot.current = true;
    loadAndRevalidate();
  }, []);

  const activate = async (code: string) => {
    setErrorMessage(null);
    const clean = (code || '').trim().toUpperCase();
    if (!clean) {
      setErrorMessage('Digite o código do token');
      return { ok: false, reason: 'empty' };
    }

    const base = getBackendUrl();
    // Com o fallback PROD_BACKEND_URL, essa checagem NUNCA vai falhar em produção.
    // Mantida só por segurança extra.
    if (!base) {
      setErrorMessage('Não foi possível conectar ao servidor. Tente novamente.');
      return { ok: false, reason: 'no_backend' };
    }

    try {
      const deviceId = await getDeviceId();

      // Timeout de 15s para evitar travamento em redes ruins
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const res = await fetch(`${base}/api/auth/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: clean, device_id: deviceId }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.valid) {
        const msg = reasonToMessage(data?.reason);
        setErrorMessage(msg);
        return { ok: false, reason: data?.reason };
      }
      const s: SessionInfo = {
        session: data.session,
        token_id: data.token_id,
        expires_at: data.expires_at,
        customer_name: data.customer_name,
        duration_minutes: data.duration_minutes,
      };
      await storage.setItem(SESSION_KEY, JSON.stringify(s));
      setSession(s);
      setStatus('authenticated');
      return { ok: true };
    } catch (err: any) {
      // Diferenciar timeout/abort vs erro de rede genérico
      const isAbort = err?.name === 'AbortError';
      setErrorMessage(
        isAbort
          ? 'Tempo esgotado. Verifique sua internet e tente novamente.'
          : 'Não foi possível conectar ao servidor. Tente novamente.'
      );
      return { ok: false, reason: isAbort ? 'timeout' : 'network' };
    }
  };

  const logout = async () => {
    await storage.removeItem(SESSION_KEY);
    setSession(null);
    setErrorMessage(null);
    setStatus('unauthenticated');
  };

  const clearError = () => setErrorMessage(null);

  const value: AuthContextValue = {
    status,
    session,
    errorMessage,
    activate,
    logout,
    clearError,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
