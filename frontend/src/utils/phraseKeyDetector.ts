// ═══════════════════════════════════════════════════════════════════════════
// Tom Certo — Phrase-Based Key Detector v5 (DEFINITIVO)
// ═══════════════════════════════════════════════════════════════════════════
// Em vez de analisar notas como histograma estatístico, analisa FRASES
// MELÓDICAS — é assim que o humano percebe a tonalidade.
//
// Resolve a confusão maior/relativo menor (ex: Ré Maior vs Fá# menor) porque
// é praticamente impossível alguém cantar Ré Maior e RESOLVER a frase em F#.
// Cadência humana sempre retorna à tônica. Essa é a pista mais confiável.
//
// Arquitetura em 3 camadas:
//   1) Segmentação em frases (silêncios ≥ 300ms OU notas sustentadas ≥ 1.5s)
//   2) Cada frase VOTA na tônica (peso 5× cadência, 2× primeira, 1.5× longest)
//   3) Qualidade (maj/min) só depois da tônica estável (3ª grade das notas)
//
// Regras de estabilidade:
//   - Tally acumula, mas decai 15% a cada frase (recency > histórico)
//   - Contradição não "troca" tom — reduz confiança gradualmente
//   - Stage só avança quando critérios CUMULATIVOS são atendidos
// ═══════════════════════════════════════════════════════════════════════════

export const NOTE_NAMES_BR = ['Dó', 'Dó#', 'Ré', 'Ré#', 'Mi', 'Fá', 'Fá#', 'Sol', 'Sol#', 'Lá', 'Lá#', 'Si'];

// ─── Constantes de segmentação (MAIS CONSERVADOR) ─────────────────────
export const SILENCE_END_PHRASE_MS = 300;   // silêncio pra fechar frase
export const LEGATO_SUSTAINED_MS = 1500;    // fallback: nota sustentada = frase
export const MIN_NOTE_DUR_MS = 130;         // nota precisa durar ≥ isso (antes 80)
export const MIN_PHRASE_DUR_MS = 700;       // frase precisa ter ≥ isso (antes 400)
export const MIN_NOTES_PER_PHRASE = 3;      // ≥ 3 notas distintas (antes 2)
export const MIN_CADENCE_DUR_MS = 280;      // cadência precisa ≥ isso (antes 180)

// ─── Pesos de votação (v2: cadência é a âncora tonal mais forte) ──────
export const VOTE_CADENCE = 7.0;      // antes 5.0 — frase RESOLVE na tônica
export const VOTE_FIRST_STABLE = 2.0;
export const VOTE_LONGEST = 1.0;      // antes 1.5 — mais longa nem sempre é tônica

// ─── Estabilidade (MUITO MAIS RIGOROSA) ────────────────────────────────
export const TALLY_DECAY = 0.93;               // v3: preserva mais histórico (antes 0.90)
export const STAGE_PROBABLE_MIN_CONF = 0.35;
export const STAGE_CONFIRMED_MIN_CONF = 0.55;  // v3: recalibrado p/ conviction real (antes 0.78)
export const STAGE_DEFINITIVE_MIN_CONF = 0.75; // v3: recalibrado (antes 0.92)
export const STAGE_DEFINITIVE_MIN_QUALITY_MARGIN = 1.35;
export const STAGE_CONFIRMED_MIN_PHRASES = 3;
export const STAGE_DEFINITIVE_MIN_PHRASES = 4;

// v3: Histerese GRADUAL por stage (antes atuava só em confirmed/definitive)
export const HYSTERESIS_BY_STAGE: Record<DetectionStage, number> = {
  listening: 1.0,   // livre (sem tônica ainda)
  probable: 1.4,    // NOVO — protege desde cedo contra graus diatônicos
  confirmed: 2.0,
  definitive: 2.5,  // antes 2.0 — ainda mais resistente
};

