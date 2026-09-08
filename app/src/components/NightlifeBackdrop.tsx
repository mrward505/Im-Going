/**
 * NightlifeBackdrop — cosmetic ambient glow layer for onboarding screens
 * (owner direction 2026-09-07: "feel alive, not plain"). Pure decoration:
 * deep navy base + pink/purple/cyan glow orbs with a slow breathing pulse.
 * No data, no interactivity, no invented numbers — background only.
 */
import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { neon } from "../theme";

function useBreath(delayMs: number): Animated.Value {
  const v = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, {
          toValue: 1,
          duration: 2600,
          delay: delayMs,
          // JS driver: this animation runs on web where the native animated
          // module is absent (useNativeDriver warns on web).
          useNativeDriver: false,
        }),
        Animated.timing(v, {
          toValue: 0.55,
          duration: 2600,
          useNativeDriver: false,
        }),
      ]),
    );
    const t = setTimeout(() => loop.start(), delayMs);
    return () => {
      clearTimeout(t);
      loop.stop();
    };
  }, [delayMs, v]);
  return v;
}

export function NightlifeBackdrop(): React.JSX.Element {
  const a = useBreath(0);
  const b = useBreath(900);
  const c = useBreath(1700);
  return (
    <View style={styles.base} pointerEvents="none">
      <View style={styles.navyWash} />
      <Animated.View style={[styles.orb, styles.orbPink, { opacity: a }]} />
      <Animated.View style={[styles.orb, styles.orbPurple, { opacity: b }]} />
      <Animated.View style={[styles.orb, styles.orbCyan, { opacity: c }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    ...StyleSheet.absoluteFill,
    backgroundColor: neon.bgDeep,
    overflow: "hidden",
  },
  navyWash: {
    ...StyleSheet.absoluteFill,
    backgroundColor: neon.bgNavy,
    opacity: 0.55,
  },
  orb: {
    position: "absolute",
    borderRadius: 999,
  },
  orbPink: {
    width: 340,
    height: 340,
    top: -120,
    right: -110,
    backgroundColor: neon.pink,
    opacity: 0.55,
    shadowColor: neon.pink,
    shadowOpacity: 0.9,
    shadowRadius: 90,
    shadowOffset: { width: 0, height: 0 },
  },
  orbPurple: {
    width: 300,
    height: 300,
    top: "38%",
    left: -130,
    backgroundColor: neon.purple,
    opacity: 0.55,
    shadowColor: neon.purple,
    shadowOpacity: 0.9,
    shadowRadius: 90,
    shadowOffset: { width: 0, height: 0 },
  },
  orbCyan: {
    width: 220,
    height: 220,
    bottom: -90,
    right: "12%",
    backgroundColor: neon.cyan,
    opacity: 0.35,
    shadowColor: neon.cyan,
    shadowOpacity: 0.8,
    shadowRadius: 80,
    shadowOffset: { width: 0, height: 0 },
  },
});
