/**
 * useKeyDetection v2 — hook principal de detecção de tonalidade
 *
 * MELHORIAS DE ROBUSTEZ:
 * - Nunca "chuta" o tom: confiança mínima 0.82 + ≥6 notas únicas + ≥6s análise
 * - Mensagens progressivas de status (Ouvindo → Analisando → Refinando → Confirmando)
 * - Detecção de silêncio prolongado com feedback ao usuário
 * - Histerese de mudança forte (16 frames) para não mudar em nota isolada
 * - Filtro de qualidade RMS+clarity mais rigoroso
 * - Lock anti-race em start() preservado
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { detectKeyFromHistogram, KeyResult } from '../utils/keyDetector';
import { usePitchEngine } from '../audio/usePitchEngine';
import type { PitchEvent, PitchErrorReason } from '../audio/types';
import { frequencyToMidi, midiToPitchClass, formatKeyDisplay } from '../utils/noteUtils';

// ─── Janelas de análise ─────────────────────────────────────────────────────
const HISTORY_MS = 15000;          // 15s de histórico para construir o histograma
const ANALYZE_INTERVAL_MS = 400;   // roda análise a cada 400ms

// ─── Filtros de qualidade de amostra ────────────────────────────────────────
const MIN_RMS = 0.020;             // energia mínima — ruído de fundo filtrado
const MIN_CLARITY = 0.88;          // confiança mínima do YIN

// ─── Suavização temporal ───────────────────────────────────────────────────
const FREQ_SMOOTH_WINDOW = 9;      // mediana móvel de 9 amostras

// ─── Warmup (obrigatório antes de primeira detecção) ───────────────────────
const MIN_QUALITY_SAMPLES = 32;    // mínimo de pitches válidos
const WARMUP_MIN_MS = 6000;        // 6s de escuta
const WARMUP_MIN_UNIQUE = 6;       // ao menos 6 pitch classes distintas

// ─── Confiança (Pearson correlation KS) ─────────────────────────────────────
const FIRST_CONFIDENCE = 0.82;     // primeira detecção: conservador
const CONFIRM_FRAMES = 10;         // repetir o mesmo resultado 10 vezes (~4s)
const ONGOING_CONFIDENCE = 0.58;   // manutenção — mais permissivo
const HISTOGRAM_DECAY = 2.0;       // peso decai com o tempo

// ─── Histerese para mudança de tom detectado ───────────────────────────────
const CHANGE_MIN_FRAMES = 16;      // 16 frames (~6.4s) para aceitar mudança

// ─── UX: display de nota corrente ──────────────────────────────────────────
const NOTE_DISPLAY_HOLD_MS = 350;  // nota exibida por no mínimo 350ms

// ─── Silence detection ────────────────────────────────────────────────────
const SILENCE_HINT_MS = 8000;      // após 8s sem notas válidas → hint
const SILENCE_RETRY_MS = 20000;    // após 20s sem notas válidas → alerta

// ─── Tipos ─────────────────────────────────────────────────────────────────
interface NoteEvent {
  pitchClass: number;
  timestamp: number;
  rms: number;
}

export type DetectionState =
  | 'idle'
  | 'listening'
  | 'analyzing'
  | 'detected'
  | 'stable';

export interface UseKeyDetectionReturn {
  detectionState: DetectionState;
  currentKey: KeyResult | null;
  currentNote: number | null;
  recentNotes: number[];
  isStable: boolean;
  statusMessage: string;
  isRunning: boolean;
  isSupported: boolean;
  errorMessage: string | null;
  errorReason: PitchErrorReason | null;
  softInfo: string | null;
  start: () => Promise<boolean>;
  stop: () => void;
  reset: () => void;
}

// ─── Hook ──────────────────────────────────────────────────────────────────
export function useKeyDetection(): UseKeyDetectionReturn {
  const [detectionState, setDetectionState] = useState<DetectionState>('idle');
  const [currentKey, setCurrentKey] = useState<KeyResult | null>(null);
  const [currentNote, setCurrentNote] = useState<number | null>(null);
  const [recentNotes, setRecentNotes] = useState<number[]>([]);
  const [isStable, setIsStable] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Pronto para detectar');
  const [isRunning, setIsRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorReason, setErrorReason] = useState<PitchErrorReason | null>(null);
  const [softInfo, setSoftInfo] = useState<string | null>(null);

  // Refs internas
  const noteHistory = useRef<NoteEvent[]>([]);
  const freqBuffer = useRef<number[]>([]);
  const currentKeyRef = useRef<KeyResult | null>(null);
  const hysteresisRef = useRef<{ root: number; quality: string; count: number } | null>(null);
  const confirmRef = useRef<{ root: number; quality: string; count: number } | null>(null);
  const sessionStartRef = useRef<number>(0);
  const lastValidPitchAtRef = useRef<number>(0);
  const silenceHintShownRef = useRef<boolean>(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRunningRef = useRef(false);
  const lastPitchRef = useRef<{ pc: number; ts: number } | null>(null);
  const noteDisplayRef = useRef<{ pc: number; setAt: number } | null>(null);
  const isStartingRef = useRef(false);

  const engine = usePitchEngine();
  const engineRef = useRef(engine);
  engineRef.current = engine;

  useEffect(() => {
    if (engine.setSoftInfoHandler) {
      engine.setSoftInfoHandler((msg: string) => setSoftInfo(msg));
    }
  }, [engine]);

  const isSupported = engine.isSupported;

  // ── onPitch: filtro + suavização mediana ────────────────────────────────
  const onPitch = useCallback((e: PitchEvent) => {
    if (!isRunningRef.current) return;
    if (e.rms < MIN_RMS || e.clarity < MIN_CLARITY) return;

    const now = Date.now();
    lastValidPitchAtRef.current = now;
    silenceHintShownRef.current = false; // reset silence flag

    // Suavização por mediana — absorve oscilações rápidas (G ↔ G#)
    freqBuffer.current.push(e.frequency);
    if (freqBuffer.current.length > FREQ_SMOOTH_WINDOW) {
      freqBuffer.current.shift();
    }
    const sortedFreqs = [...freqBuffer.current].sort((a, b) => a - b);
    const medianFreq = sortedFreqs[Math.floor(sortedFreqs.length / 2)];
    const pc = midiToPitchClass(frequencyToMidi(medianFreq));

    // Registro no histórico (com dedupe temporal curto)
    noteHistory.current.push({ pitchClass: pc, timestamp: now, rms: e.rms });
    lastPitchRef.current = { pc, ts: now };

    // Display: segurar nota pelo mínimo de 350ms para evitar flicker
    const disp = noteDisplayRef.current;
    if (!disp || now - disp.setAt >= NOTE_DISPLAY_HOLD_MS) {
      noteDisplayRef.current = { pc, setAt: now };
      setCurrentNote(pc);
    }

    // recentNotes (últimas 6 diferentes, em ordem)
    const all = noteHistory.current.slice(-60).map(n => n.pitchClass);
    const deduped: number[] = [];
    for (const p of all) {
      if (deduped.length === 0 || deduped[deduped.length - 1] !== p) deduped.push(p);
    }
    setRecentNotes(deduped.slice(-6));
  }, []);

  // ── onEngineError ──────────────────────────────────────────────────────
  const onEngineError = useCallback((msg: string, reason?: PitchErrorReason) => {
    console.log('[KeyDetection][ERRO] Engine reportou erro:', msg, 'reason:', reason);
    setErrorMessage(msg);
    setErrorReason(reason ?? 'unknown');
    setStatusMessage(msg);
    isRunningRef.current = false;
    setIsRunning(false);
    setDetectionState('idle');
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // ── analyzeKey: roda a cada 400ms ──────────────────────────────────────
  const analyzeKey = useCallback(() => {
    if (!isRunningRef.current) return;

    const now = Date.now();
    noteHistory.current = noteHistory.current.filter(n => n.timestamp >= now - HISTORY_MS);

    const history = noteHistory.current;
    const elapsed = now - sessionStartRef.current;
    const uniqueNotes = new Set(history.map(h => h.pitchClass)).size;
    const hasKey = !!currentKeyRef.current;

    // ── Silence detection ────────────────────────────────────────────────
    const timeSinceLastPitch = now - lastValidPitchAtRef.current;
    const everHadPitch = lastValidPitchAtRef.current > 0;

    if (!hasKey && everHadPitch && timeSinceLastPitch > SILENCE_RETRY_MS) {
      setStatusMessage('Sem áudio — verifique o microfone');
      setDetectionState('listening');
      return;
    }
    if (!hasKey && !everHadPitch && elapsed > SILENCE_HINT_MS && !silenceHintShownRef.current) {
      silenceHintShownRef.current = true;
      setSoftInfo('Cante ou toque uma nota próximo ao microfone para iniciar a análise');
    }

    // ── Fase 1: Ouvindo (coletando amostras iniciais) ─────────────────────
    if (!hasKey && history.length < MIN_QUALITY_SAMPLES) {
      setDetectionState('listening');
      if (elapsed < 2000) {
        setStatusMessage('Ouvindo...');
      } else if (timeSinceLastPitch < 2000 || !everHadPitch) {
        setStatusMessage('Ouvindo... capte mais áudio');
      } else {
        setStatusMessage('Ouvindo...');
      }
      return;
    }

    // ── Fase 2: Warmup (variedade melódica insuficiente) ────────────────
    if (!hasKey && (elapsed < WARMUP_MIN_MS || uniqueNotes < WARMUP_MIN_UNIQUE)) {
      setDetectionState('analyzing');
      if (uniqueNotes < WARMUP_MIN_UNIQUE) {
        setStatusMessage(`Analisando tonalidade... (${uniqueNotes}/${WARMUP_MIN_UNIQUE} notas)`);
      } else {
        setStatusMessage('Analisando tonalidade...');
      }
      return;
    }

    // ── Construção do histograma com decay exponencial ─────────────────
    const rawCounts = new Array(12).fill(0);
    const histogram = new Array(12).fill(0);
    for (const note of history) {
      const age = (now - note.timestamp) / HISTORY_MS;
      const decay = Math.exp(-HISTOGRAM_DECAY * age);
      histogram[note.pitchClass] += note.rms * decay;
      rawCounts[note.pitchClass]++;
    }

    // Boost: notas repetidas ganham peso extra (indica tônica/5ª)
    const totalSamples = history.length || 1;
    for (let i = 0; i < 12; i++) {
      const freq = rawCounts[i] / totalSamples;
      histogram[i] *= (1.0 + freq * 4.0);
    }

    // ── Krumhansl-Schmuckler ────────────────────────────────────────────
    const result = detectKeyFromHistogram(histogram);
    const minConf = hasKey ? ONGOING_CONFIDENCE : FIRST_CONFIDENCE;

    if (result.confidence < minConf) {
      if (!hasKey) {
        confirmRef.current = null;
        setDetectionState('analyzing');
        // Status mais informativo: mostra percentual de confiança
        const pct = Math.round(Math.max(0, result.confidence) * 100);
        setStatusMessage(`Refinando análise... (${pct}%)`);
      }
      return;
    }

    const cur = currentKeyRef.current;
    const isSameKey = cur && cur.root === result.root && cur.quality === result.quality;

    // ── PRIMEIRA DETECÇÃO: exige N confirmações do mesmo resultado ─────
    if (!cur) {
      const ic = confirmRef.current;
      if (!ic || ic.root !== result.root || ic.quality !== result.quality) {
        confirmRef.current = { root: result.root, quality: result.quality, count: 1 };
        setDetectionState('analyzing');
        setStatusMessage('Refinando análise...');
        return;
      }
      ic.count++;
      if (ic.count < CONFIRM_FRAMES) {
        setDetectionState('analyzing');
        const { noteBr, qualityLabel } = formatKeyDisplay(ic.root, ic.quality as 'major' | 'minor');
        setStatusMessage(`Confirmando: ${noteBr} ${qualityLabel}... (${ic.count}/${CONFIRM_FRAMES})`);
        return;
      }
      // Detectado com confirmação!
      currentKeyRef.current = result;
      confirmRef.current = null;
      setCurrentKey(result);
      setDetectionState('detected');
      setIsStable(false);
      setStatusMessage('Tom detectado');
      setTimeout(() => {
        if (isRunningRef.current && currentKeyRef.current) {
          setDetectionState('stable');
          setIsStable(true);
          setStatusMessage('Estável no tom atual');
        }
      }, 1800);
      return;
    }

    // ── MESMO TOM: reforço de estabilidade ─────────────────────────────
    if (isSameKey) {
      hysteresisRef.current = null;
      currentKeyRef.current = result;
      setCurrentKey(result);
      setDetectionState('stable');
      setIsStable(true);
      setStatusMessage('Estável no tom atual');
      return;
    }

    // ── POSSÍVEL MUDANÇA: exige N frames consecutivos ─────────────────
    const hys = hysteresisRef.current;
    if (!hys || hys.root !== result.root || hys.quality !== result.quality) {
      hysteresisRef.current = { root: result.root, quality: result.quality, count: 1 };
      setIsStable(false);
      const { noteBr, qualityLabel } = formatKeyDisplay(result.root, result.quality as 'major' | 'minor');
      setStatusMessage(`Possível mudança: ${noteBr} ${qualityLabel}...`);
      return;
    }

    hys.count++;
    const { noteBr, qualityLabel } = formatKeyDisplay(hys.root, hys.quality as 'major' | 'minor');
    if (hys.count >= CHANGE_MIN_FRAMES) {
      currentKeyRef.current = result;
      hysteresisRef.current = null;
      setCurrentKey(result);
      setDetectionState('detected');
      setIsStable(false);
      setStatusMessage(`Novo tom: ${noteBr} ${qualityLabel}`);
      setTimeout(() => {
        if (isRunningRef.current) {
          setDetectionState('stable');
          setIsStable(true);
          setStatusMessage('Estável no tom atual');
        }
      }, 1800);
    } else {
      setStatusMessage(`Possível mudança: ${noteBr} ${qualityLabel}... (${hys.count}/${CHANGE_MIN_FRAMES})`);
    }
  }, []);

  // ── start ──────────────────────────────────────────────────────────────
  const start = useCallback(async (): Promise<boolean> => {
    if (isStartingRef.current) {
      console.warn('[KeyDetection][START] chamada duplicada ignorada');
      return false;
    }

    console.log('[KeyDetection][START-1] Iniciando detecção');
    isStartingRef.current = true;

    try {
      setErrorMessage(null);
      setErrorReason(null);
      setSoftInfo(null);

      // Parar sessão anterior (se houver) com AWAIT para Android liberar AudioRecord
      if (isRunningRef.current) {
        isRunningRef.current = false;
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        await engineRef.current?.stop();
      } else {
        // stop preventivo para garantir estado limpo
        await engineRef.current?.stop();
      }

      // Reset completo
      noteHistory.current = [];
      freqBuffer.current = [];
      currentKeyRef.current = null;
      hysteresisRef.current = null;
      confirmRef.current = null;
      lastPitchRef.current = null;
      noteDisplayRef.current = null;
      lastValidPitchAtRef.current = 0;
      silenceHintShownRef.current = false;
      sessionStartRef.current = Date.now();
      isRunningRef.current = true;
      setIsRunning(true);
      setDetectionState('listening');
      setCurrentKey(null);
      setCurrentNote(null);
      setRecentNotes([]);
      setIsStable(false);
      setStatusMessage('Ouvindo...');

      const eng = engineRef.current;
      const ok = await eng.start(onPitch, onEngineError);

      if (!ok) {
        isRunningRef.current = false;
        setIsRunning(false);
        setDetectionState('idle');
        return false;
      }

      intervalRef.current = setInterval(analyzeKey, ANALYZE_INTERVAL_MS);
      return true;
    } finally {
      isStartingRef.current = false;
    }
  }, [analyzeKey, onPitch, onEngineError]);

  // ── stop ───────────────────────────────────────────────────────────────
  const stop = useCallback(() => {
    console.log('[KeyDetection][STOP]');
    isRunningRef.current = false;
    setIsRunning(false);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    engineRef.current?.stop().catch(e => {
      console.warn('[KeyDetection][STOP] engine.stop() erro (não crítico):', String(e));
    });
    noteHistory.current = [];
    freqBuffer.current = [];
    setDetectionState('idle');
    setCurrentNote(null);
    setRecentNotes([]);
    setIsStable(false);
    setStatusMessage('Pronto para detectar');
  }, []);

  // ── reset ──────────────────────────────────────────────────────────────
  const reset = useCallback(() => {
    stop();
    currentKeyRef.current = null;
    setCurrentKey(null);
    setErrorMessage(null);
  }, [stop]);

  // ── App state ─────────────────────────────────────────────────────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background' && isRunningRef.current) {
        console.log('[KeyDetection] background — parando');
        stop();
      }
    });
    return () => sub.remove();
  }, [stop]);

  // ── Cleanup ───────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      isRunningRef.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
      engineRef.current?.stop().catch(() => {});
    };
  }, []);

  return {
    detectionState,
    currentKey,
    currentNote,
    recentNotes,
    isStable,
    statusMessage,
    isRunning,
    isSupported,
    errorMessage,
    errorReason,
    softInfo,
    start,
    stop,
    reset,
  };
}
