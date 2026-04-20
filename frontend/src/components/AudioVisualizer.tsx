import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Easing } from 'react-native';

interface Props {
  level: number;           // 0..1
  color?: string;
  height?: number;
  bars?: number;
  active?: boolean;        // se falso, bars caem para baixo
}

/**
 * Visualizador de áudio: N barras animadas que sobem/descem baseado no RMS.
 * Cada barra tem um fator de fase diferente pra parecer uma onda orgânica.
 */
export default function AudioVisualizer({
  level,
  color = '#FFB020',
  height = 56,
  bars = 7,
  active = true,
}: Props) {
  const animRefs = useRef<Animated.Value[]>(
    Array.from({ length: bars }, () => new Animated.Value(0.1))
  ).current;

  useEffect(() => {
    if (!active) {
      animRefs.forEach(v => {
        Animated.timing(v, { toValue: 0.1, duration: 180, useNativeDriver: false }).start();
      });
      return;
    }

    // Cada barra recebe uma altura alvo baseada no level, com variação senoidal
    const now = Date.now() / 200;
    animRefs.forEach((v, i) => {
      const phase = (i / bars) * Math.PI * 2;
      // Variação sinusoidal para parecer onda
      const wave = 0.5 + 0.5 * Math.sin(now + phase);
      // Mistura level (base) com wave (variação)
      const target = Math.max(0.15, Math.min(1, level * 0.8 + wave * level * 0.5 + 0.1));
      Animated.timing(v, {
        toValue: target,
        duration: 120,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start();
    });
  }, [level, active, bars, animRefs]);

  return (
    <View style={[s.row, { height }]}>
      {animRefs.map((v, i) => (
        <Animated.View
          key={i}
          style={[
            s.bar,
            {
              backgroundColor: color,
              height: v.interpolate({
                inputRange: [0, 1],
                outputRange: [height * 0.12, height],
              }),
              opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
            },
          ]}
        />
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  bar: {
    width: 5,
    borderRadius: 3,
  },
});
