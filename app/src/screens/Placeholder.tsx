/**
 * Placeholder screens for the main tabs (Trending / My Plans / Profile).
 * The hero screens are Slice 4b — these only prove navigation + tab bar.
 */
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, spacing } from "../theme";

interface Props {
  title: string;
  subtitle: string;
}

export function PlaceholderScreen({ title, subtitle }: Props): React.JSX.Element {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{subtitle}</Text>
      <View style={styles.pill}>
        <Text style={styles.pillText}>Shell slice 4a — hero screens land in 4b</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: "700",
  },
  subtitle: {
    color: colors.textDim,
    fontSize: 15,
    marginTop: spacing.sm,
    textAlign: "center",
    lineHeight: 22,
  },
  pill: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pillText: {
    color: colors.textDim,
    fontSize: 13,
  },
});