// v3: Bônus cumulativo por frases consecutivas concordantes
export const CONSECUTIVE_BONUS_PER_PHRASE = 0.15;
export const CONSECUTIVE_BONUS_CAP = 5;        // até 5 frases (+75% máx)

export type DetectionStage = 'listening' | 'probable' | 'confirmed' | 'definitive';

export interface DetectedNoteEvent {
  pitchClass: number;  // 0..11
  midi: number;
  timestamp: number;   // ms since detector start
  durMs: number;
  rmsAvg: number;
}

export interface Phrase {
  notes: DetectedNoteEvent[];
  startMs: number;
  endMs: number;
  durMs: number;
  firstStablePc: number | null;
  lastSustainedPc: number | null;
  longestPc: number | null;
}

export interface KeyDetectionState {
  phrases: Phrase[];
  tonicTally: number[];         // [12] acumulado + decaído
  noteDurHist: number[];        // [12] duração total de cada pc (para qualidade)
  currentTonicPc: number | null;
  tonicConfidence: number;      // 0..1
  quality: 'major' | 'minor' | null;
  qualityMargin: number;        // razão M3/m3 ou m3/M3
  stage: DetectionStage;
  consecutiveAgreements: number; // v3: nº de frases seguidas que resolveram na tônica atual
}

// ── Inicialização ────────────────────────────────────────────────────
export function createInitialState(): KeyDetectionState {
  return {
    phrases: [],
    tonicTally: new Array(12).fill(0),
    noteDurHist: new Array(12).fill(0),
    currentTonicPc: null,
    tonicConfidence: 0,
    quality: null,
    qualityMargin: 0,
    stage: 'listening',
    consecutiveAgreements: 0,
  };
}

// ── Constrói uma frase a partir de eventos de nota ───────────────────
// Filtra notas muito curtas; retorna null se a frase não for válida.
export function buildPhrase(notes: DetectedNoteEvent[]): Phrase | null {
  // Filtra notas muito curtas
  const valid = notes.filter(n => n.durMs >= MIN_NOTE_DUR_MS);
  if (valid.length < MIN_NOTES_PER_PHRASE) return null;

  const startMs = valid[0].timestamp;
  const lastN = valid[valid.length - 1];
  const endMs = lastN.timestamp + lastN.durMs;
  const durMs = endMs - startMs;
  if (durMs < MIN_PHRASE_DUR_MS) return null;

  // First stable: primeira nota com duração ≥ 180ms (voz estabilizada)
  let firstStablePc: number | null = null;
  for (const n of valid) {
    if (n.durMs >= 180) { firstStablePc = n.pitchClass; break; }
  }
  if (firstStablePc === null) firstStablePc = valid[0].pitchClass;

  // Last sustained (cadência): última nota com durMs ≥ MIN_CADENCE_DUR_MS
  let lastSustainedPc: number | null = null;
  for (let i = valid.length - 1; i >= 0; i--) {
    if (valid[i].durMs >= MIN_CADENCE_DUR_MS) {
      lastSustainedPc = valid[i].pitchClass;
      break;
    }
  }
  // Fallback: última nota da frase
  if (lastSustainedPc === null) lastSustainedPc = valid[valid.length - 1].pitchClass;

  // Longest: nota mais longa da frase
  let longestPc: number | null = null;
  let maxDur = 0;
  for (const n of valid) {
    if (n.durMs > maxDur) { maxDur = n.durMs; longestPc = n.pitchClass; }
  }

  return { notes: valid, startMs, endMs, durMs, firstStablePc, lastSustainedPc, longestPc };
}

// ── Computa votos de uma frase (pc → peso) ──────────────────────────
function votesFromPhrase(phrase: Phrase): number[] {
  const votes = new Array(12).fill(0);
  if (phrase.lastSustainedPc !== null) votes[phrase.lastSustainedPc] += VOTE_CADENCE;
  if (phrase.firstStablePc !== null) votes[phrase.firstStablePc] += VOTE_FIRST_STABLE;
  if (phrase.longestPc !== null) votes[phrase.longestPc] += VOTE_LONGEST;
  return votes;
}

