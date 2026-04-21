// ═════════════════════════════════════════════════════════════════════════
// Tom Certo — Tonal Inference Engine v3
// ═════════════════════════════════════════════════════════════════════════
// Abandona a abordagem monolítica de Krumhansl puro e usa um scoring
// multi-critério especificamente desenhado para voz cantada.
//
// Pesos:  35% Krumhansl-Schmuckler (base estatística)
//         25% Signature fit (peso dentro/fora da escala)
//         20% Third-degree balance (M3 vs m3) — diferencia maj/min
//         10% Tonic evidence (peso da raiz relativo ao máximo)
//         10% Leading tone evidence (7ª sensível em tons maiores/harm. menores)
// ═════════════════════════════════════════════════════════════════════════

// Perfis de Krumhansl-Schmuckler (1990)
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Escalas: maior diatônica + menor (natural ∪ harmônica ∪ melódica asc.)
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 9, 10, 11];

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const xd = x[i] - mx, yd = y[i] - my;
    num += xd * yd; dx2 += xd * xd; dy2 += yd * yd;
  }
  const d = Math.sqrt(dx2 * dy2);
  return d > 0 ? num / d : 0;
}

function rotate(arr: number[], shift: number): number[] {
  return Array.from({ length: 12 }, (_, i) => arr[(i - shift + 12) % 12]);
}

function signatureFit(hist: number[], root: number, quality: 'major' | 'minor'): number {
  const iv = quality === 'major' ? MAJOR_SCALE : MINOR_SCALE;
  const scale = new Set(iv.map(i => (root + i) % 12));
  let inS = 0, outS = 0;
  for (let pc = 0; pc < 12; pc++) {
    if (scale.has(pc)) inS += hist[pc];
    else outS += hist[pc];
  }
  const total = inS + outS;
  return total <= 0 ? 0 : inS / total;
}

/**
 * Terceira maior (root+4) vs terceira menor (root+3).
 * Retorna valor em [-1 .. +1]: positivo = perfil maior, negativo = perfil menor.
 */
function thirdBalance(hist: number[], root: number): number {
  const M3 = hist[(root + 4) % 12];
  const m3 = hist[(root + 3) % 12];
  const sum = M3 + m3;
  if (sum < 1e-6) return 0;
  return (M3 - m3) / sum; // -1..+1
}

/**
 * Evidência de tônica: quanto a pitch class candidate "domina" o histograma.
 * Retorna 0..1.
 */
function tonicEvidence(hist: number[], root: number): number {
  const maxVal = Math.max(...hist);
  if (maxVal <= 0) return 0;
  return hist[root] / maxVal;
}

/**
 * Presença da sensível (7ª maior, root+11 em major; root+11 também em menor harmônica).
 * Uma sensível forte indica tonalidade com cadência autêntica real.
 */
function leadingToneEvidence(hist: number[], root: number, quality: 'major' | 'minor'): number {
  // Para ambos, a sensível "sobe" para a tônica (7ª maior = root+11)
  const lt = hist[(root + 11) % 12];
  const tonic = hist[root];
  if (tonic + lt < 1e-6) return 0;
  // Sensível é "significativa" quando aparece junto da tônica (cadência)
  return Math.min(1, lt / Math.max(tonic, 1e-6));
}

export interface KeyResult {
  root: number;
  quality: 'major' | 'minor';
  confidence: number;        // 0..1 score combinado
  breakdown?: {
    pearson: number;
    signature: number;
    third: number;
    tonic: number;
    leadingTone: number;
  };
}

/**
 * Detecta tom a partir de um histograma ponderado por duração/clarity (não contagem).
 * 
 * Diferença crítica vs versão anterior:
 *   1. O histograma DEVE refletir peso musical (duration × clarity), não contagem
 *   2. Score multi-critério — cada camada ataca um tipo de ambiguidade diferente
 *   3. 3rd-degree balance resolve DIRETAMENTE maj vs min relativos
 */
export function detectKeyFromHistogram(hist: number[]): KeyResult {
  let best: KeyResult = {
    root: 0, quality: 'major', confidence: -Infinity,
  };

  for (let r = 0; r < 12; r++) {
    const majProfile = rotate(KK_MAJOR, r);
    const minProfile = rotate(KK_MINOR, r);

    const pM = Math.max(0, pearson(hist, majProfile));
    const pN = Math.max(0, pearson(hist, minProfile));
    const sM = signatureFit(hist, r, 'major');
    const sN = signatureFit(hist, r, 'minor');
    const tb = thirdBalance(hist, r);   // -1..+1
    const te = tonicEvidence(hist, r);  // 0..1
    const ltM = leadingToneEvidence(hist, r, 'major');
    const ltN = leadingToneEvidence(hist, r, 'minor');

    // Normalizar thirdBalance a [0..1] para cada direção
    const majThird = Math.max(0, tb);    // só positivo (M3 > m3 → major)
    const minThird = Math.max(0, -tb);   // só positivo (m3 > M3 → minor)

    const scoreMajor =
      0.35 * pM +
      0.25 * sM +
      0.20 * majThird +
      0.10 * te +
      0.10 * ltM;

    const scoreMinor =
      0.35 * pN +
      0.25 * sN +
      0.20 * minThird +
      0.10 * te +
      0.10 * ltN;

    if (scoreMajor > best.confidence) {
      best = {
        root: r, quality: 'major', confidence: scoreMajor,
        breakdown: { pearson: pM, signature: sM, third: majThird, tonic: te, leadingTone: ltM },
      };
    }
    if (scoreMinor > best.confidence) {
      best = {
        root: r, quality: 'minor', confidence: scoreMinor,
        breakdown: { pearson: pN, signature: sN, third: minThird, tonic: te, leadingTone: ltN },
      };
    }
  }

  return best;
}
