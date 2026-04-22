// ═══════════════════════════════════════════════════════════════════════
// Test Harness — Valida detector dual-layer com 4 pares relativos
// ═══════════════════════════════════════════════════════════════════════
// Simula melodias a capela realistas em diferentes tonalidades e verifica:
//   (1) Tonalidade detectada bate com a cantada?
//   (2) Em qual frase chega em "Provável", "Confirmado", "Definitivo"?
//   (3) Ocorre troca indevida de tom no meio?
//   (4) Alterna com relativo menor/maior?
//
// Usa tsx (TypeScript runner) para importar diretamente os módulos .ts.
// ═══════════════════════════════════════════════════════════════════════

import {
  createInitialState,
  buildPhrase,
  ingestPhrase,
  keyName,
  NOTE_NAMES_BR,
  type KeyDetectionState,
  type DetectedNoteEvent,
} from '../src/utils/phraseKeyDetector';
import {
  TemporalBuffer,
  buildWeightedHistogram,
  rankAllKeys,
  agreementMultiplier,
} from '../src/utils/tonalScorer';

// ── Helpers de construção de frases musicais ──────────────────────────
interface MelodicNote {
  pc: number;     // pitch class 0-11 (C=0, C#=1, ..., B=11)
  durMs: number;
}

// Converte MelodicNote[] em DetectedNoteEvent[] com timestamps
function toNoteEvents(melody: MelodicNote[], startOffset: number): DetectedNoteEvent[] {
  const events: DetectedNoteEvent[] = [];
  let t = startOffset;
  for (const n of melody) {
    events.push({
      pitchClass: n.pc,
      midi: 60 + n.pc, // C4 = 60, mantém oitava fixa pra teste
      timestamp: t,
      durMs: n.durMs,
      rmsAvg: 0.1,
    });
    t += n.durMs;
  }
  return events;
}

// ── Geradores de melodia para CADA tonalidade ──────────────────────────
// Padrões realistas: frases que COMEÇAM em graus diatônicos mas RESOLVEM
// na tônica (cadência), simulando comportamento vocal natural.

// ----- MAIOR -----
// I-IV-V-I tipo; sempre RESOLVENDO em root (tônica)
function majorPhrases(rootPc: number): MelodicNote[][] {
  const sc = (deg: number) => (rootPc + deg) % 12;
  // Graus diatônicos da maior: 0=I, 2=II, 4=III, 5=IV, 7=V, 9=VI, 11=VII
  return [
    // Frase 1: arpeggio I + resolução
    [
      { pc: sc(0), durMs: 300 },   // I
      { pc: sc(4), durMs: 250 },   // III
      { pc: sc(7), durMs: 300 },   // V
      { pc: sc(4), durMs: 250 },   // III
      { pc: sc(0), durMs: 600 },   // I (repouso final)
    ],
    // Frase 2: escala descendente V-IV-III-II-I
    [
      { pc: sc(7), durMs: 280 },
      { pc: sc(5), durMs: 260 },
      { pc: sc(4), durMs: 260 },
      { pc: sc(2), durMs: 260 },
      { pc: sc(0), durMs: 550 },
    ],
    // Frase 3: motivo vi-V-I (passa pelo relativo, mas resolve)
    [
      { pc: sc(9), durMs: 300 },   // VI (tônica do relativo menor!)
      { pc: sc(7), durMs: 280 },   // V
      { pc: sc(5), durMs: 260 },   // IV
      { pc: sc(4), durMs: 260 },   // III
      { pc: sc(2), durMs: 250 },   // II
      { pc: sc(0), durMs: 600 },   // I (repouso)
    ],
    // Frase 4: salto oitava + cadência perfeita
    [
      { pc: sc(4), durMs: 280 },
      { pc: sc(2), durMs: 260 },
      { pc: sc(11), durMs: 200 },  // leading tone (característico da maior!)
      { pc: sc(0), durMs: 650 },   // resolução
    ],
    // Frase 5: tensão e resolução (inclui III-VI mas volta a I)
    [
      { pc: sc(0), durMs: 280 },
      { pc: sc(4), durMs: 260 },
      { pc: sc(9), durMs: 280 },   // VI
      { pc: sc(7), durMs: 260 },
      { pc: sc(0), durMs: 600 },
    ],
  ];
}