// ── Atualiza noteDurHist com as notas da frase ──────────────────────
function updateNoteDurHist(hist: number[], phrase: Phrase): number[] {
  const out = hist.slice();
  for (const n of phrase.notes) {
    out[n.pitchClass] += n.durMs;
  }
  return out;
}

// ── Determina qualidade (maj/min) usando ANÁLISE POR TRÍADE NOS REPOUSOS ─
// v2: Em vez de só comparar M3 vs m3 (susceptível a notas de passagem),
// analisamos em qual tríade as notas de REPOUSO das frases caem:
//   - Tríade maior: {root, root+4, root+7}
//   - Tríade menor: {root, root+3, root+7}
// A quinta (root+7) é neutra; o que distingue é M3 vs m3.
//
// Peso por posição musical:
//   • cadência (lastSustainedPc)        → 4× (repouso da frase)
//   • nota mais longa da frase          → 2.5×
//   • nota ≥ 250ms (repouso estendido)  → 2×
//   • outras notas                      → 1× (passagem)
function determineQuality(
  phrases: Phrase[],
  noteDurHist: number[],
  tonicPc: number
): { quality: 'major' | 'minor'; margin: number } {
  const M3pc = (tonicPc + 4) % 12;
  const m3pc = (tonicPc + 3) % 12;

  let M3Weight = 0;
  let m3Weight = 0;

  for (const phrase of phrases) {
    for (const note of phrase.notes) {
      if (note.pitchClass !== M3pc && note.pitchClass !== m3pc) continue;
      let weight = 1; // passagem curta
      if (note.durMs >= 250) weight = 2; // repouso
      if (note.pitchClass === phrase.longestPc) weight = Math.max(weight, 2.5);
      if (note.pitchClass === phrase.lastSustainedPc) weight = Math.max(weight, 4);

      if (note.pitchClass === M3pc) M3Weight += weight;
      else m3Weight += weight;
    }
  }

  // Fallback: se não há 3ª na melodia, usa leading tone vs 7ª menor
  const total3rd = M3Weight + m3Weight;
  if (total3rd < 1) {
    const leadingTone = noteDurHist[(tonicPc + 11) % 12]; // 7M
    const minorSeventh = noteDurHist[(tonicPc + 10) % 12]; // 7m
    if (leadingTone > minorSeventh * 1.2) return { quality: 'major', margin: 1.5 };
    if (minorSeventh > leadingTone * 1.2) return { quality: 'minor', margin: 1.5 };
    return { quality: 'major', margin: 1.0 };
  }

  const majRatio = M3Weight / (m3Weight + 0.1);
  const minRatio = m3Weight / (M3Weight + 0.1);

  if (majRatio >= 1.25) return { quality: 'major', margin: majRatio };
  if (minRatio >= 1.25) return { quality: 'minor', margin: minRatio };
  return { quality: 'major', margin: 1.0 };
}

// ── Determina stage com base no estado cumulativo (MAIS CONSERVADOR) ─
function determineStage(s: {
  phraseCount: number;
  tonicConfidence: number;
  qualityMargin: number;
  lastPhrasesAgree: boolean;       // últimas 2 frases concordam?
  lastThreePhrasesAgree: boolean;  // últimas 3 frases concordam?
}): DetectionStage {
  if (s.phraseCount === 0) return 'listening';

  // Provável: ≥ 1 frase + confiança mínima
  if (s.phraseCount >= 1 && s.tonicConfidence >= STAGE_PROBABLE_MIN_CONF) {
    // Confirmado: ≥ 3 frases + concordância nas últimas 2 + confiança alta
    if (
      s.phraseCount >= STAGE_CONFIRMED_MIN_PHRASES &&
      s.tonicConfidence >= STAGE_CONFIRMED_MIN_CONF &&
      s.lastPhrasesAgree
    ) {
      // Definitivo: ≥ 4 frases, 3 concordam, confiança muito alta, qualidade MARGEM FORTE
      if (
        s.phraseCount >= STAGE_DEFINITIVE_MIN_PHRASES &&
        s.tonicConfidence >= STAGE_DEFINITIVE_MIN_CONF &&
        s.lastThreePhrasesAgree &&
        s.qualityMargin >= STAGE_DEFINITIVE_MIN_QUALITY_MARGIN
      ) {
        return 'definitive';
      }
      return 'confirmed';
    }
    return 'probable';
  }

  return 'listening';
}

