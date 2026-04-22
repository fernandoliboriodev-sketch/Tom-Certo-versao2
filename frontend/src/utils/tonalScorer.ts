// ═════════════════════════════════════════════════════════════════════════
// tonalScorer.ts v2 — Scoring tonal contextual (complementa phraseKeyDetector)
// ═════════════════════════════════════════════════════════════════════════
// NOVIDADES v2:
//   • Perfil Krumhansl-Schmuckler (correlação de Pearson) — discrimina
//     tonalidades relativas (ex: Ré Maior vs Si menor) mesmo com notas
//     idênticas, porque o PERFIL TÍPICO de distribuição é diferente.
//   • Nova fórmula de score, com MENOS peso em aderência (inútil pra
//     relativas) e MAIS peso em perfil + resolução de frase.
//   • Tiebreaker específico para pares relativos: ignora aderência
//     (que é idêntica) e usa apenas cadência + frequência da tônica.
//
// FÓRMULA v2:
//   score = 0.15 × aderenciaEscala
//         + 0.30 × perfilKrumhansl        ← PRINCIPAL DISCRIMINADOR
//         + 0.30 × resolucaoFrase          ← ÂNCORA TONAL FORTE
//         + 0.15 × forcaTonica
//         + 0.10 × estabilidadeTemporal
//         - 0.20 × penalidadeNotasFora
//
// Rodada para CADA candidato (24 = 12 tônicas × maj/min). O vencedor é
// comparado com o vencedor do phrase-voting. Se concordam → confiança alta.
// ═════════════════════════════════════════════════════════════════════════

import type { Phrase } from './phraseKeyDetector';

// ── Escalas diatônicas (7 notas) ──────────────────────────────────
const MAJOR_INTERVALS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_INTERVALS = [0, 2, 3, 5, 7, 8, 10]; // natural minor

// ── Perfis Krumhansl-Schmuckler (1990) ────────────────────────────
// Derivados de experimentos perceptivos: indicam quanta ênfase CADA grau
// recebe em percepção humana de tonalidade maior/menor. A correlação de
// Pearson entre histograma observado × perfil rotacionado ESPELHA a
// tonalidade percebida.
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// ── Amostra temporal (item do buffer deslizante) ──────────────────
export interface NoteSample {
  pitchClass: number;   // 0..11
  durMs: number;        // duração sustentada
  stability: number;    // 0..1 — quão estável foi (frames concordaram)
  timestamp: number;    // ms desde início
}

// ── Buffer deslizante (últimos 3-6s) ──────────────────────────────
export class TemporalBuffer {
  private samples: NoteSample[] = [];
  private windowMs: number;

  constructor(windowMs = 5000) { this.windowMs = windowMs; }

  push(sample: NoteSample) {
    this.samples.push(sample);
    const cutoff = sample.timestamp - this.windowMs;
    this.samples = this.samples.filter(s => s.timestamp >= cutoff);
  }

  getSamples(): NoteSample[] { return this.samples.slice(); }
  clear() { this.samples = []; }
}

// ── Histograma ponderado (duração × estabilidade) ─────────────────
export function buildWeightedHistogram(samples: NoteSample[]): number[] {
  const h = new Array(12).fill(0);
  for (const s of samples) {
    h[s.pitchClass] += s.durMs * s.stability;
  }
  return h;
}

// ── Rotaciona o perfil pelo root ──────────────────────────────────
function rotateProfile(profile: number[], root: number): number[] {
  const out = new Array(12);
  for (let i = 0; i < 12; i++) out[(i + root) % 12] = profile[i];
  return out;
}

// ── Correlação de Pearson ─────────────────────────────────────────
function pearson(a: number[], b: number[]): number {
  const n = a.length;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
  const meanA = sumA / n, meanB = sumB / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  if (den < 1e-9) return 0;
  return num / den;
}

// ── 0) Perfil Krumhansl (−1..1, mapeado para 0..1) ────────────────
// Principal discriminador entre tonalidades RELATIVAS.
// Mesmo com notas idênticas, a distribuição de ênfase distingue
// Ré Maior (peso alto em Ré/Lá) de Si menor (peso alto em Si/Fá#).
function perfilKrumhansl(hist: number[], root: number, quality: 'major' | 'minor'): number {
  const profile = rotateProfile(quality === 'major' ? KS_MAJOR : KS_MINOR, root);
  const r = pearson(hist, profile);
  // Pearson ∈ [-1, 1] → normaliza pra [0, 1] com piso
  return Math.max(0, (r + 1) / 2);
}