// ----- MENOR (natural) -----
// i-iv-v-i, RESOLVENDO em root (tônica)
// Simula cantar MESMAS NOTAS da relativa maior mas resolvendo no VI dessa maior.
function minorPhrases(rootPc: number): MelodicNote[][] {
  const sc = (deg: number) => (rootPc + deg) % 12;
  // Graus menor natural: 0=i, 2=II, 3=III, 5=iv, 7=v, 8=VI, 10=VII
  return [
    // Frase 1: arpeggio i + resolução
    [
      { pc: sc(0), durMs: 300 },   // i
      { pc: sc(3), durMs: 250 },   // III (3m)
      { pc: sc(7), durMs: 300 },   // v
      { pc: sc(3), durMs: 250 },
      { pc: sc(0), durMs: 600 },   // i (repouso)
    ],
    // Frase 2: escala descendente
    [
      { pc: sc(7), durMs: 280 },
      { pc: sc(5), durMs: 260 },
      { pc: sc(3), durMs: 260 },
      { pc: sc(2), durMs: 260 },
      { pc: sc(0), durMs: 550 },
    ],
    // Frase 3: motivo com III (relativo maior!) mas resolve em i
    [
      { pc: sc(3), durMs: 300 },   // III (tônica do relativo MAIOR!)
      { pc: sc(5), durMs: 280 },   // iv
      { pc: sc(7), durMs: 260 },   // v
      { pc: sc(5), durMs: 250 },
      { pc: sc(3), durMs: 250 },
      { pc: sc(0), durMs: 600 },   // i (repouso)
    ],
    // Frase 4: cadência modal (sem leading tone)
    [
      { pc: sc(3), durMs: 280 },
      { pc: sc(2), durMs: 260 },
      { pc: sc(10), durMs: 200 },  // VII (b7, característico modal!)
      { pc: sc(0), durMs: 650 },   // resolução
    ],
    // Frase 5: i-VI-v-i
    [
      { pc: sc(0), durMs: 280 },
      { pc: sc(3), durMs: 260 },
      { pc: sc(8), durMs: 280 },   // VI
      { pc: sc(7), durMs: 260 },
      { pc: sc(0), durMs: 600 },
    ],
  ];
}

// ── Simula o pipeline: constrói frases, alimenta detector + scorer ────
function simulate(
  melodiesMelodic: MelodicNote[][],
  expectedKeyName: string,
): {
  detectedKey: string | null;
  stagePerPhrase: string[];
  finalStage: string;
  confidencePerPhrase: number[];
  tonicChanges: number;   // quantas vezes a tônica trocou
  scorerWinnerPerPhrase: string[];
  phraseCountToConfirmed: number | null;
  phraseCountToDefinitive: number | null;
} {
  let state: KeyDetectionState = createInitialState();
  const tempBuffer = new TemporalBuffer(8000); // v3: alinhado com produção

  const stagePerPhrase: string[] = [];
  const confidencePerPhrase: number[] = [];
  const scorerWinnerPerPhrase: string[] = [];
  let currentTonic: number | null = null;
  let tonicChanges = 0;
  let phraseCountToConfirmed: number | null = null;
  let phraseCountToDefinitive: number | null = null;

  let t = 0;
  let phraseIdx = 0;
  for (const mel of melodiesMelodic) {
    const events = toNoteEvents(mel, t);
    // Alimenta buffer temporal com as notas
    for (const e of events) {
      tempBuffer.push({
        pitchClass: e.pitchClass,
        durMs: e.durMs,
        stability: 1.0, // simulação "ideal"
        timestamp: e.timestamp + e.durMs,
      });
    }
    const phrase = buildPhrase(events);
    if (!phrase) {
      stagePerPhrase.push('INVALID_PHRASE');
      phraseIdx++;
      t = events[events.length - 1].timestamp + events[events.length - 1].durMs + 500;
      continue;
    }
    state = ingestPhrase(state, phrase);

    // Track tonic changes
    if (state.currentTonicPc !== null) {
      if (currentTonic !== null && currentTonic !== state.currentTonicPc) {
        tonicChanges++;
      }
      currentTonic = state.currentTonicPc;
    }

    stagePerPhrase.push(state.stage);
    confidencePerPhrase.push(state.tonicConfidence);

    // Scorer
    const samples = tempBuffer.getSamples();
    const hist = buildWeightedHistogram(samples);
    const ranked = rankAllKeys(hist, samples, state.phrases);
    const scorerWinner = ranked[0];
    scorerWinnerPerPhrase.push(
      `${NOTE_NAMES_BR[scorerWinner.root]} ${scorerWinner.quality === 'major' ? 'M' : 'm'} (${scorerWinner.score.toFixed(3)})`
    );

    if (phraseCountToConfirmed === null && (state.stage === 'confirmed' || state.stage === 'definitive')) {
      phraseCountToConfirmed = phraseIdx + 1;
    }
    if (phraseCountToDefinitive === null && state.stage === 'definitive') {
      phraseCountToDefinitive = phraseIdx + 1;
    }

    phraseIdx++;
    t = events[events.length - 1].timestamp + events[events.length - 1].durMs + 500; // 500ms entre frases
  }

  const detected =
    state.currentTonicPc !== null && state.quality
      ? keyName(state.currentTonicPc, state.quality)
      : null;

  return {
    detectedKey: detected,
    stagePerPhrase,
    finalStage: state.stage,
    confidencePerPhrase,
    tonicChanges,
    scorerWinnerPerPhrase,
    phraseCountToConfirmed,
    phraseCountToDefinitive,
  };
}

