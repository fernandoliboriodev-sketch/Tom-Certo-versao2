import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Animated,
  Dimensions,
  Easing,
  Platform,
  Image,
  Modal,
  ScrollView,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { useKeyDetection, DetectionMode } from '../src/hooks/useKeyDetection';
import {
  NOTES_BR,
  NOTES_INTL,
  formatKeyDisplay,
  getHarmonicField,
} from '../src/utils/noteUtils';
import { useAuth } from '../src/auth/AuthContext';

const { width: SW, height: SH } = Dimensions.get('window');

// ─── Design tokens (premium dark) ────────────────────────────────────────────
const C = {
  bg:           '#000000',
  surface:      '#0E0E0E',
  surface2:     '#141414',
  border:       '#1C1C1C',
  borderStrong: '#2A2A2A',
  amber:        '#FFB020',
  amberGlow:    'rgba(255,176,32,0.38)',
  amberMuted:   'rgba(255,176,32,0.10)',
  amberBorder:  'rgba(255,176,32,0.28)',
  white:        '#FFFFFF',
  text2:        '#A0A0A0',
  text3:        '#555555',
  red:          '#EF4444',
  redMuted:     'rgba(239,68,68,0.12)',
  green:        '#22C55E',
  blue:         '#60A5FA',
};

