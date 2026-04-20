import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Animated,
  Dimensions,
  Easing,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Image,
  Keyboard,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import {
  useFonts,
  Outfit_800ExtraBold,
  Outfit_700Bold,
} from '@expo-google-fonts/outfit';
import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
} from '@expo-google-fonts/manrope';
import { useAuth } from './AuthContext';

const { height: SH } = Dimensions.get('window');

// ─── Design tokens (matching index.tsx) ─────────────────────────────────────
const C = {
  bg:           '#000000',
  surface:      '#0B0B0B',
  amber:        '#FFB020',
  amberDim:     'rgba(255,176,32,0.35)',
  amberFaint:   'rgba(255,176,32,0.15)',
  white:        '#FFFFFF',
  text2:        '#A0A0A0',
  text3:        '#555555',
  red:          '#EF4444',
  redFaint:     'rgba(239,68,68,0.10)',
};

export default function ActivationScreen() {
  const [fontsLoaded] = useFonts({
    Outfit_800ExtraBold,
    Outfit_700Bold,
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
  });

  const { activate, errorMessage, clearError } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);

  // Entrance anims
  const fade = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(24)).current;

  // Logo subtle breath glow
  const logoGlow = useRef(new Animated.Value(0.75)).current;

  // Error shake
  const errorShake = useRef(new Animated.Value(0)).current;

  // Focus underline glow
  const underlineScale = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 650, useNativeDriver: true }),
      Animated.timing(slide, {
        toValue: 0,
        duration: 650,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(logoGlow, {
          toValue: 1,
          duration: 2000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(logoGlow, {
          toValue: 0.75,
          duration: 2000,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  useEffect(() => {
    Animated.timing(underlineScale, {
      toValue: focused || code.length > 0 ? 1 : 0.6,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [focused, code]);

  useEffect(() => {
    if (errorMessage) {
      Animated.sequence([
        Animated.timing(errorShake, { toValue: 10, duration: 50, useNativeDriver: true }),
        Animated.timing(errorShake, { toValue: -10, duration: 50, useNativeDriver: true }),
        Animated.timing(errorShake, { toValue: 6, duration: 50, useNativeDriver: true }),
        Animated.timing(errorShake, { toValue: -6, duration: 50, useNativeDriver: true }),
        Animated.timing(errorShake, { toValue: 0, duration: 50, useNativeDriver: true }),
      ]).start();
    }
  }, [errorMessage]);

  const onChangeCode = (t: string) => {
    if (errorMessage) clearError();
    setCode(t.toUpperCase().replace(/\s+/g, ''));
  };

  const onSubmit = async () => {
    if (busy || !code.trim()) return;
    Keyboard.dismiss();
    setBusy(true);
    await activate(code);
    setBusy(false);
  };

  if (!fontsLoaded) {
    return (
      <View style={ss.splash}>
        <Text style={ss.splashTxt}>Tom Certo</Text>
      </View>
    );
  }

  const canSubmit = !busy && code.trim().length > 0;

  return (
    <SafeAreaView style={ss.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={ss.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Animated.View
            style={[ss.container, { opacity: fade, transform: [{ translateY: slide }] }]}
          >
            {/* ── Brand block ── */}
            <View style={ss.brandBlock}>
              <Animated.Image
                source={require('../../assets/images/logo-icon.png')}
                style={[ss.logo, { opacity: logoGlow }]}
                resizeMode="contain"
              />
              <Text style={ss.appName}>Tom Certo</Text>
              <Text style={ss.tagline}>Detector de tonalidade</Text>
            </View>

            {/* ── Input: minimalist underline ── */}
            <Animated.View style={[ss.inputBlock, { transform: [{ translateX: errorShake }] }]}>
              <Text style={ss.inputLabel}>TOKEN DE ACESSO</Text>
              <TextInput
                testID="activation-code-input"
                style={ss.input}
                value={code}
                onChangeText={onChangeCode}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                onSubmitEditing={onSubmit}
                placeholder="XXXX-XXXXXX"
                placeholderTextColor={C.text3}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={20}
                returnKeyType="done"
                selectionColor={C.amber}
                underlineColorAndroid="transparent"
              />
              {/* Base underline */}
              <View style={ss.underlineBase} />
              {/* Active underline grows from center */}
              <Animated.View
                style={[
                  ss.underlineActive,
                  {
                    transform: [{ scaleX: underlineScale }],
                    opacity: focused || code.length > 0 ? 1 : 0.5,
                  },
                ]}
              />

              {errorMessage ? (
                <View style={ss.errorRow}>
                  <Ionicons name="alert-circle" size={15} color={C.red} />
                  <Text style={ss.errorTxt} numberOfLines={3}>{errorMessage}</Text>
                </View>
              ) : null}
            </Animated.View>

            {/* ── Primary CTA ── */}
            <TouchableOpacity
              testID="activate-btn"
              style={[ss.primaryBtn, !canSubmit && ss.primaryBtnDisabled]}
              onPress={onSubmit}
              disabled={!canSubmit}
              activeOpacity={0.88}
            >
              {busy ? (
                <ActivityIndicator color={C.bg} size="small" />
              ) : (
                <Text style={ss.primaryBtnTxt}>Ativar acesso</Text>
              )}
            </TouchableOpacity>

            {/* ── Footer ── */}
            <View style={ss.footer}>
              <Ionicons name="lock-closed-outline" size={11} color={C.text3} />
              <Text style={ss.footerTxt}>
                Seu acesso fica salvo neste dispositivo
              </Text>
            </View>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const ss = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  splash: {
    flex: 1,
    backgroundColor: C.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  splashTxt: {
    fontSize: 28,
    fontFamily: 'Outfit_800ExtraBold',
    color: C.amber,
    letterSpacing: -0.5,
  },

  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingVertical: 40,
  },
  container: {
    paddingHorizontal: 32,
    alignItems: 'center',
  },

  // Brand
  brandBlock: {
    alignItems: 'center',
    marginBottom: SH * 0.08,
  },
  logo: {
    width: 110,
    height: 110,
    marginBottom: 18,
  },
  appName: {
    fontFamily: 'Outfit_800ExtraBold',
    fontSize: 34,
    color: C.white,
    letterSpacing: -1,
    textAlign: 'center',
  },
  tagline: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 11,
    color: C.text3,
    letterSpacing: 3,
    textTransform: 'uppercase',
    marginTop: 6,
  },

  // Input — minimalist underline (NO card)
  inputBlock: {
    width: '100%',
    alignItems: 'center',
    marginBottom: 36,
  },
  inputLabel: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 10,
    color: C.amber,
    letterSpacing: 3,
    marginBottom: 14,
    alignSelf: 'center',
  },
  input: {
    width: '100%',
    fontFamily: 'Outfit_700Bold',
    fontSize: 22,
    color: C.white,
    letterSpacing: 4,
    textAlign: 'center',
    paddingVertical: 12,
    paddingHorizontal: 8,
    ...Platform.select({ web: { outlineWidth: 0 as any } as any, default: {} }),
  },
  underlineBase: {
    width: '100%',
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  underlineActive: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: C.amber,
    ...Platform.select({
      ios: {
        shadowColor: C.amber,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.7,
        shadowRadius: 6,
      },
      default: {},
    }),
  },

  errorRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 14,
    paddingHorizontal: 4,
  },
  errorTxt: {
    flex: 1,
    fontFamily: 'Manrope_500Medium',
    fontSize: 12,
    color: C.red,
    lineHeight: 16,
  },

  // Primary button
  primaryBtn: {
    width: '100%',
    height: 56,
    borderRadius: 99,
    backgroundColor: C.amber,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: {
        shadowColor: C.amber,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.45,
        shadowRadius: 20,
      },
      android: { elevation: 8 },
      default: {},
    }),
  },
  primaryBtnDisabled: {
    backgroundColor: 'rgba(255,176,32,0.25)',
    ...Platform.select({
      ios: { shadowOpacity: 0 },
      android: { elevation: 0 },
      default: {},
    }),
  },
  primaryBtnTxt: {
    fontFamily: 'Outfit_700Bold',
    fontSize: 16,
    color: C.bg,
    letterSpacing: 0.5,
  },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 24,
  },
  footerTxt: {
    fontFamily: 'Manrope_500Medium',
    fontSize: 11,
    color: C.text3,
    letterSpacing: 0.3,
  },
});