// ── Integra uma nova frase ao estado (v3) ───────────────────────────
// Mudanças v3:
//   • Histerese GRADUAL por stage (protege desde "probable", não só confirmed)
//   • Bônus cumulativo para tônica quando frases consecutivas concordam
//   • Confiança baseada em EVIDÊNCIAS REAIS (não piso cosmético por stage):
//     combina margem, frases analisadas, concordância consecutiva e peso
//     absoluto acumulado.
export function ingestPhrase(state: KeyDetectionState, phrase: Phrase): KeyDetectionState {
  // 1) Decay do tally anterior
  const decayed = state.tonicTally.map(v => v * TALLY_DECAY);

  // 2) Adiciona votos da nova frase
  const votes = votesFromPhrase(phrase);
  const newTally = decayed.map((v, i) => v + votes[i]);

  // 3) BÔNUS DE CONCORDÂNCIA CONSECUTIVA (v3)
  // Se a frase atual resolve na MESMA tônica que as últimas N frases consecutivas,
  // amplifica o peso dessa tônica — reflete convicção musical cumulativa.
  let consecutiveAgreements = state.consecutiveAgreements;
  if (
    state.currentTonicPc !== null &&
    phrase.lastSustainedPc === state.currentTonicPc
  ) {
    consecutiveAgreements += 1;
    const bonus = 1 + CONSECUTIVE_BONUS_PER_PHRASE * Math.min(consecutiveAgreements, CONSECUTIVE_BONUS_CAP);
    newTally[state.currentTonicPc] *= bonus;
  } else if (
    phrase.lastSustainedPc !== null &&
    state.currentTonicPc !== null &&
    phrase.lastSustainedPc !== state.currentTonicPc
  ) {
    consecutiveAgreements = 0; // sequência quebrada
  }

  // 4) Atualiza histograma de duração
  const newDurHist = updateNoteDurHist(state.noteDurHist, phrase);

  // 5) Encontra tônica candidata + segundo colocado
  let topPc = 0;
  let topWeight = -Infinity;
  let secondWeight = 0;
  for (let pc = 0; pc < 12; pc++) {
    if (newTally[pc] > topWeight) {
      secondWeight = topWeight > -Infinity ? topWeight : 0;
      topWeight = newTally[pc];
      topPc = pc;
    } else if (newTally[pc] > secondWeight) {
      secondWeight = newTally[pc];
    }
  }

  // 6) HISTERESE GRADUAL POR STAGE (v3)
  // Antes atuava só em confirmed/definitive. Agora protege desde "probable",
  // que é o caso crítico de hinos em tonalidades com muitos graus diatônicos.
  const hysteresisFactor = HYSTERESIS_BY_STAGE[state.stage] ?? 1.0;
  if (
    state.currentTonicPc !== null &&
    state.stage !== 'listening' &&
    topPc !== state.currentTonicPc
  ) {
    const prevWeight = newTally[state.currentTonicPc];
    if (topWeight < prevWeight * hysteresisFactor) {
      secondWeight = topWeight;
      topWeight = prevWeight;
      topPc = state.currentTonicPc;
    }
  }

  // Se a tônica NÃO mudou via histerese (ou é a mesma), mantém o contador;
  // se trocou de fato, reseta para 1 se a frase atual resolve na nova tônica
  if (state.currentTonicPc !== null && topPc !== state.currentTonicPc) {
    // Trocou mesmo — reseta
    consecutiveAgreements = phrase.lastSustainedPc === topPc ? 1 : 0;
  } else if (state.currentTonicPc === null && phrase.lastSustainedPc === topPc) {
    // Primeira tônica + frase resolveu nela
    consecutiveAgreements = 1;
  }

  // 7) CONFIANÇA HONESTA (v3) — baseada em evidências reais, sem piso cosmético
  //    Componentes (todos em 0..1):
  //    • marginRatio:  quanto a tônica vence o 2º lugar
  //    • phraseBonus:  temos volume suficiente de frases? (≥ 3 = 1.0)
  //    • consecBonus:  frases consecutivas concordantes (≥ 3 = 1.0)
  //    • weightNorm:   peso absoluto acumulado da tônica (saturado em 15)
  const marginRatio = topWeight > 0
    ? Math.min(1, (topWeight - secondWeight) / (topWeight + 0.5))
    : 0;
  const phraseBonus = Math.min(1, (state.phrases.length + 1) / 3);
  const consecBonus = Math.min(1, consecutiveAgreements / 3);
  const weightNorm = Math.min(1, topWeight / 15);

  const tonicConfidence =
    0.25 * phraseBonus +
    0.30 * marginRatio +
    0.30 * consecBonus +
    0.15 * weightNorm;

  // 8) Qualidade (maj/min) via tríade nos repousos
  const newPhrases = [...state.phrases, phrase];
  const qr = determineQuality(newPhrases, newDurHist, topPc);

  // 9) Concordância das últimas frases (pra critérios de stage)
  const lastPhrasesAgree = (() => {
    if (newPhrases.length < 2) return false;
    const lp = newPhrases[newPhrases.length - 1];
    const pp = newPhrases[newPhrases.length - 2];
    return lp.lastSustainedPc === topPc && pp.lastSustainedPc === topPc;
  })();

  const lastThreePhrasesAgree = (() => {
    if (newPhrases.length < 3) return false;
    return (
      newPhrases[newPhrases.length - 1].lastSustainedPc === topPc &&
      newPhrases[newPhrases.length - 2].lastSustainedPc === topPc &&
      newPhrases[newPhrases.length - 3].lastSustainedPc === topPc
    );
  })();

  const stage = determineStage({
    phraseCount: newPhrases.length,
    tonicConfidence,
    qualityMargin: qr.margin,
    lastPhrasesAgree,
    lastThreePhrasesAgree,
  });

  return {
    phrases: newPhrases,
    tonicTally: newTally,
    noteDurHist: newDurHist,
    currentTonicPc: topPc,
    tonicConfidence,
    quality: stage === 'listening' ? null : qr.quality,
    qualityMargin: qr.margin,
    stage,
    consecutiveAgreements,
  };
}

// ── Helpers pra UI ──────────────────────────────────────────────────
export function keyName(root: number, quality: 'major' | 'minor'): string {
  return quality === 'major'
    ? `${NOTE_NAMES_BR[root]} Maior`
    : `${NOTE_NAMES_BR[root]} menor`;
}

// Campo harmônico (acordes diatônicos I-ii-iii-IV-V-vi-vii°) em pt-BR
export function harmonicFieldNames(root: number, quality: 'major' | 'minor'): string[] {
  const intervals = quality === 'major'
    ? [0, 2, 4, 5, 7, 9, 11]
    : [0, 2, 3, 5, 7, 8, 10];
  const qualities = quality === 'major'
    ? ['', 'm', 'm', '', '', 'm', '°']
    : ['m', '°', '', 'm', 'm', '', ''];
  return intervals.map((iv, i) => `${NOTE_NAMES_BR[(root + iv) % 12]}${qualities[i]}`);
}
