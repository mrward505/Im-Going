/**
 * Spot detail (slice 4c): masked spot card per §2b display rules, next
 * upcoming event + live going count + my-going state (from
 * GET /api/v1/spots/:id), and the share-card snapshot affordance
 * (GET /api/v1/spots/:id/share, 10/day budget). Posts feed is still later.
 */
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { api, ApiError } from "../api/client";
import type { SpotDetailResponse, SpotShareResponse } from "../api/types";
import { colors, spacing } from "../theme";
import { CategoryPill, formatNextStart } from "../components/hero";

interface Props {
  spotId: string;
  onBack: () => void;
}

export function SpotDetailStub({ spotId, onBack }: Props): React.JSX.Element {
  const [detail, setDetail] = useState<SpotDetailResponse | null>(null);
  const [share, setShare] = useState<SpotShareResponse | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.spot(spotId);
        setDetail(res);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Could not load this spot.");
      }
    })();
  }, [spotId]);

  const spot = detail?.spot ?? null;

  async function loadShare(): Promise<void> {
    setShareError(null);
    try {
      const res = await api.spotShare(spotId);
      setShare(res);
    } catch (e) {
      setShareError(e instanceof ApiError ? e.message : "Share unavailable.");
    }
  }

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
          {detail?.next_event ? (
            <Text style={styles.next}>
              Next: {formatNextStart(detail.next_event.start_at)} · {detail.going_count} going
              {detail.my_going ? " · You're in ✓" : ""}
            </Text>
          ) : (
            <Text style={styles.next}>No upcoming event yet — be the first to announce.</Text>
          )}
          <View style={styles.shareRow}>
            <Pressable onPress={() => void loadShare()} style={styles.shareButton}>
              <Text style={styles.shareButtonText}>Share this spot</Text>
            </Pressable>
            {share ? (
              <Text style={styles.shareLine}>
                {share.card.spot_name} · {share.card.going_count} going · {share.share.remaining ?? "–"}/
                {share.share.limit} shares left
              </Text>
            ) : shareError ? (
              <Text style={styles.error}>{shareError}</Text>
            ) : null}
          </View>
          <View style={styles.stub}>
            <Text style={styles.stubText}>Posts feed lands next — spot detail, going state, and share are live.</Text>
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
  next: {
    color: colors.text,
    fontSize: 14,
    marginTop: spacing.sm,
    fontWeight: "600",
  },
  shareRow: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  shareButton: {
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: spacing.sm,
    alignItems: "center",
  },
  shareButtonText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 15,
  },
  shareLine: {
    color: colors.textDim,
    fontSize: 13,
    lineHeight: 18,
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
