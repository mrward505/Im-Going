/**
 * Spot detail — STUB for slice 4b (full spot detail + posts + share card
 * land in 4c per the DoD). Shows the masked spot card per §2b display rules
 * plus the wiring point for the event detail.
 */
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { api, ApiError } from "../api/client";
import type { Spot } from "../api/types";
import { colors, spacing } from "../theme";
import { CategoryPill } from "../components/hero";

interface Props {
  spotId: string;
  onBack: () => void;
}

export function SpotDetailStub({ spotId, onBack }: Props): React.JSX.Element {
  const [spot, setSpot] = useState<Spot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.spot(spotId);
        setSpot(res.spot);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Could not load this spot.");
      }
    })();
  }, [spotId]);

  return (
    <View style={styles.container}>
      <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
        <Text style={styles.backText}>← Trending</Text>
      </Pressable>
      {!spot && !error ? (
        <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: spacing.xl }} />
      ) : error ? (
        <Text style={styles.error}>{error}</Text>
      ) : spot ? (
        <>
          <Text style={styles.name}>{spot.name}</Text>
          <View style={styles.meta}>
            <CategoryPill category={spot.category} />
            <Text style={styles.city}>{spot.city}</Text>
          </View>
          <Text style={styles.address}>
            {spot.is_verified
              ? (spot.address ?? "Address coming soon")
              : (spot.masked_address ?? "Private spot")}
          </Text>
          {!spot.is_verified && spot.address == null ? (
            <Text style={styles.maskNote}>Exact address unlocks after you tap “I&apos;m going.”</Text>
          ) : null}
          <View style={styles.stub}>
            <Text style={styles.stubText}>Full spot detail — events, going list, check-in, posts, share — lands in 4c.</Text>
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
  },
  back: {
    marginBottom: spacing.md,
  },
  backText: {
    color: colors.primary,
    fontWeight: "700",
    fontSize: 15,
  },
  name: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "800",
  },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  city: {
    color: colors.textDim,
    fontSize: 13,
  },
  address: {
    color: colors.text,
    fontSize: 15,
    marginTop: spacing.sm,
  },
  maskNote: {
    color: colors.star,
    fontSize: 13,
    marginTop: 4,
  },
  error: {
    color: colors.danger,
    fontSize: 14,
    marginTop: spacing.lg,
  },
  stub: {
    marginTop: spacing.lg,
    padding: spacing.md,
    borderRadius: 12,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
  },
  stubText: {
    color: colors.textDim,
    fontSize: 13,
    lineHeight: 19,
  },
});
