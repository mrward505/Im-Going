/**
 * Onboarding — Welcome step (spec §3 screen 1). Value pitch + CTA.
 */
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, spacing } from "../../theme";

interface Props {
  onStart: () => void;
}

export function WelcomeScreen({ onStart }: Props): React.JSX.Element {
  return (
    <View style={styles.container}>
      <View style={styles.hero}>
        <Text style={styles.logo}>I&apos;m Going</Text>
        <Text style={styles.tagline}>
          Give your night an audience. Say where you&apos;ll be, see who&apos;s going, show up, earn your stars.
        </Text>
      </View>
      <View style={styles.facts}>
        {[
          "Announce where you're going tonight",
          "See what's trending in Tempe",
          "Friends confirm — the place fills up",
          "Show up and build a 1–5★ reputation",
        ].map((line) => (
          <Text key={line} style={styles.fact}>
            • {line}
          </Text>
        ))}
      </View>
      <Pressable
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        onPress={onStart}
      >
        <Text style={styles.buttonText}>Get started</Text>
      </Pressable>
      <Text style={styles.legal}>18+ only · Tempe, AZ launch city</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.xl,
    justifyContent: "space-between",
  },
  hero: {
    marginTop: spacing.xl * 2,
  },
  logo: {
    color: colors.text,
    fontSize: 36,
    fontWeight: "800",
    letterSpacing: -0.5,
  },
  tagline: {
    color: colors.textDim,
    fontSize: 17,
    lineHeight: 25,
    marginTop: spacing.md,
  },
  facts: {
    marginVertical: spacing.lg,
    gap: spacing.sm,
  },
  fact: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonText: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "700",
  },
  legal: {
    color: colors.textDim,
    fontSize: 12,
    textAlign: "center",
    marginTop: spacing.md,
  },
});