// ── 1) Aderência à escala (0..1) ──────────────────────────────────
// (Kept for legacy — now pesa pouco pois não discrimina relativas.)
function aderenciaEscala(hist: number[], root: number, quality: 'major' | 'minor'): number {
  const intervals = quality === 'major' ? MAJOR_INTERVALS : MINOR_INTERVALS;
  const inScale = new Set(intervals.map(iv => (root + iv) % 12));
  let inSum = 0, totalSum = 0;
  for (let pc = 0; pc < 12; pc++) {
    totalSum += hist[pc];
    if (inScale.has(pc)) inSum += hist[pc];
  }
  return totalSum > 0 ? inSum / totalSum : 0;
}

// ── 2) Força da tônica (0..1) ─────────────────────────────────────
function forcaTonica(hist: number[], root: number): number {
  const maxH = Math.max(...hist, 1e-9);
  const tonic = hist[root] / maxH;
  const fifth = hist[(root + 7) % 12] / maxH;
  return Math.min(1, 0.60 * tonic + 0.40 * fifth);
}

// ── 3) Resolução de frase (0..1) ──────────────────────────────────
// Quantas frases terminaram em `root` (cadência).
function resolucaoFrase(phrases: Phrase[], root: number): number {
  if (phrases.length === 0) return 0;
  let cadCount = 0;
  for (const p of phrases) {
    if (p.lastSustainedPc === root) cadCount++;
  }
  return cadCount / phrases.length;
}

// ── 4) Estabilidade temporal (0..1) ───────────────────────────────
function estabilidadeTemporal(samples: NoteSample[], root: number): number {
  if (samples.length < 4) return 0;
  const mid = Math.floor(samples.length / 2);
  const firstHalf = samples.slice(0, mid);
  const secondHalf = samples.slice(mid);
  const sumRoot = (arr: NoteSample[]) => arr.filter(s => s.pitchClass === root).reduce((a, s) => a + s.durMs * s.stability, 0);
  const sumAll = (arr: NoteSample[]) => arr.reduce((a, s) => a + s.durMs * s.stability, 0);
  const r1 = sumAll(firstHalf) > 0 ? sumRoot(firstHalf) / sumAll(firstHalf) : 0;
  const r2 = sumAll(secondHalf) > 0 ? sumRoot(secondHalf) / sumAll(secondHalf) : 0;
  const diff = Math.abs(r1 - r2);
  return Math.max(0, 1 - diff * 2);
}

// ── 5) Penalidade por notas fora da escala (0..1) ─────────────────
function penalidadeNotasFora(hist: number[], root: number, quality: 'major' | 'minor'): number {
  const intervals = quality === 'major' ? MAJOR_INTERVALS : MINOR_INTERVALS;
  const inScale = new Set(intervals.map(iv => (root + iv) % 12));
  let out = 0, total = 0;
  for (let pc = 0; pc < 12; pc++) {
    total += hist[pc];
    if (!inScale.has(pc)) out += hist[pc];
  }
  return total > 0 ? out / total : 0;
}

// ── SCORE AGREGADO (fórmula v2) ───────────────────────────────────
export interface TonalCandidate {
  root: number;
  quality: 'major' | 'minor';
  score: number;
  breakdown: {
    aderencia: number;
    perfil: number;
    forca: number;
    resolucao: number;
    estabilidade: number;
    penalidade: number;
  };
}

export function scoreKey(
  hist: number[],
  samples: NoteSample[],
  phrases: Phrase[],
  root: number,
  quality: 'major' | 'minor'
): TonalCandidate {
  const aderencia = aderenciaEscala(hist, root, quality);
  const perfil = perfilKrumhansl(hist, root, quality);
  const forca = forcaTonica(hist, root);
  const resolucao = resolucaoFrase(phrases, root);
  const estabilidade = estabilidadeTemporal(samples, root);
  const penalidade = penalidadeNotasFora(hist, root, quality);

  const score =
    0.15 * aderencia +
    0.30 * perfil +
    0.30 * resolucao +
    0.15 * forca +
    0.10 * estabilidade -
    0.20 * penalidade;

  return {
    root,
    quality,
    score,
    breakdown: { aderencia, perfil, forca, resolucao, estabilidade, penalidade },
  };
}

