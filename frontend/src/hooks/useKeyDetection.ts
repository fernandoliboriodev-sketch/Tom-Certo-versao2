/**
 * useKeyDetection — hook principal de detecção de tonalidade
 *
 * ── FIXES (Bug: "Recording is already in progress") ──────────────────────────
 * FIX A: isStartingRef lock em start() — previne chamadas concorrentes
 * FIX B: start() agora para a sessão anterior com AWAIT antes de iniciar nova
 *        → antes era engineRef.current?.stop() sem await = fire-and-forget
 *        → o nativo podia ainda estar gravando quando startRecording() era chamado
 * FIX C: Logs estruturados em todos os pontos-chave do fluxo
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { detectKeyFromHistogram, KeyResult } from '../utils/keyDetector';
import { usePitchEngine } from '../audio/usePitchEngine';
import type { PitchEvent, PitchErrorReason } from '../audio/types';
import { frequencyToMidi, midiToPitchClass, formatKeyDisplay } from '../utils/noteUtils';

// ─── Constantes do algoritmo ─────────────────────────────────────────────────
const HISTORY_MS = 15000;
const ANALYZE_INTERVAL_MS = 400;

// Suavização de frequência (evita G ↔ G# ao cantar levemente desafinado)
const FREQ_SMOOTH_WINDOW = 9;

// Filtro de qualidade de amostra
const MIN_RMS = 0.018;
const MIN_CLARITY = 0.87;

// Fases de warmup
const MIN_QUALITY_SAMPLES = 28;
const WARMUP_MIN_MS = 6000;
const WARMUP_MIN_UNIQUE = 6;

// Primeira detecção (conservadora)
const FIRST_CONFIDENCE = 0.80;
const CONFIRM_FRAMES = 10;

// Manutenção de tom existente
const ONGOING_CONFIDENCE = 0.54;
const HISTOGRAM_DECAY = 2.0;

// Histerese de mudança de tom
const CHANGE_MIN_FRAMES = 16;

// Display de nota
const NOTE_DISPLAY_HOLD_MS = 400;
const NOTE_DEDUPE_WINDOW_MS = 100;

// ─── Tipos ────────────────────────────────────────────────────────────────────
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

// ─── Hook ─────────────────────────────────────────────────────────────────────
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

  // Refs internas (não causam re-renders)
  const noteHistory = useRef<NoteEvent[]>([]);
  const freqBuffer = useRef<number[]>([]);
  const currentKeyRef = useRef<KeyResult | null>(null);
  const hysteresisRef = useRef<{ root: number; quality: string; count: number } | null>(null);
  const confirmRef = useRef<{ root: number; quality: string; count: number } | null>(null);
  const sessionStartRef = useRef<number>(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRunningRef = useRef(false);
  const lastPitchRef = useRef<{ pc: number; ts: number } | null>(null);
  const noteDisplayRef = useRef<{ pc: number; setAt: number } | null>(null);

  // ── FIX A: Lock para prevenir start() concorrente ─────────────────────────
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

  // ── onPitch: filtro de qualidade + suavização de frequência ───────────────
  const onPitch = useCallback((e: PitchEvent) => {
    if (!isRunningRef.current) return;

    if (e.rms < MIN_RMS || e.clarity < MIN_CLARITY) return;

    const now = Date.now();

    freqBuffer.current.push(e.frequency);
    if (freqBuffer.current.length > FREQ_SMOOTH_WINDOW) {
      freqBuffer.current.shift();
    }
    const sortedFreqs = [...freqBuffer.current].sort((a, b) => a - b);
    const medianFreq = sortedFreqs[Math.floor(sortedFreqs.length / 2)];
    const pc = midiToPitchClass(frequencyToMidi(medianFreq));

    const last = lastPitchRef.current;
    if (last && last.pc === pc && now - last.ts < NOTE_DEDUPE_WINDOW_MS) {
      noteHistory.current.push({ pitchClass: pc, timestamp: now, rms: e.rms });
      return;
    }

    lastPitchRef.current = { pc, ts: now };
    noteHistory.current.push({ pitchClass: pc, timestamp: now, rms: e.rms });

    const disp = noteDisplayRef.current;
    if (!disp || now - disp.setAt >= NOTE_DISPLAY_HOLD_MS) {
      noteDisplayRef.current = { pc, setAt: now };
      setCurrentNote(pc);
    }

    const all = noteHistory.current.slice(-50).map(n => n.pitchClass);
    const deduped: number[] = [];
    for (const p of all) {
      if (deduped.length === 0 || deduped[deduped.length - 1] !== p) deduped.push(p);
    }
    setRecentNotes(deduped.slice(-6));
  }, []);

  // ── onEngineError ──────────────────────────────────────────────────────────
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

  // ── analyzeKey ─────────────────────────────────────────────────────────────
  const analyzeKey = useCallback(() => {
    if (!isRunningRef.current) return;

    const now = Date.now();
    noteHistory.current = noteHistory.current.filter(n => n.timestamp >= now - HISTORY_MS);

    const history = noteHistory.current;
    const elapsed = now - sessionStartRef.current;
    const uniqueNotes = new Set(history.map(h => h.pitchClass)).size;
    const hasKey = !!currentKeyRef.current;

    if (!hasKey && history.length < MIN_QUALITY_SAMPLES) {
      setDetectionState('listening');
      setStatusMessage('Ouvindo...');
      return;
    }

    if (!hasKey && (elapsed < WARMUP_MIN_MS || uniqueNotes < WARMUP_MIN_UNIQUE)) {
      setDetectionState('analyzing');
      setStatusMessage('Analisando tonalidade...');
      return;
    }

    const rawCounts = new Array(12).fill(0);
    const histogram = new Array(12).fill(0);
    for (const note of history) {
      const age = (now - note.timestamp) / HISTORY_MS;
      const decay = Math.exp(-HISTOGRAM_DECAY * age);
      histogram[note.pitchClass] += note.rms * decay;
      rawCounts[note.pitchClass]++;
    }

    const totalSamples = history.length || 1;
    for (let i = 0; i < 12; i++) {
      const freq = rawCounts[i] / totalSamples;
      histogram[i] *= (1.0 + freq * 4.0);
    }

    const result = detectKeyFromHistogram(histogram);
    const minConf = hasKey ? ONGOING_CONFIDENCE : FIRST_CONFIDENCE;

    if (result.confidence < minConf) {
      if (!hasKey) {
        confirmRef.current = null;
        setDetectionState('analyzing');
        setStatusMessage('Refinando análise...');
      }
      return;
    }

    const cur = currentKeyRef.current;
    const isSameKey = cur && cur.root === result.root && cur.quality === result.quality;

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
        if (ic.count % 2 === 0) {
          const { noteBr, qualityLabel } = formatKeyDisplay(ic.root, ic.quality as 'major' | 'minor');
          setStatusMessage(`Confirmando: ${noteBr} ${qualityLabel}...`);
        }
        return;
      }
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

    if (isSameKey) {
      hysteresisRef.current = null;
      currentKeyRef.current = result;
      setCurrentKey(result);
      setDetectionState('stable');
      setIsStable(true);
      setStatusMessage('Estável no tom atual');
      return;
    }

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
      setStatusMessage(`Possível mudança: ${noteBr} ${qualityLabel}...`);
    }
  }, []);

  // ── start ──────────────────────────────────────────────────────────────────
  const start = useCallback(async (): Promise<boolean> => {
    // ── FIX A: Lock para prevenir chamadas concorrentes ──────────────────────
    if (isStartingRef.current) {
      console.warn('[KeyDetection][START] start() já está em andamento — chamada duplicada ignorada');
      return false;
    }

    console.log('[KeyDetection][START-1] Botão "Iniciar Detecção" pressionado');
    isStartingRef.current = true;

    try {
      setErrorMessage(null);
      setErrorReason(null);
      setSoftInfo(null);

      // ── FIX B: Parar sessão anterior ANTES de iniciar nova ─────────────────
      // CAUSA DO BUG: stop() era chamado sem await em outros lugares.
      // O Android mantinha o AudioRecord ativo quando startRecording() era chamado,
      // resultando em "Recording is already in progress".
      //
      // SOLUÇÃO: Sempre chamar engine.stop() com AWAIT no início de start(),
      // garantindo que o nativo liberou o AudioRecord antes de iniciar novo.
      if (isRunningRef.current) {
        console.log('[KeyDetection][START-2] Sessão anterior ativa detectada. Parando engine com await...');
        isRunningRef.current = false;
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        // AWAIT garantido: espera o nativo completar o stop (inclui o delay de 250ms)
        await engineRef.current?.stop();
        console.log('[KeyDetection][START-3] Sessão anterior encerrada com sucesso');
      } else {
        // Mesmo que isRunning=false, pode haver race condition onde o nativo
        // ainda está ativo. Por segurança, tentamos parar o engine.
        console.log('[KeyDetection][START-2b] Nenhuma sessão ativa, mas chamando stop() preventivo...');
        await engineRef.current?.stop();
        console.log('[KeyDetection][START-3b] Stop preventivo concluído');
      }

      // Reset completo de estado
      noteHistory.current = [];
      freqBuffer.current = [];
      currentKeyRef.current = null;
      hysteresisRef.current = null;
      confirmRef.current = null;
      lastPitchRef.current = null;
      noteDisplayRef.current = null;
      sessionStartRef.current = Date.now();
      isRunningRef.current = true;
      setIsRunning(true);
      setDetectionState('listening');
      setCurrentKey(null);
      setCurrentNote(null);
      setRecentNotes([]);
      setIsStable(false);
      setStatusMessage('Ouvindo...');

      console.log('[KeyDetection][START-4] Chamando engine.start()...');
      const eng = engineRef.current;
      const ok = await eng.start(onPitch, onEngineError);

      if (!ok) {
        console.log('[KeyDetection][START] engine.start() retornou false — detecção não iniciada');
        isRunningRef.current = false;
        setIsRunning(false);
        setDetectionState('idle');
        return false;
      }

      console.log('[KeyDetection][START-5] engine.start() BEM-SUCEDIDO! Iniciando analisador...');
      intervalRef.current = setInterval(analyzeKey, ANALYZE_INTERVAL_MS);
      return true;
    } finally {
      isStartingRef.current = false;
      console.log('[KeyDetection][START] Lock isStartingRef liberado');
    }
  }, [analyzeKey, onPitch, onEngineError]);

  // ── stop ───────────────────────────────────────────────────────────────────
  const stop = useCallback(() => {
    console.log('[KeyDetection][STOP] Parando detecção. isRunning:', isRunningRef.current);
    isRunningRef.current = false;
    setIsRunning(false);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    // Fire-and-forget (aceitável para chamadas de UI)
    // O importante é que start() sempre usa await antes de chamar engine.start()
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

  // ── reset ──────────────────────────────────────────────────────────────────
  const reset = useCallback(() => {
    stop();
    currentKeyRef.current = null;
    setCurrentKey(null);
    setErrorMessage(null);
  }, [stop]);

  // ── App state: parar ao ir para background ─────────────────────────────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background' && isRunningRef.current) {
        console.log('[KeyDetection] App foi para background — parando detecção');
        stop();
      }
    });
    return () => sub.remove();
  }, [stop]);

  // ── Cleanup no unmount ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      console.log('[KeyDetection] Unmount — limpando recursos');
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