// ═════════════════════════════════════════════════════════════════════════════
// ROOT
// ═════════════════════════════════════════════════════════════════════════════
export default function HomeScreen() {
  const det = useKeyDetection();

  const screen: 'initial' | 'active' = det.isRunning ? 'active' : 'initial';

  return (
    <SafeAreaView style={ss.safe} edges={['top', 'bottom']}>
      {screen === 'initial' ? (
        <InitialScreen
          onStart={det.start}
          errorMessage={det.errorMessage}
          errorReason={det.errorReason}
        />
      ) : (
        <ActiveScreen det={det} />
      )}
    </SafeAreaView>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// INITIAL
// ═════════════════════════════════════════════════════════════════════════════
function InitialScreen({
  onStart,
  errorMessage,
  errorReason,
}: {
  onStart: () => void;
  errorMessage: string | null;
  errorReason: 'permission_denied' | 'permission_blocked' | 'platform_limit' | 'unknown' | null;
}) {
  const { logout, session } = useAuth();
  const [modalVisible, setModalVisible] = useState(false);
  const prevErr = useRef<string | null>(null);

  useEffect(() => {
    if (errorMessage && errorMessage !== prevErr.current) setModalVisible(true);
    prevErr.current = errorMessage;
  }, [errorMessage]);

  const fadeIn  = useRef(new Animated.Value(0)).current;
  const slideUp = useRef(new Animated.Value(30)).current;
  const logoGlow = useRef(new Animated.Value(0.6)).current;
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  const ring3 = useRef(new Animated.Value(0)).current;
  const micScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeIn,  { toValue: 1, duration: 280, useNativeDriver: true }),
      Animated.timing(slideUp, { toValue: 0, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();

    const logoLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(logoGlow, { toValue: 1,   duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(logoGlow, { toValue: 0.6, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ])
    );
    logoLoop.start();

    const makeRing = (val: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(val, { toValue: 1, duration: 2200, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          Animated.timing(val, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      );
    const r1 = makeRing(ring1, 0);
    const r2 = makeRing(ring2, 700);
    const r3 = makeRing(ring3, 1400);
    r1.start(); r2.start(); r3.start();

    return () => { logoLoop.stop(); r1.stop(); r2.stop(); r3.stop(); };
  }, []);

  const handlePressIn = () => {
    Animated.spring(micScale, { toValue: 0.92, useNativeDriver: true }).start();
  };
  const handlePressOut = () => {
    Animated.spring(micScale, { toValue: 1, friction: 4, useNativeDriver: true }).start();
  };

  const renderRing = (val: Animated.Value) => (
    <Animated.View
      style={[ss.micRing, {
        opacity:   val.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 0.55, 0] }),
        transform: [{ scale: val.interpolate({ inputRange: [0, 1], outputRange: [1, 2.8] }) }],
      }]}
    />
  );

  return (
    <Animated.View style={[ss.initialRoot, { opacity: fadeIn, transform: [{ translateY: slideUp }] }]}>
      <View style={ss.brandBlock}>
        <Animated.Image
          source={require('../assets/images/logo-full.png')}
          style={[ss.logoClean, { opacity: logoGlow }]}
          resizeMode="contain"
        />
      </View>

      <View style={ss.micSection}>
        {renderRing(ring3)}
        {renderRing(ring2)}
        {renderRing(ring1)}

        <Animated.View style={{ transform: [{ scale: micScale }] }}>
          <TouchableOpacity
            testID="start-detection-btn"
            style={ss.micBtn}
            onPress={onStart}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            activeOpacity={1}
          >
            <Ionicons name="mic" size={52} color={C.bg} />
          </TouchableOpacity>
        </Animated.View>

        <Text style={ss.micLabel}>Toque para detectar</Text>
      </View>

      {errorMessage && !modalVisible ? (
        <TouchableOpacity testID="error-details-btn" style={ss.errorBox} onPress={() => setModalVisible(true)} activeOpacity={0.7}>
          <Ionicons name="alert-circle" size={16} color={C.red} />
          <Text style={ss.errorTxt} numberOfLines={2}>{errorMessage}</Text>
        </TouchableOpacity>
      ) : null}

      <TouchableOpacity testID="logout-btn" style={ss.logoutBtn} onPress={logout} activeOpacity={0.6}>
        <Ionicons name="log-out-outline" size={13} color={C.text3} />
        <Text style={ss.logoutTxt}>
          Sair{session?.customer_name ? ` · ${session.customer_name}` : ''}
        </Text>
      </TouchableOpacity>

      <MicNoticeModal
        visible={modalVisible}
        onClose={() => setModalVisible(false)}
        onRetry={() => { setModalVisible(false); onStart(); }}
        reason={errorReason}
        message={errorMessage}
      />
    </Animated.View>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTIVE — TELA ÚNICA UNIFICADA (todas as camadas simultâneas)
// ═════════════════════════════════════════════════════════════════════════════
function ActiveScreen({ det }: { det: ReturnType<typeof useKeyDetection> }) {
  const {
    detectionState,
    currentKey,
    keyTier,
    liveConfidence,
    changeSuggestion,
    currentNote,
    recentNotes,
    isStable,
    isRunning,
    statusMessage,
    softInfo,
    mode,
    setMode,
    start,
    stop,
    reset,
  } = det;

  const confirmedKey = keyTier === 'confirmed' ? currentKey : null;
  const provisionalKey = keyTier === 'provisional' ? currentKey : null;

  const confPct = Math.round(Math.max(0, liveConfidence) * 100);
  const confColor = confPct >= 75 ? C.green : confPct >= 55 ? C.amber : C.text2;

  // Status textual contextual curto
  const statusLabel =
    detectionState === 'listening' ? 'OUVINDO' :
    detectionState === 'analyzing' ? 'ANALISANDO' :
    detectionState === 'provisional' ? 'REFINANDO TOM' :
    detectionState === 'change_possible' ? 'MUDANÇA?' :
    detectionState === 'confirmed' ? (isStable ? 'ESTÁVEL' : 'CONFIRMADO') :
    'PRONTO';

  const statusHint =
    detectionState === 'listening' ? 'Cante ou toque próximo ao microfone' :
    detectionState === 'analyzing' ? 'Identificando a tonalidade...' :
    detectionState === 'provisional' ? 'Continue — estou aumentando a precisão' :
    detectionState === 'change_possible' ? 'Avaliando possível troca de tom' :
    detectionState === 'confirmed' ? 'Tom identificado com segurança' :
    '';

  // Harmonic field (apenas quando tem tom confirmado ou provisional)
  const displayKey = confirmedKey || provisionalKey;
  const harmonicField = useMemo(
    () => displayKey ? getHarmonicField(displayKey.root, displayKey.quality) : [],
    [displayKey?.root, displayKey?.quality]
  );

  // Animações sutis
  const statusDot = useRef(new Animated.Value(1)).current;
  const noteOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(statusDot, { toValue: 0.25, duration: 700, useNativeDriver: true }),
        Animated.timing(statusDot, { toValue: 1,    duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  useEffect(() => {
    Animated.timing(noteOpacity, {
      toValue: currentNote !== null ? 1 : 0.3,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [currentNote]);

  const statusDotColor =
    detectionState === 'listening' ? C.text2 :
    detectionState === 'analyzing' ? C.amber :
    detectionState === 'provisional' ? C.amber :
    detectionState === 'change_possible' ? C.blue :
    detectionState === 'confirmed' ? C.green :
    C.text3;

  return (
    <View style={ss.activeRoot}>
      {/* ═══ HEADER ════════════════════════════════════════════════════════ */}
      <View style={ss.activeHeader}>
        <Image source={require('../assets/images/logo-icon.png')} style={ss.headerLogo} resizeMode="contain" />
        <Text style={ss.headerBrand}>Tom Certo</Text>
        <View style={ss.headerStatusRow}>
          <Animated.View style={[ss.statusDot, { backgroundColor: statusDotColor, opacity: statusDot }]} />
          <Text style={ss.headerStatusTxt} numberOfLines={1}>{statusLabel}</Text>
        </View>
        <TouchableOpacity
          testID="header-close-btn"
          style={ss.headerCloseBtn}
          onPress={() => {
            console.log('[UI] Header close pressed');
            reset();
          }}
          activeOpacity={0.6}
          hitSlop={{ top: 14, bottom: 14, left: 14, right: 14 }}
        >
          <Ionicons name="close" size={22} color={C.text2} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={ss.scrollPad}
        showsVerticalScrollIndicator={false}
      >
        {/* ═══ CAMADA 1 — STATUS / HINT ═══════════════════════════════════ */}
        {!!statusHint && (
          <Text style={ss.hintTxt}>{statusHint}</Text>
        )}

        {/* ═══ CAMADA 2 — NOTA ATUAL (GIGANTE, CENTRAL, TEMPO REAL) ══════ */}
        <View style={ss.noteHero}>
          <Text style={ss.noteHeroLabel}>NOTA EM TEMPO REAL</Text>
          <Animated.View style={[ss.noteHeroBox, { opacity: noteOpacity }]}>
            <Text style={ss.noteHeroTxt}>
              {currentNote !== null ? NOTES_BR[currentNote] : '—'}
            </Text>
            {currentNote !== null && (
              <Text style={ss.noteHeroIntl}>{NOTES_INTL[currentNote]}</Text>
            )}
          </Animated.View>
        </View>

        {/* ═══ CAMADA 3 — HISTÓRICO DE NOTAS ═════════════════════════════ */}
        <View style={ss.section}>
          <Text style={ss.sectionLabel}>HISTÓRICO</Text>
          <View style={ss.historyRow}>
            {recentNotes.length === 0 ? (
              <Text style={ss.historyEmpty}>— aguardando primeiras notas —</Text>
            ) : (
              recentNotes.map((pc, i) => {
                const isLatest = i === recentNotes.length - 1;
                return (
                  <View
                    key={`${pc}-${i}`}
                    style={[ss.historyChip, isLatest && ss.historyChipActive]}
                  >
                    <Text style={[ss.historyChipTxt, isLatest && ss.historyChipTxtActive]}>
                      {NOTES_BR[pc]}
                    </Text>
                  </View>
                );
              })
            )}
          </View>
        </View>

        {/* ═══ CAMADA 4 — TOM PROVÁVEL (aparece rápido, até baixa conf.) ═ */}
        {provisionalKey && (
          <View style={[ss.keyCard, ss.keyCardProv]}>
            <View style={ss.keyCardHeader}>
              <View style={[ss.keyCardBadge, { backgroundColor: C.amberMuted, borderColor: C.amberBorder }]}>
                <Ionicons name="musical-notes" size={11} color={C.amber} />
                <Text style={[ss.keyCardBadgeTxt, { color: C.amber }]}>TOM PROVÁVEL</Text>
              </View>
              <Text style={ss.keyCardConfPct}>{confPct}%</Text>
            </View>
            <KeyDisplay
              root={provisionalKey.root}
              quality={provisionalKey.quality}
              provisional
            />
            <ConfidenceBar pct={confPct} color={confColor} />
          </View>
        )}

        {/* ═══ CAMADA 5 — TOM CONFIRMADO (separado do provável) ═══════════ */}
        {confirmedKey && (
          <View style={[ss.keyCard, ss.keyCardConfirmed]}>
            <View style={ss.keyCardHeader}>
              <View style={[ss.keyCardBadge, { backgroundColor: 'rgba(34,197,94,0.10)', borderColor: 'rgba(34,197,94,0.35)' }]}>
                <Ionicons name="checkmark-circle" size={12} color={C.green} />
                <Text style={[ss.keyCardBadgeTxt, { color: C.green }]}>TOM CONFIRMADO</Text>
              </View>
              <Text style={[ss.keyCardConfPct, { color: C.green }]}>{confPct}%</Text>
            </View>
            <KeyDisplay root={confirmedKey.root} quality={confirmedKey.quality} />
            <ConfidenceBar pct={confPct} color={C.green} />
          </View>
        )}

        {/* ═══ CAMADA 6 — BANNER DE POSSÍVEL MUDANÇA ═════════════════════ */}
        {changeSuggestion && (
          <View style={ss.changeBanner}>
            <Ionicons name="swap-horizontal" size={16} color={C.blue} />
            <Text style={ss.changeBannerTxt}>
              Possível mudança para{' '}
              <Text style={ss.changeBannerStrong}>
                {formatKeyDisplay(changeSuggestion.root, changeSuggestion.quality).noteBr}{' '}
                {formatKeyDisplay(changeSuggestion.root, changeSuggestion.quality).qualityLabel}
              </Text>
            </Text>
          </View>
        )}

        {/* ═══ CAMADA 7 — CAMPO HARMÔNICO (quando há tom) ═════════════════ */}
        {displayKey && harmonicField.length > 0 && (
          <View style={ss.section}>
            <Text style={ss.sectionLabel}>CAMPO HARMÔNICO</Text>
            <View style={ss.chordGrid}>
              {harmonicField.map((chord, i) => (
                <View key={i} testID={`chord-${i}`}
                  style={[ss.chordCard, chord.isTonic && ss.chordCardTonic]}>
                  <Text style={ss.chordDegree}>{degreeLabel(i, displayKey.quality)}</Text>
                  <Text style={[ss.chordName, chord.isTonic && ss.chordNameTonic]}>{chord.label}</Text>
                  <Text style={ss.chordIntl}>{chordIntlLabel(chord.root, chord.quality)}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* ═══ CAMADA 8 — TOGGLE MODO AO VIVO / ESTÁVEL ═══════════════════ */}
        <ModeToggle mode={mode} onChange={setMode} />

        {/* ═══ CAMADA 9 — SOFT INFO ═══════════════════════════════════════ */}
        {softInfo ? (
          <View style={ss.softBar}>
            <Ionicons name="information-circle-outline" size={15} color={C.amber} />
            <Text style={ss.softBarTxt}>{softInfo}</Text>
          </View>
        ) : null}
      </ScrollView>

      {/* ═══ AÇÕES FIXAS NO RODAPÉ ═══════════════════════════════════════ */}
      <View style={ss.bottomActions} pointerEvents="box-none">
        {isRunning ? (
          <TouchableOpacity
            testID="stop-btn"
            style={ss.actionBtnDanger}
            onPress={() => {
              console.log('[UI] Stop button pressed');
              stop();
            }}
            activeOpacity={0.7}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Ionicons name="stop-circle" size={18} color={C.red} />
            <Text style={ss.actionBtnDangerTxt}>Parar</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            testID="resume-btn"
            style={ss.actionBtnGhost}
            onPress={() => {
              console.log('[UI] Resume button pressed');
              start();
            }}
            activeOpacity={0.7}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Ionicons name="play-circle" size={18} color={C.green} />
            <Text style={[ss.actionBtnGhostTxt, { color: C.green }]}>Continuar</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          testID="reset-btn"
          style={ss.actionBtnGhost}
          onPress={() => {
            console.log('[UI] Reset button pressed');
            reset();
          }}
          activeOpacity={0.7}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Ionicons name="refresh" size={16} color={C.text2} />
          <Text style={ss.actionBtnGhostTxt}>Nova detecção</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Sub-componentes ─────────────────────────────────────────────────────────
function KeyDisplay({ root, quality, provisional }: {
  root: number; quality: 'major' | 'minor'; provisional?: boolean;
}) {
  const k = formatKeyDisplay(root, quality);
  return (
    <View style={ss.keyDisplayRow}>
      <Text style={ss.keyDisplayNote}>{k.noteBr}</Text>
      <Text style={[ss.keyDisplayQual, provisional && { color: C.amber }]}>
        {k.qualityLabel}
      </Text>
      <Text style={ss.keyDisplayIntl}>({k.noteIntl})</Text>
    </View>
  );
}

function ConfidenceBar({ pct, color }: { pct: number; color: string }) {
  return (
    <View style={ss.confBarBg}>
      <View style={[ss.confBarFill, { width: `${Math.min(100, pct)}%`, backgroundColor: color }]} />
    </View>
  );
}

function ModeToggle({ mode, onChange }: {
  mode: DetectionMode; onChange: (m: DetectionMode) => void;
}) {
  return (
    <View style={ss.section}>
      <Text style={ss.sectionLabel}>MODO DE DETECÇÃO</Text>
      <View style={ss.modeRow}>
        <TouchableOpacity
          testID="mode-live-btn"
          style={[ss.modeBtn, mode === 'live' && ss.modeBtnActive]}
          onPress={() => onChange('live')}
          activeOpacity={0.75}
        >
          <Ionicons
            name="flash"
            size={14}
            color={mode === 'live' ? C.amber : C.text3}
          />
          <View style={{ flex: 1 }}>
            <Text style={[ss.modeBtnTitle, mode === 'live' && ss.modeBtnTitleActive]}>
              Ao Vivo
            </Text>
            <Text style={ss.modeBtnSub}>Troca rápida (~2s)</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity
          testID="mode-stable-btn"
          style={[ss.modeBtn, mode === 'stable' && ss.modeBtnActive]}
          onPress={() => onChange('stable')}
          activeOpacity={0.75}
        >
          <Ionicons
            name="shield-checkmark"
            size={14}
            color={mode === 'stable' ? C.amber : C.text3}
          />
          <View style={{ flex: 1 }}>
            <Text style={[ss.modeBtnTitle, mode === 'stable' && ss.modeBtnTitleActive]}>
              Estável
            </Text>
            <Text style={ss.modeBtnSub}>Máxima precisão (~3.5s)</Text>
          </View>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// MicNoticeModal
// ═════════════════════════════════════════════════════════════════════════════
function MicNoticeModal({ visible, onClose, onRetry, reason, message }: {
  visible: boolean; onClose: () => void; onRetry: () => void;
  reason: string | null; message: string | null;
}) {
  const isBlocked = reason === 'permission_blocked';
  const isPerm    = reason === 'permission_denied' || isBlocked;
  const isLimit   = reason === 'platform_limit';
  const icon: any = isPerm ? 'mic-off' : isLimit ? 'construct-outline' : 'information-circle';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={ss.modalBg}>
        <View style={ss.modalCard}>
          <Ionicons name={icon} size={30} color={isPerm ? C.red : C.amber} style={{ marginBottom: 14 }} />
          <Text style={ss.modalTitle}>{isPerm ? 'Microfone bloqueado' : isLimit ? 'Recurso nativo' : 'Aviso'}</Text>
          <Text style={ss.modalMsg}>{message ?? 'Algo deu errado.'}</Text>
          <View style={{ gap: 8, width: '100%', marginTop: 20 }}>
            {isBlocked && Platform.OS !== 'web' ? (
              <TouchableOpacity testID="open-settings-btn" style={ss.modalPrimary} onPress={async () => { try { await Linking.openSettings(); } catch {} }} activeOpacity={0.85}>
                <Text style={ss.modalPrimaryTxt}>Abrir Configurações</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity testID="retry-mic-btn" style={ss.modalPrimary} onPress={onRetry} activeOpacity={0.85}>
                <Text style={ss.modalPrimaryTxt}>{isPerm ? 'Permitir Microfone' : 'Tentar novamente'}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity testID="close-modal-btn" style={ss.modalSecondary} onPress={onClose}>
              <Text style={ss.modalSecondaryTxt}>Fechar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function degreeLabel(i: number, _q: 'major' | 'minor') {
  return (['I','ii','iii','IV','V','vi'] as const)[i] ?? '';
}
function chordIntlLabel(root: number, q: 'major' | 'minor' | 'dim') {
  return NOTES_INTL[root] + (q === 'minor' ? 'm' : q === 'dim' ? '°' : '');
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const MIC_SIZE   = 128;
const CHORD_GAP  = 8;
const CHORD_W    = (SW - 32 - CHORD_GAP * 2) / 3;

const ss = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },

  // ═══ INITIAL ══════════════════════════════════════════════════════════════
  initialRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: SH * 0.10,
    paddingBottom: 36,
    paddingHorizontal: 24,
  },
  brandBlock: { alignItems: 'center' },
  logoClean: { width: 220, height: 220 },

  micSection: {
    alignItems: 'center',
    justifyContent: 'center',
    width: MIC_SIZE * 3,
    height: MIC_SIZE * 3,
  },
  micRing: {
    position: 'absolute',
    width: MIC_SIZE,
    height: MIC_SIZE,
    borderRadius: MIC_SIZE / 2,
    borderWidth: 1.5,
    borderColor: C.amber,
  },
  micBtn: {
    width: MIC_SIZE,
    height: MIC_SIZE,
    borderRadius: MIC_SIZE / 2,
    backgroundColor: C.amber,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios:     { shadowColor: C.amber, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.6, shadowRadius: 28 },
      android: { elevation: 10 },
      default: {},
    }),
  },
  micLabel: {
    position: 'absolute',
    bottom: 12,
    fontFamily: 'Manrope_500Medium',
    fontSize: 13,
    color: C.text3,
    letterSpacing: 0.5,
  },

  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: C.redMuted,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.25)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    width: '100%',
  },
  errorTxt: {
    flex: 1,
    fontFamily: 'Manrope_500Medium',
    fontSize: 12,
    color: C.red,
    lineHeight: 16,
  },

  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  logoutTxt: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 11,
    color: C.text3,
    letterSpacing: 0.4,
  },

  // ═══ ACTIVE SCREEN ═════════════════════════════════════════════════════════
  activeRoot: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 6,
  },
  activeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    marginBottom: 8,
  },
  headerLogo: { width: 26, height: 26 },
  headerBrand: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 15,
    color: C.white,
    flex: 1,
    letterSpacing: -0.3,
  },
  headerStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: C.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  headerStatusTxt: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 10,
    color: C.text2,
    letterSpacing: 1.5,
  },
  headerCloseBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    marginLeft: 4,
  },

  scrollPad: { paddingBottom: 16, gap: 14 },
  hintTxt: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 12,
    color: C.text3,
    textAlign: 'center',
    paddingHorizontal: 12,
    marginTop: 2,
    letterSpacing: 0.2,
  },

  // NOTA HERO
  noteHero: {
    alignItems: 'center',
    paddingVertical: 14,
    backgroundColor: C.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: C.border,
  },
  noteHeroLabel: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 9.5,
    color: C.text3,
    letterSpacing: 2.5,
    marginBottom: 2,
  },
  noteHeroBox: { alignItems: 'center' },
  noteHeroTxt: {
    fontFamily: 'Outfit_800ExtraBold',
    fontSize: 86,
    color: C.white,
    letterSpacing: -3,
    lineHeight: 94,
    ...Platform.select({
      ios: { textShadowColor: C.amberGlow, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 24 },
      default: {},
    }),
  },
  noteHeroIntl: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 13,
    color: C.text2,
    letterSpacing: 0.8,
    marginTop: -4,
  },

  // SECTIONS
  section: { gap: 8 },
  sectionLabel: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 10,
    color: C.text3,
    letterSpacing: 2.5,
    paddingHorizontal: 2,
  },

  // HISTÓRICO
  historyRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: C.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    minHeight: 44,
    alignItems: 'center',
  },
  historyEmpty: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 11,
    color: C.text3,
    fontStyle: 'italic',
  },
  historyChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    minWidth: 32,
    alignItems: 'center',
  },
  historyChipActive: {
    backgroundColor: 'rgba(255,176,32,0.14)',
    borderColor: 'rgba(255,176,32,0.50)',
  },
  historyChipTxt: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 12,
    color: C.text2,
    letterSpacing: 0.3,
  },
  historyChipTxtActive: { color: C.amber },

  // KEY CARDS
  keyCard: {
    backgroundColor: C.surface,
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    gap: 10,
  },
  keyCardProv: { borderColor: C.amberBorder },
  keyCardConfirmed: { borderColor: 'rgba(34,197,94,0.30)' },
  keyCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  keyCardBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 99,
    borderWidth: 1,
  },
  keyCardBadgeTxt: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 9.5,
    letterSpacing: 1.8,
  },
  keyCardConfPct: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 13,
    color: C.text2,
    letterSpacing: -0.3,
  },
  keyDisplayRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  keyDisplayNote: {
    fontFamily: 'Outfit_800ExtraBold',
    fontSize: 40,
    color: C.white,
    lineHeight: 44,
    letterSpacing: -1.2,
  },
  keyDisplayQual: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 22,
    color: C.white,
    letterSpacing: -0.5,
  },
  keyDisplayIntl: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 13,
    color: C.text3,
  },
  confBarBg: {
    height: 4,
    borderRadius: 99,
    backgroundColor: 'rgba(255,255,255,0.06)',
    overflow: 'hidden',
  },
  confBarFill: {
    height: '100%',
    borderRadius: 99,
  },

  // CHANGE BANNER
  changeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: 'rgba(96,165,250,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(96,165,250,0.35)',
  },
  changeBannerTxt: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 12.5,
    color: C.text2,
    letterSpacing: 0.2,
    flexShrink: 1,
  },
  changeBannerStrong: {
    fontFamily: 'Outfit_700Bold',
    color: C.blue,
  },

  // CAMPO HARMÔNICO
  chordGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: CHORD_GAP },
  chordCard: {
    width: CHORD_W,
    backgroundColor: C.surface,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: C.border,
  },
  chordCardTonic: { backgroundColor: C.amberMuted, borderColor: C.amberBorder },
  chordDegree: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 10,
    color: C.text3,
    letterSpacing: 1,
    marginBottom: 2,
  },
  chordName: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 16,
    color: C.white,
    letterSpacing: -0.3,
  },
  chordNameTonic: { color: C.amber },
  chordIntl: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 10,
    color: C.text3,
    marginTop: 1,
  },

  // MODE TOGGLE
  modeRow: { flexDirection: 'row', gap: 8 },
  modeBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    borderRadius: 12,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  modeBtnActive: {
    backgroundColor: C.amberMuted,
    borderColor: C.amberBorder,
  },
  modeBtnTitle: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 13,
    color: C.text2,
    letterSpacing: -0.2,
  },
  modeBtnTitleActive: { color: C.amber },
  modeBtnSub: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 10,
    color: C.text3,
    marginTop: 1,
  },

  // SOFT INFO
  softBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: C.amberMuted,
    borderWidth: 1,
    borderColor: C.amberBorder,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  softBarTxt: {
    flex: 1,
    fontFamily: 'Manrope_500Medium',
    fontSize: 12,
    color: C.amber,
    lineHeight: 16,
  },

  // BOTTOM ACTIONS
  bottomActions: {
    flexDirection: 'row',
    gap: 10,
    paddingTop: 10,
    paddingBottom: 10,
    borderTopWidth: 1,
    borderTopColor: C.border,
    backgroundColor: C.bg,
    zIndex: 100,
    ...Platform.select({
      android: { elevation: 12 },
      default: {},
    }),
  },
  actionBtnDanger: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    height: 52,
    borderRadius: 99,
    backgroundColor: C.redMuted,
    borderWidth: 1.5,
    borderColor: C.red,
  },
  actionBtnDangerTxt: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 15,
    color: C.red,
  },
  actionBtnGhost: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    height: 52,
    borderRadius: 99,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.borderStrong,
  },
  actionBtnGhostTxt: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 14,
    color: C.text2,
  },

  // ═══ MODAL ══════════════════════════════════════════════════════════════
  modalBg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  modalCard: {
    backgroundColor: C.surface,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: C.border,
    padding: 28,
    width: '100%',
    alignItems: 'center',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.5, shadowRadius: 28 },
      android: { elevation: 14 },
      default: {},
    }),
  },
  modalTitle: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 20,
    color: C.white,
    marginBottom: 8,
    letterSpacing: -0.3,
  },
  modalMsg: {
    fontFamily: 'Manrope_400Regular',
    fontSize: 14,
    color: C.text2,
    textAlign: 'center',
    lineHeight: 20,
  },
  modalPrimary: {
    height: 48,
    borderRadius: 99,
    backgroundColor: C.amber,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalPrimaryTxt: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 15,
    color: C.bg,
    letterSpacing: 0.4,
  },
  modalSecondary: { height: 40, alignItems: 'center', justifyContent: 'center' },
  modalSecondaryTxt: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 13,
    color: C.text2,
  },
});