// ----- Hino em Fá# Maior com ÊNFASE em C# (V) e G# (II) -----
// Caso adversarial: simula o comportamento real do usuário onde notas
// do grau V e II aparecem com peso pesado, mas cadências RESOLVEM em F#.
function hinoFsMajorAdversarial(): MelodicNote[][] {
  const F = 6, G = 8, A = 10, B = 11, C = 1, D = 3, E = 5; // notas de F# Maior
  return [
    // Frase 1: V sustentada + resolução
    [
      { pc: C, durMs: 400 },   // V forte
      { pc: C, durMs: 300 },   // V repete
      { pc: B, durMs: 250 },
      { pc: A, durMs: 300 },
      { pc: F, durMs: 700 },   // I (repouso)
    ],
    // Frase 2: ênfase em G# (II) + cadência em I
    [
      { pc: F, durMs: 280 },
      { pc: G, durMs: 350 },   // II forte
      { pc: A, durMs: 260 },
      { pc: G, durMs: 320 },   // II forte de novo
      { pc: F, durMs: 700 },   // I (repouso)
    ],
    // Frase 3: motivo com C# sustentado longo (V)
    [
      { pc: A, durMs: 280 },
      { pc: C, durMs: 500 },   // V muito longo
      { pc: D, durMs: 280 },
      { pc: B, durMs: 260 },
      { pc: A, durMs: 280 },
      { pc: F, durMs: 650 },   // I (repouso)
    ],
    // Frase 4: pico em G#, mas resolve I
    [
      { pc: F, durMs: 260 },
      { pc: A, durMs: 260 },
      { pc: G, durMs: 400 },   // II sustentada
      { pc: A, durMs: 260 },
      { pc: G, durMs: 260 },
      { pc: F, durMs: 650 },   // I (repouso)
    ],
    // Frase 5: cadência perfeita V-I com leading tone
    [
      { pc: C, durMs: 300 },   // V
      { pc: D, durMs: 260 },
      { pc: C, durMs: 300 },   // V
      { pc: E, durMs: 200 },   // leading tone (só F# Maior tem, não C#m nem G#m!)
      { pc: F, durMs: 700 },   // I (resolução)
    ],
    // Frase 6: melismática com G# e C# mas resolve I
    [
      { pc: F, durMs: 260 },
      { pc: G, durMs: 260 },
      { pc: A, durMs: 260 },
      { pc: C, durMs: 280 },
      { pc: G, durMs: 260 },
      { pc: A, durMs: 260 },
      { pc: F, durMs: 650 },   // I
    ],
  ];
}

// ── Testes ────────────────────────────────────────────────────────────
interface TestCase {
  name: string;
  melodies: MelodicNote[][];
  expectedKey: string;
  expectedTonicPc: number;
  expectedQuality: 'major' | 'minor';
}

