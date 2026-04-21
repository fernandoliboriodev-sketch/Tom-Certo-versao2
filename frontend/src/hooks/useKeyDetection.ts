/**
 * useKeyDetection v4 — detecção tonal com SHADOW TRACKING
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FILOSOFIA MUSICAL:
 *
 * 1. RESPOSTA INICIAL RÁPIDA (~1.2s)
 *    Ao receber 6+ amostras com 3+ notas distintas e confiança ≥ 0.50,
 *    mostra "Tom provável" IMEDIATAMENTE — sem esperar mais.
 *
 * 2. REFINAMENTO CONTÍNUO
 *    A confiança é recalculada a cada 300ms. O usuário vê a % subir conforme
 *    canta mais notas da mesma tonalidade.
 *
 * 3. CONFIRMAÇÃO (promoção a CONFIRMED)
 *    Após 5s + ≥ 5 notas distintas + conf ≥ 0.75 + 5 frames consecutivos
 *    do mesmo resultado → tom PASSA A SER ESTÁVEL.
 *
 * 4. SHADOW TRACKING (análise OCULTA de mudança tonal)
 *    Uma vez confirmado, notas fora da tonalidade NÃO disparam UI.
 *    Um "candidato alternativo" é trackeado SILENCIOSAMENTE no background:
 *      - usa janela recente (últimos 4s) para capturar mudanças
 *      - exige 8+ frames consecutivos do novo candidato (~2.4s)
 *      - exige margem de confiança ≥ 0.10 sobre o tom atual
 *      - exige que a confiança do tom atual esteja caindo (< 0.65)
 *    Só quando TODOS esses critérios são atendidos → UI mostra
 *    "Possível mudança tonal". Nota errada isolada = descartada.
 *
 * 5. CONFIRMAÇÃO DE MUDANÇA
 *    Após "Possível mudança" aparecer, precisa de +6 frames (~1.8s total) E
 *    confiança do candidato ≥ 0.70 para COMMIT da mudança de tom.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PESOS DO HISTOGRAMA (musicalmente informados):
 * - Decay temporal: notas recentes pesam mais
 * - Repetição: pitch classes frequentes ganham até +4x
 * - Duração: log1p(runLength) — notas sustentadas valem mais (tônica usual)
 * - Cadência: últimas 3 notas ganham boost extra (finais definem tonalidade)
 * - Estabilidade: runs ≥ 4 frames ganham bônus
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { detectKeyFromHistogram, KeyResult } from '../utils/keyDetector';
import { usePitchEngine } from '../audio/usePitchEngine';
import type { PitchEvent, PitchErrorReason } from '../audio/types';
import { frequencyToMidi, midiToPitchClass, formatKeyDisplay } from '../utils/noteUtils';

// ─── Janelas ───────────────────────────────────────────────────────────────
const HISTORY_MS = 15000;
const RECENT_WINDOW_MS = 4000;      // janela curta para shadow tracking
const ANALYZE_INTERVAL_MS = 250;    // ↓ 300 → 250ms (UI mais responsiva)

// ─── Filtros de qualidade (AFROUXADOS para resposta rápida) ────────────────
const MIN_RMS = 0.018;              // ↓ 0.020 → 0.018 (levemente mais sensível)
const MIN_CLARITY = 0.82;           // ↓ 0.88 → 0.82 (mostra nota antes)
const FREQ_SMOOTH_WINDOW = 5;       // ↓ 7 → 5 (menos lag, ~320ms)

// ─── Histerese anti-vibrato ────────────────────────────────────────────────
// Se variação de MIDI < 30 cents do último valor mostrado, mantém pitch class
const HYSTERESIS_CENTS = 30;

// ─── Camada 1: Provisional (RESPOSTA IMEDIATA) ─────────────────────────────
const PROV_MIN_MS = 500;            // ↓ 1200 → 500ms (mostra rápido!)
const PROV_MIN_SAMPLES = 3;         // ↓ 6 → 3
const PROV_MIN_UNIQUE = 2;          // ↓ 3 → 2 notas distintas já basta
const PROV_MIN_CONFIDENCE = 0.40;   // ↓ 0.50 → 0.40 (mais permissivo)

// ─── Camada 2: Confirmed ───────────────────────────────────────────────────
const CONF_MIN_MS = 4000;           // ↓ 5000 → 4000
const CONF_MIN_UNIQUE = 4;          // ↓ 5 → 4
const CONF_MIN_CONFIDENCE = 0.70;   // ↓ 0.75 → 0.70
const CONF_CONFIRM_FRAMES = 4;      // ↓ 5 → 4

// ─── Shadow tracking — DUAL MODE ─────────────────────────────────────────
// Valores controlados pelo modo escolhido pelo usuário (live/stable)
const SHADOW_MIN_FRAMES_LIVE = 5;   // ~1.25s
const SHADOW_MIN_FRAMES_STABLE = 8; // ~2.0s
const SHADOW_MARGIN = 0.08;         // candidato precisa estar X% acima do atual
const SHADOW_CURRENT_WEAKENING = 0.68;

// ─── Confirmação de mudança (após SHADOW sugerir) ─────────────────────────
const CHANGE_EXTRA_CONFIRM_FRAMES_LIVE = 3;   // +0.75s → total ~2s
const CHANGE_EXTRA_CONFIRM_FRAMES_STABLE = 6; // +1.5s → total ~3.5s
const CHANGE_MIN_CONFIDENCE = 0.65;

// ─── Pesos do histograma (recalibrados após bug E major → A minor) ────────
const HISTOGRAM_DECAY = 2.0;
const REPETITION_BOOST = 2.5;       // ↓ 4.0 → 2.5 (menos viés por repetição)
const DURATION_BOOST = 1.5;         // ↓ 2.5 → 1.5
const CADENCE_BOOST = 1.3;          // ↓ 1.8 → 1.3 (últimas 3 notas)
const TONIC_SUSTAIN_BOOST = 1.5;    // ↓ 2.5 → 1.5 (CORRIGE bug E major vs A minor)

// ─── UX ───────────────────────────────────────────────────────────────────
const NOTE_DISPLAY_HOLD_MS = 60;    // ↓ 180 → 60ms (tempo real de verdade)
const SILENCE_HINT_MS = 8000;
const SILENCE_RETRY_MS = 20000;

interface NoteEvent {
  pitchClass: number;
  timestamp: number;
  rms: number;
  runLength: number;
}

export type DetectionState =
  | 'idle'
  | 'listening'
  | 'analyzing'
  | 'provisional'
  | 'confirmed'
  | 'change_possible';

export type KeyTier = 'provisional' | 'confirmed' | null;

export type DetectionMode = 'live' | 'stable';

export interface UseKeyDetectionReturn {
  detectionState: DetectionState;
  currentKey: KeyResult | null;
  keyTier: KeyTier;
  liveConfidence: number;
  changeSuggestion: KeyResult | null;
  currentNote: number | null;
  recentNotes: number[];
  audioLevel: number;
  isStable: boolean;
  statusMessage: string;
  isRunning: boolean;
  isSupported: boolean;
  errorMessage: string | null;
  errorReason: PitchErrorReason | null;
  softInfo: string | null;
  mode: DetectionMode;
  setMode: (m: DetectionMode) => void;
  start: () => Promise<boolean>;
  stop: () => void;
  reset: () => void;
}

export function useKeyDetection(): UseKeyDetectionReturn {
  const [detectionState, setDetectionState] = useState<DetectionState>('idle');
  const [currentKey, setCurrentKey] = useState<KeyResult | null>(null);
  const [keyTier, setKeyTier] = useState<KeyTier>(null);
  const [liveConfidence, setLiveConfidence] = useState<number>(0);
  const [changeSuggestion, setChangeSuggestion] = useState<KeyResult | null>(null);
  const [currentNote, setCurrentNote] = useState<number | null>(null);
  const [recentNotes, setRecentNotes] = useState<number[]>([]);
  const [audioLevel, setAudioLevel] = useState<number>(0); // 0..1 (RMS normalizado) p/ visualizer
  const [isStable, setIsStable] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Pronto para detectar');
  const [isRunning, setIsRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorReason, setErrorReason] = useState<PitchErrorReason | null>(null);
  const [softInfo, setSoftInfo] = useState<string | null>(null);
  const [mode, setModeState] = useState<DetectionMode>('live');

  const noteHistory = useRef<NoteEvent[]>([]);
  const freqBuffer = useRef<number[]>([]);
  const currentKeyRef = useRef<KeyResult | null>(null);
  const currentTierRef = useRef<KeyTier>(null);
  const changeSuggestionRef = useRef<KeyResult | null>(null);
  const modeRef = useRef<DetectionMode>('live');

  const setMode = useCallback((m: DetectionMode) => {
    modeRef.current = m;
    setModeState(m);
  }, []);

  // Contadores para máquina de estados
  const confirmRef = useRef<{ root: number; quality: string; count: number } | null>(null);
  // Shadow tracking: candidato alternativo silencioso
  const shadowRef = useRef<{ root: number; quality: string; count: number; avgConf: number } | null>(null);
  // Depois que o shadow "vira público", este conta frames até confirmação
  const changeRef = useRef<{ root: number; quality: string; count: number } | null>(null);

  const sessionStartRef = useRef<number>(0);
  const lastValidPitchAtRef = useRef<number>(0);
  const silenceHintShownRef = useRef<boolean>(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isRunningRef = useRef(false);
  const lastPitchRef = useRef<number | null>(null);
  const lastMidiRef = useRef<number | null>(null); // MIDI EMA para histerese anti-vibrato
  const noteDisplayRef = useRef<{ pc: number; setAt: number } | null>(null);
  const isStartingRef = useRef(false);
  const lastRecentUpdateRef = useRef<number>(0);
  const audioLevelRef = useRef<number>(0); // escrito em onPitch, drenado por analyzeKey

  const engine = usePitchEngine();
  const engineRef = useRef(engine);
  engineRef.current = engine;

  useEffect(() => {
    if (engine.setSoftInfoHandler) {
      engine.setSoftInfoHandler((msg: string) => setSoftInfo(msg));
    }
  }, [engine]);

  const isSupported = engine.isSupported;

  // ── onPitch ─────────────────────────────────────────────────────────────
  const onPitch = useCallback((e: PitchEvent) => {
    if (!isRunningRef.current) return;

    // SEMPRE registrar o nível de áudio (mesmo antes de passar filtros),
    // para o visualizer da UI mostrar que o mic está captando.
    // EMA suave para não oscilar demais
    const normLevel = Math.min(1, e.rms * 8); // 0..1 (8× ganho para visualização)
    audioLevelRef.current = audioLevelRef.current * 0.6 + normLevel * 0.4;

    if (e.rms < MIN_RMS || e.clarity < MIN_CLARITY) return;

    const now = Date.now();
    lastValidPitchAtRef.current = now;
    silenceHintShownRef.current = false;

    freqBuffer.current.push(e.frequency);
    if (freqBuffer.current.length > FREQ_SMOOTH_WINDOW) freqBuffer.current.shift();
    const sortedFreqs = [...freqBuffer.current].sort((a, b) => a - b);
    const medianFreq = sortedFreqs[Math.floor(sortedFreqs.length / 2)];
    const currentMidi = frequencyToMidi(medianFreq);
    let pc = midiToPitchClass(currentMidi);

    // ── Histerese anti-vibrato ─────────────────────────────────────────────
    // Se a variação em cents desde a última nota exibida < 30, mantém a nota
    // atual (evita troca de pitch class por oscilação vocal/vibrato).
    if (lastPitchRef.current !== null && lastMidiRef.current !== null) {
      const centsDelta = Math.abs(currentMidi - lastMidiRef.current) * 100;
      if (centsDelta < HYSTERESIS_CENTS && pc !== lastPitchRef.current) {
        pc = lastPitchRef.current as typeof pc;
      }
    }

    // EMA do MIDI (suaviza "centro" da nota sustentada)
    lastMidiRef.current =
      lastMidiRef.current === null
        ? currentMidi
        : lastMidiRef.current * 0.6 + currentMidi * 0.4;

    let runLength = 1;
    if (lastPitchRef.current === pc) {
      const last = noteHistory.current[noteHistory.current.length - 1];
      if (last && last.pitchClass === pc) runLength = last.runLength + 1;
    }
    lastPitchRef.current = pc;

    noteHistory.current.push({
      pitchClass: pc,
      timestamp: now,
      rms: e.rms,
      runLength,
    });

    // ── DISPLAY RÁPIDO: setCurrentNote quase instantâneo ──────────────────
    // Hold de 60ms apenas para evitar flood de re-renders em hardware fraco
    const disp = noteDisplayRef.current;
    if (!disp || now - disp.setAt >= NOTE_DISPLAY_HOLD_MS) {
      noteDisplayRef.current = { pc, setAt: now };
      setCurrentNote(pc);
    }

    if (now - lastRecentUpdateRef.current >= 180) {
      lastRecentUpdateRef.current = now;
      const all = noteHistory.current.slice(-60).map(n => n.pitchClass);
      const dedup: number[] = [];
      for (const p of all) {
        if (dedup.length === 0 || dedup[dedup.length - 1] !== p) dedup.push(p);
      }
      setRecentNotes(dedup.slice(-8));
    }
  }, []);

  const onEngineError = useCallback((msg: string, reason?: PitchErrorReason) => {
    console.log('[KeyDetection][ERRO]', msg, reason);
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

  // ── Histograma com pesos MUSICAIS (baseado em NOTE EVENTS) ──────────────
  // Agrupa frames consecutivos de mesma pitch class em "events" (notas musicais).
  // Cada evento contribui UMA VEZ ao histograma, com peso = duração × rms_médio.
  // Isso evita que notas sustentadas inflem artificialmente o histograma.
  const buildHistogram = useCallback((history: NoteEvent[], now: number): number[] => {
    const histogram = new Array(12).fill(0);
    const uniqueCount = new Array(12).fill(0);
    // Usando array-box para evitar problema de type narrowing do TS
    const sustainedBox: Array<{ pc: number; frames: number }> = [];
    let lastPc: number | null = null;
    let eventStart = 0;
    let eventEnd = 0;
    let eventRmsSum = 0;
    let eventFrameCount = 0;

    function commit() {
      if (lastPc === null || eventFrameCount < 2) return;
      const durMs = eventEnd - eventStart + 128;
      const rmsAvg = eventRmsSum / eventFrameCount;
      const age = (now - eventEnd) / HISTORY_MS;
      const decay = Math.exp(-HISTOGRAM_DECAY * age);
      const weight = Math.sqrt(durMs / 500) * rmsAvg * decay;
      histogram[lastPc] += weight;
      uniqueCount[lastPc] += 1;
      if (eventFrameCount >= 4) {
        sustainedBox.length = 0;
        sustainedBox.push({ pc: lastPc, frames: eventFrameCount });
      }
    }

    for (const n of history) {
      if (n.pitchClass !== lastPc) {
        commit();
        lastPc = n.pitchClass;
        eventStart = n.timestamp;
        eventEnd = n.timestamp;
        eventRmsSum = n.rms;
        eventFrameCount = 1;
      } else {
        eventEnd = n.timestamp;
        eventRmsSum += n.rms;
        eventFrameCount++;
      }
    }
    commit(); // flush final

    // ── Boost por diversidade: se nota apareceu em MÚLTIPLOS eventos distintos,
    //    é mais provável ser nota da escala (não apenas sustain random)
    for (let i = 0; i < 12; i++) {
      if (uniqueCount[i] >= 2) histogram[i] *= 1.0 + Math.log1p(uniqueCount[i]) * 0.3;
    }

    // ── Cadência: últimas ~2 notas distintas ganham peso extra ──
    // Notas finais definem tonalidade (ex: "fim de frase na tônica")
    const recentUnique: number[] = [];
    for (let i = history.length - 1; i >= 0 && recentUnique.length < 2; i--) {
      const pc = history[i].pitchClass;
      if (!recentUnique.includes(pc)) recentUnique.push(pc);
    }
    for (const pc of recentUnique) {
      histogram[pc] *= CADENCE_BOOST;
    }

    // ── Tônica sustentada: boost LEVE (já contido pelo sqrt acima) ──
    if (sustainedBox.length > 0) {
      histogram[sustainedBox[0].pc] *= 1.15;
    }

    return histogram;
  }, []);

  // ── analyzeKey: máquina de estados com shadow tracking ──────────────────
  const analyzeKey = useCallback(() => {
    if (!isRunningRef.current) return;

    // Resolver parâmetros conforme modo atual
    const SHADOW_MIN_FRAMES =
      modeRef.current === 'live' ? SHADOW_MIN_FRAMES_LIVE : SHADOW_MIN_FRAMES_STABLE;
    const CHANGE_EXTRA_CONFIRM_FRAMES =
      modeRef.current === 'live'
        ? CHANGE_EXTRA_CONFIRM_FRAMES_LIVE
        : CHANGE_EXTRA_CONFIRM_FRAMES_STABLE;

    const now = Date.now();
    noteHistory.current = noteHistory.current.filter(n => n.timestamp >= now - HISTORY_MS);

    // Drena audio level para o state (sincroniza UI do visualizer)
    setAudioLevel(audioLevelRef.current);

    const fullHistory = noteHistory.current;
    const recentHistory = fullHistory.filter(n => n.timestamp >= now - RECENT_WINDOW_MS);
    const elapsed = now - sessionStartRef.current;
    const uniqueNotes = new Set(fullHistory.map(h => h.pitchClass)).size;
    const hasKey = !!currentKeyRef.current;
    const tier = currentTierRef.current;

    const timeSinceLastPitch = now - lastValidPitchAtRef.current;
    const everHadPitch = lastValidPitchAtRef.current > 0;

    // ── Silence ──
    if (!hasKey && everHadPitch && timeSinceLastPitch > SILENCE_RETRY_MS) {
      setStatusMessage('Sem áudio — verifique o microfone');
      setDetectionState('listening');
      return;
    }
    if (!hasKey && !everHadPitch && elapsed > SILENCE_HINT_MS && !silenceHintShownRef.current) {
      silenceHintShownRef.current = true;
      setSoftInfo('Cante ou toque uma nota próximo ao microfone');
    }

    if (!hasKey && fullHistory.length < 3) {
      setDetectionState('listening');
      setStatusMessage('Ouvindo...');
      return;
    }

    const histogram = buildHistogram(fullHistory, now);
    const result = detectKeyFromHistogram(histogram);
    const conf = Math.max(0, result.confidence);
    setLiveConfidence(conf);

    // ═════════════════════════════════════════════════════════════════════
    // Sem tom ainda → tentar PROVISIONAL rápido
    // ═════════════════════════════════════════════════════════════════════
    if (!hasKey) {
      const readyForProv =
        elapsed >= PROV_MIN_MS &&
        fullHistory.length >= PROV_MIN_SAMPLES &&
        uniqueNotes >= PROV_MIN_UNIQUE &&
        conf >= PROV_MIN_CONFIDENCE;

      if (!readyForProv) {
        setDetectionState('analyzing');
        if (fullHistory.length < PROV_MIN_SAMPLES) {
          setStatusMessage('Ouvindo...');
        } else if (uniqueNotes < PROV_MIN_UNIQUE) {
          setStatusMessage(`Analisando tonalidade... (${uniqueNotes}/${PROV_MIN_UNIQUE} notas)`);
        } else {
          const pct = Math.round(conf * 100);
          setStatusMessage(`Analisando tonalidade... (${pct}%)`);
        }
        return;
      }

      currentKeyRef.current = { ...result };
      currentTierRef.current = 'provisional';
      confirmRef.current = { root: result.root, quality: result.quality, count: 1 };
      setCurrentKey({ ...result });
      setKeyTier('provisional');
      setDetectionState('provisional');
      setIsStable(false);
      const { noteBr, qualityLabel } = formatKeyDisplay(result.root, result.quality as 'major' | 'minor');
      setStatusMessage(`Tom provável: ${noteBr} ${qualityLabel}`);
      return;
    }

    // ═════════════════════════════════════════════════════════════════════
    // JÁ TEM TOM → refinamento / shadow tracking / confirmação
    // ═════════════════════════════════════════════════════════════════════
    const cur = currentKeyRef.current!;
    const isSameAsCurrent = cur.root === result.root && cur.quality === result.quality;

    currentKeyRef.current = { ...cur, confidence: conf };
    setCurrentKey({ ...cur, confidence: conf });

    // ── Provisional: troca mais fácil (ainda não estava firme) ──
    // Usa lógica simples de 3 frames
    if (tier === 'provisional') {
      if (isSameAsCurrent) {
        const cr = confirmRef.current;
        if (!cr || cr.root !== cur.root || cr.quality !== cur.quality) {
          confirmRef.current = { root: cur.root, quality: cur.quality, count: 1 };
        } else {
          cr.count++;
        }

        // Promover para CONFIRMED
        if (
          elapsed >= CONF_MIN_MS &&
          uniqueNotes >= CONF_MIN_UNIQUE &&
          conf >= CONF_MIN_CONFIDENCE &&
          confirmRef.current!.count >= CONF_CONFIRM_FRAMES
        ) {
          currentTierRef.current = 'confirmed';
          setKeyTier('confirmed');
          setDetectionState('confirmed');
          setIsStable(true);
          setStatusMessage('Estável no tom atual');
          shadowRef.current = null; // reset shadow
          return;
        }

        setDetectionState('provisional');
        const pct = Math.round(conf * 100);
        const { noteBr, qualityLabel } = formatKeyDisplay(cur.root, cur.quality as 'major' | 'minor');
        setStatusMessage(`Refinando: ${noteBr} ${qualityLabel} (${pct}%)`);
        return;
      } else {
        // Em provisional, se detectou OUTRO tom com conf razoável 3x → troca
        const ch = changeRef.current;
        if (!ch || ch.root !== result.root || ch.quality !== result.quality) {
          changeRef.current = { root: result.root, quality: result.quality, count: 1 };
        } else {
          ch.count++;
        }
        if (changeRef.current!.count >= 3 && conf >= PROV_MIN_CONFIDENCE) {
          currentKeyRef.current = { ...result };
          confirmRef.current = { root: result.root, quality: result.quality, count: 1 };
          changeRef.current = null;
          setCurrentKey({ ...result });
          setDetectionState('provisional');
          const { noteBr, qualityLabel } = formatKeyDisplay(result.root, result.quality as 'major' | 'minor');
          setStatusMessage(`Tom provável: ${noteBr} ${qualityLabel}`);
          return;
        }
        setDetectionState('provisional');
        const pct = Math.round(conf * 100);
        const { noteBr, qualityLabel } = formatKeyDisplay(cur.root, cur.quality as 'major' | 'minor');
        setStatusMessage(`Refinando: ${noteBr} ${qualityLabel} (${pct}%)`);
        return;
      }
    }

    // ═════════════════════════════════════════════════════════════════════
    // TIER === 'confirmed' → SHADOW TRACKING OCULTO
    // ═════════════════════════════════════════════════════════════════════
    if (isSameAsCurrent) {
      // Tom atual se reforça → reset shadow + change suggestion
      shadowRef.current = null;
      if (changeSuggestionRef.current) {
        changeSuggestionRef.current = null;
        setChangeSuggestion(null);
      }
      changeRef.current = null;
      setDetectionState('confirmed');
      setIsStable(true);
      setStatusMessage('Estável no tom atual');
      return;
    }

    // ── Análise oculta: usar JANELA RECENTE (4s) para capturar mudanças ──
    let candidateKey = result;
    if (recentHistory.length >= 6) {
      const recentHist = buildHistogram(recentHistory, now);
      const recentResult = detectKeyFromHistogram(recentHist);
      if (recentResult.confidence > 0.50) {
        candidateKey = recentResult;
      }
    }
    const candidateSameAsCurrent =
      candidateKey.root === cur.root && candidateKey.quality === cur.quality;

    if (candidateSameAsCurrent) {
      // Candidato recente = tom atual → reset shadow
      shadowRef.current = null;
      if (changeSuggestionRef.current) {
        changeSuggestionRef.current = null;
        setChangeSuggestion(null);
      }
      changeRef.current = null;
      setDetectionState('confirmed');
      setIsStable(true);
      setStatusMessage('Estável no tom atual');
      return;
    }

    // ── SHADOW: candidato diferente — trackear silenciosamente ──
    const sh = shadowRef.current;
    const candConf = Math.max(0, candidateKey.confidence);
    if (!sh || sh.root !== candidateKey.root || sh.quality !== candidateKey.quality) {
      shadowRef.current = {
        root: candidateKey.root,
        quality: candidateKey.quality,
        count: 1,
        avgConf: candConf,
      };
      // Não mostra nada — só continua
      setDetectionState('confirmed');
      setIsStable(true);
      setStatusMessage('Estável no tom atual');
      return;
    }

    // Incrementa shadow + atualiza média móvel de confiança
    sh.count++;
    sh.avgConf = sh.avgConf * 0.7 + candConf * 0.3;

    // ── Critérios para EXPOR o shadow ao usuário ──
    const currentWeakening = conf < SHADOW_CURRENT_WEAKENING;
    const marginOk = sh.avgConf >= conf + SHADOW_MARGIN;
    const framesOk = sh.count >= SHADOW_MIN_FRAMES;

    if (!framesOk || !marginOk || !currentWeakening) {
      // Ainda não é forte o suficiente — NADA visível ao usuário
      setDetectionState('confirmed');
      setIsStable(true);
      setStatusMessage('Estável no tom atual');
      return;
    }

    // ── SHADOW ESTÁ MADURO: mostrar "Possível mudança" ──
    if (
      !changeSuggestionRef.current ||
      changeSuggestionRef.current.root !== candidateKey.root ||
      changeSuggestionRef.current.quality !== candidateKey.quality
    ) {
      changeSuggestionRef.current = { ...candidateKey };
      setChangeSuggestion({ ...candidateKey });
      changeRef.current = { root: candidateKey.root, quality: candidateKey.quality, count: 1 };
    } else {
      const cr = changeRef.current;
      if (!cr || cr.root !== candidateKey.root || cr.quality !== candidateKey.quality) {
        changeRef.current = { root: candidateKey.root, quality: candidateKey.quality, count: 1 };
      } else {
        cr.count++;
      }
    }

    const cr2 = changeRef.current!;

    // ── Confirmar mudança? ──
    if (cr2.count >= CHANGE_EXTRA_CONFIRM_FRAMES && sh.avgConf >= CHANGE_MIN_CONFIDENCE) {
      // COMMIT
      currentKeyRef.current = { ...candidateKey };
      currentTierRef.current = 'confirmed';
      confirmRef.current = { root: candidateKey.root, quality: candidateKey.quality, count: 1 };
      shadowRef.current = null;
      changeRef.current = null;
      changeSuggestionRef.current = null;
      setCurrentKey({ ...candidateKey });
      setChangeSuggestion(null);
      setDetectionState('confirmed');
      setIsStable(false);
      const { noteBr, qualityLabel } = formatKeyDisplay(candidateKey.root, candidateKey.quality as 'major' | 'minor');
      setStatusMessage(`Tom alterado para ${noteBr} ${qualityLabel}`);
      setTimeout(() => {
        if (isRunningRef.current && currentKeyRef.current?.root === candidateKey.root) {
          setIsStable(true);
          setStatusMessage('Estável no tom atual');
        }
      }, 1800);
      return;
    }

    // Ainda aguardando confirmação final
    setDetectionState('change_possible');
    setIsStable(false);
    const { noteBr, qualityLabel } = formatKeyDisplay(candidateKey.root, candidateKey.quality as 'major' | 'minor');
    const totalNeeded = SHADOW_MIN_FRAMES + CHANGE_EXTRA_CONFIRM_FRAMES;
    const progress = Math.min(totalNeeded, sh.count + cr2.count);
    setStatusMessage(`Possível mudança tonal: ${noteBr} ${qualityLabel}... (${progress}/${totalNeeded})`);
  }, [buildHistogram]);

  // ── start ──────────────────────────────────────────────────────────────
  const start = useCallback(async (): Promise<boolean> => {
    if (isStartingRef.current) return false;
    isStartingRef.current = true;
    try {
      setErrorMessage(null);
      setErrorReason(null);
      setSoftInfo(null);

      if (isRunningRef.current) {
        isRunningRef.current = false;
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        await engineRef.current?.stop();
      } else {
        await engineRef.current?.stop();
      }

      noteHistory.current = [];
      freqBuffer.current = [];
      currentKeyRef.current = null;
      currentTierRef.current = null;
      changeSuggestionRef.current = null;
      confirmRef.current = null;
      changeRef.current = null;
      shadowRef.current = null;
      lastPitchRef.current = null;
      lastMidiRef.current = null;
      audioLevelRef.current = 0;
      setAudioLevel(0);
      noteDisplayRef.current = null;
      lastValidPitchAtRef.current = 0;
      silenceHintShownRef.current = false;
      sessionStartRef.current = Date.now();
      isRunningRef.current = true;
      setIsRunning(true);
      setDetectionState('listening');
      setCurrentKey(null);
      setKeyTier(null);
      setLiveConfidence(0);
      setChangeSuggestion(null);
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

  const stop = useCallback(() => {
    isRunningRef.current = false;
    setIsRunning(false);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    engineRef.current?.stop().catch(() => {});
    noteHistory.current = [];
    freqBuffer.current = [];
    setDetectionState('idle');
    setCurrentNote(null);
    setRecentNotes([]);
    setIsStable(false);
    setStatusMessage('Pronto para detectar');
  }, []);

  const reset = useCallback(() => {
    stop();
    currentKeyRef.current = null;
    currentTierRef.current = null;
    changeSuggestionRef.current = null;
    setCurrentKey(null);
    setKeyTier(null);
    setLiveConfidence(0);
    setChangeSuggestion(null);
    setErrorMessage(null);
  }, [stop]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'background' && isRunningRef.current) stop();
    });
    return () => sub.remove();
  }, [stop]);

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
    keyTier,
    liveConfidence,
    changeSuggestion,
    currentNote,
    recentNotes,
    audioLevel,
    isStable,
    statusMessage,
    isRunning,
    isSupported,
    errorMessage,
    errorReason,
    softInfo,
    mode,
    setMode,
    start,
    stop,
    reset,
  };
}
