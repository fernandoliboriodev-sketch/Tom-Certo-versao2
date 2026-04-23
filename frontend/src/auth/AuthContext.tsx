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
  lastReason: string | null;
  hasSavedToken: boolean;
  activate: (code?: string) => Promise<{ ok: boolean; reason?: string | null }>;
  logout: () => Promise<void>;
  forgetDevice: () => Promise<void>;
  clearError: () => void;
  retryRevalidate: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const SESSION_KEY = 'tc_session_v1';
const TOKEN_KEY = 'tc_token_v1'; // armazena o código do token pra revalidação com 1 toque

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
      return 'Token inválido. Verifique o código e tente novamente.';
    case 'revoked':
      return 'Token revogado. Entre em contato com o suporte.';
    case 'expired':
      return 'Token expirado. Solicite um novo acesso.';
    case 'device_limit':
      return 'Limite de dispositivos atingido. Peça ao suporte para liberar seu dispositivo ou use outro token.';
    case 'session_expired':
    case 'session_invalid':
      return 'Sessão expirada. Ative novamente com seu token.';
    case 'device_mismatch':
      return 'Este dispositivo não está autorizado neste token. Use outro token ou peça liberação.';
    case 'timeout':
      return 'Tempo esgotado. Verifique sua internet e tente novamente.';
    case 'network':
      return 'Não foi possível conectar ao servidor. Verifique sua conexão.';
    case 'no_backend':
      return 'Servidor não configurado. Reinstale o app ou contate o suporte.';
    default:
      return 'Falha ao validar token. Tente novamente em instantes.';
  }
}

// Classifica a razão pra UI decidir qual ação oferecer
export function isPermanentFailure(reason?: string | null): boolean {
  return reason === 'not_found' || reason === 'revoked' || reason === 'expired';
}

export function isDeviceBlockingFailure(reason?: string | null): boolean {
  return reason === 'device_limit' || reason === 'device_mismatch';
}

