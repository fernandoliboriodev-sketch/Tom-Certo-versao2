// ═══════════════════════════════════════════════════════════════════════
// tonicAnchor.ts — Âncora Global de Tônica (Gravidade Tonal)
// ═══════════════════════════════════════════════════════════════════════
// Resolve o problema de "deriva tonal": o sistema detecta corretamente,
// mas migra para V, IV, vi ou relativo ao longo do tempo.
//
// Modelo: em vez de depender só de histograma/scorer locais (que são
// reativos a padrões momentâneos), mantemos uma memória de LONGO PRAZO
// por pitch class, com DECAY MUITO LENTO (0.98 vs 0.93 do scorer).
//
// Finais de frase pesam 8× porque a cadência é o sinal mais confiável
// de tônica. Notas longas, estáveis e recorrentes também acumulam.
//
// A gravidade é usada como MULTIPLICADOR no ranking:
//   effectiveScore(tonicCandidate) = score × alignmentScore(tonic, gravity)
//
// Pesos por função harmônica no alignmentScore:
//   tônica (I):    70%   ← peso máximo
//   dominante (V): 20%   ← forte, mas não vence sozinho
//   subdominante (IV): 10%
// Isso garante que V (ex: Dó# em F# Maior) não consiga superar I (F#)
// só porque apareceu em cadências de frases internas.
// ═══════════════════════════════════════════════════════════════════════

import type { Phrase } from './phraseKeyDetector';

// ── Parâmetros do decay + pesos ─────────────────────────────────────
export const ANCHOR_DECAY = 0.98;           // 15-20s de memória
export const W_END_PHRASE = 8.0;            // cadência = evidência máxima de tônica
export const W_LONG_NOTE = 3.0;             // bonus para notas ≥ 400ms
export const W_DURATION_PER_MS = 0.003;     // acumulador por ms cantado
export const W_RECURRENCE = 1.5;            // bonus quando pc JÁ tinha peso (recorrência)
export const W_STABILITY = 2.0;             // bonus para notas com RMS consistente

export const LONG_NOTE_MS = 400;
export const STABLE_NOTE_MIN_DUR_MS = 250;
export const STABLE_NOTE_MIN_RMS = 0.08;
export const RECURRENCE_MIN_PRIOR_WEIGHT = 1.5;

// ── Pesos por função harmônica no alignment ─────────────────────────
export const ALIGN_W_TONIC = 0.70;
export const ALIGN_W_FIFTH = 0.20;
export const ALIGN_W_FOURTH = 0.10;

// ── Threshold mínimo de gravity acumulada pra aplicar alignment ─────
// Antes disso, alignment retorna 0.5 (neutro) pra não penalizar a 1ª frase.
export const MIN_GRAVITY_FOR_ALIGNMENT = 8.0;

// ── Graus diatônicos (intervalos em semitons) ───────────────────────
// Usado pelo guard "anti-subset": se o novo candidato é grau da tônica
// atual, exigimos evidência forte de troca.
export const DIATONIC_DEGREES_MAJOR = [2, 4, 5, 7, 9, 11]; // ii, iii, IV, V, vi, vii°
export const DIATONIC_DEGREES_MINOR = [2, 3, 5, 7, 8, 10]; // ii°, III, iv, v, VI, VII

// ── Estado da âncora (serializável) ─────────────────────────────────
export interface TonicAnchor {
  gravity: number[];        // [12] acumulador de gravidade tonal
  ingestedPhrases: number;
  lastPhraseEnding: number | null;
}

export function createAnchor(): TonicAnchor {
  return {
    gravity: new Array(12).fill(0),
    ingestedPhrases: 0,
    lastPhraseEnding: null,
  };
}

