/**
 * Onboarding — under-18 rejection screen (spec §2a: "I'm Going is 18+").
 * No account is created.
 */
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, spacing } from "../../theme";

interface Props {
  onExit: () => void;
}

export function UnderageScreen({ onExit }: Props): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Text style={styles.emoji}>🔞</Text>
      <Text style={styles.title}>I&apos;m Going is 18+</Text>
      <Text style={styles.body}>
        We can&apos;t create an account for you yet. This app is for adults only — check back when
        you&apos;re 18. No account was created, and we don&apos;t keep the phone number you entered.
      </Text>
      <Pressable
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        onPress={onExit}
      >
        <Text style={styles.buttonText}>OK, got it</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl * 1.5,
  },
  emoji: {
    fontSize: 52,
    marginBottom: spacing.lg,
  },
  title: {
    color: colors.text,
    fontSize: 26,
    fontWeight: "800",
    textAlign: "center",
  },
  body: {
    color: colors.textDim,
    fontSize: 15,
    lineHeight: 23,
    textAlign: "center",
    marginTop: spacing.md,
    marginBottom: spacing.xl,
  },
  button: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl * 2,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonText: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
});