export function isTransientFailure(reason?: string | null): boolean {
  return reason === 'timeout' || reason === 'network' || reason === 'no_backend';
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // ── Arranca em 'unauthenticated' para EVITAR tela de loading antes do login ──
  // A revalidação acontece em background e só vira 'authenticated' se houver sessão válida.
  const [status, setStatus] = useState<AuthStatus>('unauthenticated');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastReason, setLastReason] = useState<string | null>(null);
  const [hasSavedToken, setHasSavedToken] = useState<boolean>(false);
  const boot = useRef(false);

  const loadAndRevalidate = async () => {
    try {
      // Verifica se há token salvo (pra UI decidir se mostra input ou só botão)
      const savedToken = await storage.getItem(TOKEN_KEY);
      setHasSavedToken(!!savedToken);

      const raw = await storage.getItem(SESSION_KEY);
      if (!raw) {
        console.log('[Auth] Sem sessão salva. Aguardando ativação manual.');
        return;
      }

      // Tem sessão salva → revalida em background (com timeout de 10s)
      const parsed: SessionInfo = JSON.parse(raw);
      const deviceId = await getDeviceId();
      const base = getBackendUrl();
      console.log('[Auth] Revalidando sessão em', base);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      let res: Response;
      try {
        res = await fetch(`${base}/api/auth/revalidate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session: parsed.session,
            device_id: deviceId,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      const data = await res.json().catch(() => ({}));
      console.log('[Auth] Revalidate response:', { status: res.status, valid: data?.valid, reason: data?.reason });

      if (res.ok && data?.valid) {
        setSession({
          ...parsed,
          expires_at: data.expires_at ?? parsed.expires_at,
          customer_name: data.customer_name ?? parsed.customer_name,
          duration_minutes: data.duration_minutes ?? parsed.duration_minutes,
        });
        setStatus('authenticated');
      } else {
        // Sessão inválida — mas só apagar sessão se motivo for definitivo
        // (not_found, revoked, expired). Para erros temporários, mantém sessão
        // local e tentamos de novo na próxima abertura.
        const r = data?.reason;
        if (r === 'not_found' || r === 'revoked' || r === 'expired') {
          await storage.removeItem(SESSION_KEY);
          setSession(null);
          setErrorMessage(reasonToMessage(r));
          setLastReason(r);
          // Mantém o TOKEN_KEY para o usuário poder tentar ativar novamente com ele
          // (o validate() no activate() decidirá se apaga)
        } else if (r === 'session_invalid' || r === 'session_expired') {
          // Sessão JWT expirou mas o token pode ser válido
          await storage.removeItem(SESSION_KEY);
          setSession(null);
          // Não mostra erro — user só vê o botão "Ativar acesso"
        } else {
          // Erro inesperado: mantém sessão (pode ser timing entre fetch e resposta)
          setSession(null);
        }
      }
    } catch (err: any) {
      // Erro de rede / timeout / JSON inválido: mantém 'unauthenticated' silenciosamente.
      // Token e sessão continuam salvos — user pode tentar novamente com 1 toque.
      const isAbort = err?.name === 'AbortError';
      console.warn('[Auth] Revalidate falhou (rede/timeout):', isAbort ? 'timeout' : String(err?.message || err));
      // IMPORTANTE: NÃO apagar session/token nesse caso! Se backend está offline temporariamente
      // e apagamos, user perde acesso até digitar o token de novo.
    }
  };

  useEffect(() => {
    if (boot.current) return;
    boot.current = true;
    loadAndRevalidate();
  }, []);

  const activate = async (code?: string) => {
    setErrorMessage(null);

    // Se não passou código, tenta usar o token salvo
    let clean: string;
    if (code === undefined || code === null || !code.trim()) {
      const saved = await storage.getItem(TOKEN_KEY);
      if (!saved) {
        setErrorMessage('Digite o código do token');
        return { ok: false, reason: 'empty' };
      }
      clean = saved;
      console.log('[Auth] Ativando com token salvo');
    } else {
      clean = code.trim().toUpperCase();
      console.log('[Auth] Ativando com token digitado');
    }

    const base = getBackendUrl();
    if (!base) {
      setErrorMessage('Não foi possível conectar ao servidor. Tente novamente.');
      return { ok: false, reason: 'no_backend' };
    }

    try {
      const deviceId = await getDeviceId();
      console.log('[Auth] Validando em', base, 'deviceId=', deviceId.slice(0, 8) + '...');
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
      console.log('[Auth] Validate response:', { status: res.status, valid: data?.valid, reason: data?.reason });

      if (!res.ok || !data?.valid) {
        const reason = data?.reason || 'unknown';
        const msg = reasonToMessage(reason);
        setErrorMessage(msg);
        setLastReason(reason);
        // Se o token salvo é DEFINITIVAMENTE inválido, apaga-o para forçar nova digitação
        if (reason === 'not_found' || reason === 'revoked' || reason === 'expired') {
          await storage.removeItem(TOKEN_KEY);
          await storage.removeItem(SESSION_KEY);
          setHasSavedToken(false);
        }
        // device_limit e device_mismatch: mantém o token salvo — user pode
        // pedir ao admin pra liberar devices e tentar de novo
        return { ok: false, reason };
      }

      const s: SessionInfo = {
        session: data.session,
        token_id: data.token_id,
        expires_at: data.expires_at,
        customer_name: data.customer_name,
        duration_minutes: data.duration_minutes,
      };
      await storage.setItem(SESSION_KEY, JSON.stringify(s));
      // Salva o token para re-ativação fácil
      await storage.setItem(TOKEN_KEY, clean);
      setHasSavedToken(true);
      setSession(s);
      setStatus('authenticated');
      console.log('[Auth] ✓ Autenticação OK');
      return { ok: true };
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError';
      const msg = String(err?.message || err);
      console.warn('[Auth] Validate falhou (rede/timeout):', isAbort ? 'timeout' : msg);
      const reason = isAbort ? 'timeout' : 'network';
      setErrorMessage(reasonToMessage(reason));
      setLastReason(reason);
      return { ok: false, reason };
    }
  };

  // ── Logout: encerra sessão visual, MAS mantém token salvo ─────────────
  // Usuário volta pra tela de ativação e pode entrar rapidamente
  const logout = async () => {
    await storage.removeItem(SESSION_KEY);
    setSession(null);
    setErrorMessage(null);
    setLastReason(null);
    setStatus('unauthenticated');
    // NÃO apaga o token salvo — próxima ativação é rápida
  };

  // ── ForgetDevice: apaga TUDO (token + sessão) ─────────────────────────
  // Exige nova digitação do token na próxima ativação
  const forgetDevice = async () => {
    await storage.removeItem(SESSION_KEY);
    await storage.removeItem(TOKEN_KEY);
    setSession(null);
    setHasSavedToken(false);
    setErrorMessage(null);
    setLastReason(null);
    setStatus('unauthenticated');
  };

  const clearError = () => {
    setErrorMessage(null);
    setLastReason(null);
  };

  // ── Retry manual do revalidate (para UI oferecer "Tentar novamente") ───
  const retryRevalidate = async () => {
    setErrorMessage(null);
    setLastReason(null);
    await loadAndRevalidate();
  };

  const value: AuthContextValue = {
    status,
    session,
    errorMessage,
    lastReason,
    hasSavedToken,
    activate,
    logout,
    forgetDevice,
    clearError,
    retryRevalidate,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
