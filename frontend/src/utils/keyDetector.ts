// Krumhansl-Schmuckler + Signature Score
// ── Por que a melhoria? ──────────────────────────────────────────────────────
// O Krumhansl puro dá peso POSITIVO a todas as 12 pitch classes, mesmo as que
// estão fora da escala do tom candidato. Isso causa confusões como:
//   Mi maior (F#, G#, C#, D#) sendo detectado como Lá menor
//   (que tem F, G, C, D naturais — EXACT oposto nas 4 notas chave).
//
// Solução: adicionar um "signature score" que penaliza notas fora da escala.
// ────────────────────────────────────────────────────────────────────────────

const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// Intervalos (em semitons) que compõem cada escala a partir da tônica
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
// Para menor: natural + harmônica (inclui 7ª maior por causa da dominante) +
//             melódica (6ª maior ascendente) — cobre uso real em canções pop
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 9, 10, 11];

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const xd = x[i] - mx;
    const yd = y[i] - my;
    num += xd * yd;
    dx2 += xd * xd;
    dy2 += yd * yd;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom > 0 ? num / denom : 0;
}

function signatureScore(
  histogram: number[],
  root: number,
  quality: 'major' | 'minor',
): number {
  const intervals = quality === 'major' ? MAJOR_SCALE : MINOR_SCALE;
  const scaleSet = new Set(intervals.map(i => (root + i) % 12));
  let inScale = 0;
  let outScale = 0;
  for (let pc = 0; pc < 12; pc++) {
    if (scaleSet.has(pc)) inScale += histogram[pc];
    else outScale += histogram[pc];
  }
  const total = inScale + outScale;
  if (total <= 0) return 0;
  return inScale / total; // 0..1
}

export interface KeyResult {
  root: number;
  quality: 'major' | 'minor';
  confidence: number;
  signature?: number;  // expõe para debug/UI
  pearson?: number;
}

export function detectKeyFromHistogram(histogram: number[]): KeyResult {
  let best: KeyResult = {
    root: 0,
    quality: 'major',
    confidence: -Infinity,
    signature: 0,
    pearson: 0,
  };

  for (let root = 0; root < 12; root++) {
    const maj = Array.from({ length: 12 }, (_, i) => KK_MAJOR[(i - root + 12) % 12]);
    const min = Array.from({ length: 12 }, (_, i) => KK_MINOR[(i - root + 12) % 12]);

    const majP = pearson(histogram, maj);
    const minP = pearson(histogram, min);
    const majS = signatureScore(histogram, root, 'major');
    const minS = signatureScore(histogram, root, 'minor');

    // ── Combinação ponderada ──────────────────────────────────────────────
    // signatureScore escala o pearson entre 0.4× (todas fora) e 1.0× (todas dentro).
    // Isso penaliza fortemente tons cujas escalas não "batem" com o que o
    // usuário realmente está cantando, resolvendo ambiguidades como Mi major vs Lá minor.
    const majScore = majP * (0.4 + 0.6 * majS);
    const minScore = minP * (0.4 + 0.6 * minS);

    if (majScore > best.confidence) {
      best = { root, quality: 'major', confidence: majScore, signature: majS, pearson: majP };
    }
    if (minScore > best.confidence) {
      best = { root, quality: 'minor', confidence: minScore, signature: minS, pearson: minP };
    }
  }

  return best;
}