// ── Detecta se dois candidatos formam um par RELATIVO maj/min ─────
// Ex: Ré Maior (root 2, major) e Si menor (root 11, minor) — relativos.
// Regra: minor_root = (major_root + 9) % 12  ⇔  major_root = (minor_root + 3) % 12
export function isRelativePair(a: TonalCandidate, b: TonalCandidate): boolean {
  if (a.quality === b.quality) return false;
  const maj = a.quality === 'major' ? a : b;
  const min = a.quality === 'minor' ? a : b;
  return min.root === (maj.root + 9) % 12;
}

// ── Tiebreaker para par relativo ──────────────────────────────────
// Quando os 2 primeiros candidatos do ranking são um par relativo, a
// aderência é IDÊNTICA (mesmas notas). O desempate deve usar apenas:
//   1) Cadência — frases resolvem na tônica? (peso 0.55)
//   2) Frequência da tônica pura (peso 0.30)
//   3) Força da dominante (peso 0.15)
// Isso evita que a "força de Krumhansl" seja o único critério quando
// as evidências melódicas (cadência) são mais confiáveis perceptivamente.
function relativeTiebreakScore(
  cand: TonalCandidate,
  hist: number[],
  phrases: Phrase[]
): number {
  const resolucao = resolucaoFrase(phrases, cand.root);
  const total = hist.reduce((a, v) => a + v, 0);
  const tonicFreq = total > 0 ? hist[cand.root] / total : 0;
  const fifthFreq = total > 0 ? hist[(cand.root + 7) % 12] / total : 0;
  return 0.55 * resolucao + 0.30 * tonicFreq + 0.15 * fifthFreq;
}

// ── Ranqueia TODOS os 24 candidatos + aplica tiebreaker relativo ──
export function rankAllKeys(
  hist: number[],
  samples: NoteSample[],
  phrases: Phrase[]
): TonalCandidate[] {
  const out: TonalCandidate[] = [];
  for (let r = 0; r < 12; r++) {
    out.push(scoreKey(hist, samples, phrases, r, 'major'));
    out.push(scoreKey(hist, samples, phrases, r, 'minor'));
  }
  out.sort((a, b) => b.score - a.score);

  // Tiebreaker: se top1 e top2 são par relativo E score muito próximo
  // (dentro de 8%), aplica desempate baseado em cadência/tônica pura.
  if (out.length >= 2 && isRelativePair(out[0], out[1])) {
    const top1 = out[0], top2 = out[1];
    const diff = Math.abs(top1.score - top2.score);
    const avg = (top1.score + top2.score) / 2;
    const closenessRatio = avg > 0 ? diff / avg : 1;
    if (closenessRatio < 0.08) {
      const tb1 = relativeTiebreakScore(top1, hist, phrases);
      const tb2 = relativeTiebreakScore(top2, hist, phrases);
      if (tb2 > tb1 + 0.02) {
        // Troca os dois
        out[0] = top2;
        out[1] = top1;
      }
    }
  }

  return out;
}

// ── Comparação com o phrase-voting (CONCORDÂNCIA) ─────────────────
export function agreementMultiplier(
  phraseWinnerRoot: number,
  phraseWinnerQuality: 'major' | 'minor',
  scoringWinner: TonalCandidate
): number {
  const rootsMatch = phraseWinnerRoot === scoringWinner.root;
  const qualitiesMatch = phraseWinnerQuality === scoringWinner.quality;
  if (rootsMatch && qualitiesMatch) return 1.0;
  if (rootsMatch) return 0.60;
  return 0.30;
}

// ── Proteção "top-3" (v3) ─────────────────────────────────────────
// Verifica se a tônica do phrase-voting está entre os top-3 candidatos
// do scorer. Se SIM, significa que a tônica ainda é "razoavelmente certa"
// — mesmo que não seja o #1, não deve ser descartada. Isso evita que um
// grau diatônico forte momentâneo (ex: V ou ii) puxe a confiança pra baixo.
export function isInTop3(
  phraseWinnerRoot: number,
  phraseWinnerQuality: 'major' | 'minor',
  rankedCandidates: TonalCandidate[]
): { inTop3: boolean; rank: number } {
  const top3 = rankedCandidates.slice(0, 3);
  for (let i = 0; i < top3.length; i++) {
    const c = top3[i];
    if (c.root === phraseWinnerRoot && c.quality === phraseWinnerQuality) {
      return { inTop3: true, rank: i + 1 };
    }
  }
  return { inTop3: false, rank: -1 };
}