// pitch classes: C=0, C#=1, D=2, D#=3, E=4, F=5, F#=6, G=7, G#=8, A=9, A#=10, B=11
const testCases: TestCase[] = [
  {
    name: 'D Maior (vs Si menor)',
    melodies: majorPhrases(2), // D = 2
    expectedKey: 'Ré Maior',
    expectedTonicPc: 2,
    expectedQuality: 'major',
  },
  {
    name: 'Si menor (vs Ré Maior)',
    melodies: minorPhrases(11), // B = 11
    expectedKey: 'Si menor',
    expectedTonicPc: 11,
    expectedQuality: 'minor',
  },
  {
    name: 'Sol Maior (vs Mi menor)',
    melodies: majorPhrases(7), // G = 7
    expectedKey: 'Sol Maior',
    expectedTonicPc: 7,
    expectedQuality: 'major',
  },
  {
    name: 'Mi menor (vs Sol Maior)',
    melodies: minorPhrases(4), // E = 4
    expectedKey: 'Mi menor',
    expectedTonicPc: 4,
    expectedQuality: 'minor',
  },
  {
    name: 'Dó Maior (vs Lá menor)',
    melodies: majorPhrases(0), // C = 0
    expectedKey: 'Dó Maior',
    expectedTonicPc: 0,
    expectedQuality: 'major',
  },
  {
    name: 'Lá menor (vs Dó Maior)',
    melodies: minorPhrases(9), // A = 9
    expectedKey: 'Lá menor',
    expectedTonicPc: 9,
    expectedQuality: 'minor',
  },
  {
    name: 'Lá Maior (vs Fá# menor)',
    melodies: majorPhrases(9), // A = 9
    expectedKey: 'Lá Maior',
    expectedTonicPc: 9,
    expectedQuality: 'major',
  },
  {
    name: 'Fá# menor (vs Lá Maior)',
    melodies: minorPhrases(6), // F# = 6
    expectedKey: 'Fá# menor',
    expectedTonicPc: 6,
    expectedQuality: 'minor',
  },
  {
    name: 'Fá# Maior HINO (ênfase em C#/G# — adversarial)',
    melodies: hinoFsMajorAdversarial(),
    expectedKey: 'Fá# Maior',
    expectedTonicPc: 6,
    expectedQuality: 'major',
  },
];

// ── Runner ────────────────────────────────────────────────────────────
function runAllTests() {
  console.log('═'.repeat(78));
  console.log('BATERIA DE TESTES — Detector Dual-Layer v2 (Krumhansl + Cadência)');
  console.log('═'.repeat(78));

  const results: Array<{ name: string; pass: boolean; detail: string }> = [];

  for (const tc of testCases) {
    const r = simulate(tc.melodies, tc.expectedKey);
    const keyMatches = r.detectedKey === tc.expectedKey;
    const pass = keyMatches && r.tonicChanges <= 1;

    console.log(`\n▸ ${tc.name}`);
    console.log(`  Esperado : ${tc.expectedKey}`);
    console.log(`  Detectado: ${r.detectedKey ?? 'N/A'}  ${keyMatches ? '✓' : '✗ MISMATCH'}`);
    console.log(`  Stage final: ${r.finalStage}`);
    console.log(`  Trocas de tônica durante análise: ${r.tonicChanges}  ${r.tonicChanges <= 1 ? '✓' : '⚠'}`);
    console.log(`  Chegou em "confirmed" na frase: ${r.phraseCountToConfirmed ?? 'NUNCA'}`);
    console.log(`  Chegou em "definitive" na frase: ${r.phraseCountToDefinitive ?? 'NUNCA'}`);
    console.log('  Evolução por frase:');
    for (let i = 0; i < r.stagePerPhrase.length; i++) {
      console.log(
        `    [${i + 1}] stage=${r.stagePerPhrase[i].padEnd(11)} conf=${r.confidencePerPhrase[i]?.toFixed(2) ?? 'N/A'} scorer=${r.scorerWinnerPerPhrase[i]}`
      );
    }

    results.push({
      name: tc.name,
      pass,
      detail: `${r.detectedKey ?? 'NULL'} | stage=${r.finalStage} | trocas=${r.tonicChanges} | confirmed@${r.phraseCountToConfirmed ?? '-'} | def@${r.phraseCountToDefinitive ?? '-'}`,
    });
  }

  console.log('\n' + '═'.repeat(78));
  console.log('RESUMO OBJETIVO');
  console.log('═'.repeat(78));
  console.log(
    '| Caso                                      | OK | Detalhe                                              |'
  );
  console.log(
    '|-------------------------------------------|----|------------------------------------------------------|'
  );
  for (const r of results) {
    console.log(
      `| ${r.name.padEnd(42)}| ${r.pass ? '✓ ' : '✗ '} | ${r.detail.padEnd(52)}|`
    );
  }

  const passed = results.filter(r => r.pass).length;
  console.log(`\n Aprovados: ${passed}/${results.length}`);
  if (passed < results.length) {
    console.log(' ⚠ Casos reprovados precisam de ajuste fino antes da OTA!');
    process.exit(1);
  } else {
    console.log(' ✓ Todos os casos passaram. Pronto para OTA.');
  }
}

runAllTests();
