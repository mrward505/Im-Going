/**
 * Onboarding — Welcome step (spec §3 screen 1). Value pitch + CTA.
 * Nightlife polish (2026-09-07): dark ambient backdrop, neon CTA with a slow
 * glow pulse, same copy/facts/navigation — visual polish only.
 */
import React, { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, neon, spacing } from "../../theme";
import { NightlifeBackdrop } from "../../components/NightlifeBackdrop";

interface Props {
  onStart: () => void;
}

export function WelcomeScreen({ onStart }: Props): React.JSX.Element {
  const glow = useRef(new Animated.Value(0.6)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(glow, {
          toValue: 1,
          duration: 1800,
          // JS driver: web-safe (native animated module absent on web).
          useNativeDriver: false,
        }),
        Animated.timing(glow, {
          toValue: 0.6,
          duration: 1800,
          useNativeDriver: false,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [glow]);

  return (
    <View style={styles.container}>
      <NightlifeBackdrop />
      <View style={styles.content}>
        <View style={styles.hero}>
          <View style={styles.livePill}>
            <View style={styles.liveDot} />
            <Text style={styles.livePillText}>TONIGHT IN TEMPE</Text>
          </View>
          <Text style={styles.logo}>
            I&apos;m <Text style={styles.logoNeon}>Going</Text>
          </Text>
          <Text style={styles.tagline}>
            Give your night an audience. Say where you&apos;ll be, see who&apos;s going, show up,
            earn your stars.
          </Text>
        </View>
        <View style={styles.facts}>
          {[
            "Announce where you're going tonight",
            "See what's trending in Tempe",
            "Friends confirm — the place fills up",
            "Show up and build a 1–5★ reputation",
          ].map((line) => (
            <View key={line} style={styles.factRow}>
              <View style={styles.factTick} />
              <Text style={styles.fact}>{line}</Text>
            </View>
          ))}
        </View>
        <Animated.View style={[styles.ctaGlow, { opacity: glow }]}>
          <Pressable
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
            onPress={onStart}
          >
            <Text style={styles.buttonText}>Get started →</Text>
          </Pressable>
        </Animated.View>
        <Text style={styles.legal}>18+ only · Tempe, AZ launch city</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: neon.bgDeep,
  },
  content: {
    flex: 1,
    padding: spacing.xl,
    justifyContent: "space-between",
  },
  hero: {
    marginTop: spacing.xl * 2,
  },
  livePill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 7,
    borderWidth: 1,
    borderColor: neon.pink,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: spacing.md,
    backgroundColor: "rgba(255, 61, 127, 0.12)",
    shadowColor: neon.pink,
    shadowOpacity: 0.7,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: neon.pink,
  },
  livePillText: {
    color: neon.pink,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.5,
  },
  logo: {
    color: colors.text,
    fontSize: 44,
    fontWeight: "900",
    letterSpacing: -1,
    textShadowColor: neon.purpleGlow,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 24,
  },
  logoNeon: {
    color: neon.pink,
    textShadowColor: neon.pinkGlow,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 28,
  },
  tagline: {
    color: colors.text,
    fontSize: 17,
    lineHeight: 25,
    marginTop: spacing.md,
    opacity: 0.92,
  },
  facts: {
    marginVertical: spacing.lg,
    gap: spacing.md,
    backgroundColor: "rgba(13, 16, 38, 0.72)",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    padding: spacing.md,
  },
  factRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  factTick: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: neon.cyan,
    shadowColor: neon.cyan,
    shadowOpacity: 0.9,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },
  fact: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
    flex: 1,
  },
  ctaGlow: {
    borderRadius: 16,
    shadowColor: neon.pink,
    shadowOpacity: 0.9,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  button: {
    backgroundColor: neon.pink,
    borderRadius: 16,
    paddingVertical: spacing.md + 2,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#FF7AA5",
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  legal: {
    color: colors.textDim,
    fontSize: 12,
    textAlign: "center",
    marginTop: spacing.md,
  },
});