// ── Atualização da âncora com uma nova frase ────────────────────────
export function ingestPhraseAnchor(state: TonicAnchor, phrase: Phrase): TonicAnchor {
  // 1) Decay lento
  const g = state.gravity.map(v => v * ANCHOR_DECAY);

  // 2) Peso forte no FINAL DE FRASE (cadência)
  if (phrase.lastSustainedPc !== null) {
    g[phrase.lastSustainedPc] += W_END_PHRASE;
  }

  // 3) Por nota: duração + bonus de nota longa + bonus de estabilidade
  const seenPcs = new Set<number>();
  for (const note of phrase.notes) {
    seenPcs.add(note.pitchClass);
    g[note.pitchClass] += W_DURATION_PER_MS * note.durMs;
    if (note.durMs >= LONG_NOTE_MS) {
      g[note.pitchClass] += W_LONG_NOTE;
    }
    if (note.durMs >= STABLE_NOTE_MIN_DUR_MS && note.rmsAvg >= STABLE_NOTE_MIN_RMS) {
      g[note.pitchClass] += W_STABILITY;
    }
  }

  // 4) Recorrência: pcs que já tinham peso significativo ganham reforço
  //    (padrão musical consistente = recorrência)
  for (const pc of seenPcs) {
    if (state.gravity[pc] >= RECURRENCE_MIN_PRIOR_WEIGHT) {
      g[pc] += W_RECURRENCE;
    }
  }

  return {
    gravity: g,
    ingestedPhrases: state.ingestedPhrases + 1,
    lastPhraseEnding: phrase.lastSustainedPc,
  };
}

// ── Alinhamento: quão bem uma tônica candidata casa com a gravity ───
// Retorna 0..1. Tônica pesa 70%, 5ª 20%, 4ª 10%.
// Antes da 1ª frase (gravity fraca), retorna 0.5 (neutro).
export function alignmentScore(
  candidateTonic: number,
  anchor: TonicAnchor
): number {
  const maxG = Math.max(...anchor.gravity, 1e-9);
  const sumG = anchor.gravity.reduce((a, v) => a + v, 0);
  if (sumG < MIN_GRAVITY_FOR_ALIGNMENT) return 0.5; // neutro nas primeiras frases

  const norm = anchor.gravity.map(g => g / maxG);
  const tonic = norm[candidateTonic];
  const fifth = norm[(candidateTonic + 7) % 12];
  const fourth = norm[(candidateTonic + 5) % 12];

  const score =
    ALIGN_W_TONIC * tonic +
    ALIGN_W_FIFTH * fifth +
    ALIGN_W_FOURTH * fourth;

  return Math.min(1, Math.max(0, score));
}

// ── Boost multiplicativo pra ser aplicado a scores/tally ────────────
// factor ∈ [0.4, 1.0]: tônicas sem gravity perdem até 60% do peso;
// tônicas alinhadas preservam o score integral.
export function alignmentBoost(
  candidateTonic: number,
  anchor: TonicAnchor
): number {
  const a = alignmentScore(candidateTonic, anchor);
  return 0.4 + 0.6 * a; // 0.5 (neutro) → 0.7; 1.0 → 1.0; 0.0 → 0.4
}

// ── Guard anti-grau-diatônico ───────────────────────────────────────
// Retorna true se o "candidato" é um grau diatônico da "tônica atual"
// (V, IV, vi, ii, iii, vii°), considerando qualidade conhecida.
// Se qualidade é null, assume major (mais permissivo).
export function isDiatonicDegreeOf(
  candidate: number,
  currentTonic: number,
  currentQuality: 'major' | 'minor' | null
): boolean {
  if (candidate === currentTonic) return false;
  const interval = (candidate - currentTonic + 12) % 12;
  const degrees = currentQuality === 'minor'
    ? DIATONIC_DEGREES_MINOR
    : DIATONIC_DEGREES_MAJOR;
  return degrees.includes(interval);
}

// ── Margem mínima de gravity pra trocar de tônica ───────────────────
// Se o candidato é grau diatônico da atual, exige que ele tenha
// gravity >= 1.3× da tônica atual. Se não é diatônico (= outro campo),
// exige gravity >= 1.1× (é mais permissivo).
export function requiredGravityMargin(
  candidate: number,
  currentTonic: number | null,
  currentQuality: 'major' | 'minor' | null
): number {
  if (currentTonic === null) return 1.0;
  return isDiatonicDegreeOf(candidate, currentTonic, currentQuality) ? 1.3 : 1.1;
}
