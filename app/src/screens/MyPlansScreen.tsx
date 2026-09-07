/**
 * My Plans (spec §3.5): upcoming Going rows (event, time, spot) with cancel
 * honoring the 2 h grace rule, plus the "yesterday's outcome" line
 * (showup / no-show / soft no-show / free cancel / unverifiable / pending)
 * from GET /api/v1/me/going.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { api, ApiError } from "../api/client";
import type { MyGoingRow, SettlementKind } from "../api/types";
import { colors, spacing } from "../theme";
import { CategoryPill } from "../components/hero";
import { GoingWithYou } from "../components/live";

const OUTCOME_COPY: Record<SettlementKind, { label: string; color: string }> = {
  showup: { label: "Showed ✓", color: colors.success },
  no_show: { label: "No-show", color: colors.danger },
  soft_no_show: { label: "Late cancel", color: colors.star },
  free_cancel: { label: "Cancelled (free)", color: colors.textDim },
  unverifiable: { label: "Unverifiable", color: colors.textDim },
};

function outcomeFor(row: MyGoingRow): { label: string; color: string } {
  if (row.settlement_kind) return OUTCOME_COPY[row.settlement_kind];
  // Ended but settlement hasn't run yet → pending.
  if (new Date(row.start_at).getTime() + 4 * 3_600_000 < Date.now()) {
    return { label: "Pending…", color: colors.textDim };
  }
  return { label: "Going", color: colors.primary };
}

function freeCancel(row: MyGoingRow): boolean {
  if (!row.free_cancel_until) return false;
  return Date.now() < new Date(row.free_cancel_until).getTime();
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function PlanCard({
  row,
  onCancel,
  cancelling,
}: {
  row: MyGoingRow;
  onCancel: () => void;
  cancelling: boolean;
}): React.JSX.Element {
  const free = freeCancel(row);
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={styles.cardTitle}>
          <Text style={styles.name} numberOfLines={1}>
            {row.spot?.name ?? "Unknown spot"}
          </Text>
          <Text style={styles.time}>{fmtWhen(row.start_at)}</Text>
        </View>
        {row.spot ? <CategoryPill category={row.spot.category} /> : null}
      </View>
      {row.event.note ? (
        <Text style={styles.note} numberOfLines={2}>
          “{row.event.note}”
        </Text>
      ) : null}
      <View style={styles.gwyWrap}>
        <GoingWithYou count={row.going_with_you} mine={row.my_going} />
      </View>
      <View style={styles.cardFoot}>
        <Text style={[styles.outcome, { color: outcomeFor(row).color }]}>{outcomeFor(row).label}</Text>
        {row.my_going && row.event.status === "active" ? (
          <Pressable
            onPress={onCancel}
            disabled={cancelling}
            style={({ pressed }) => [styles.cancel, pressed && styles.cancelPressed]}
          >
            {cancelling ? (
              <ActivityIndicator size="small" color={colors.danger} />
            ) : (
              <Text style={styles.cancelText}>{free ? "Cancel (free)" : "Cancel (< 2 h)"}</Text>
            )}
          </Pressable>
        ) : null}
      </View>
      {row.my_going && row.event.status === "active" && !free ? (
        <Text style={styles.warn}>Cancelling now counts as a late cancel (soft no-show).</Text>
      ) : null}
    </View>
  );
}

export function MyPlansScreen(): React.JSX.Element {
  const [upcoming, setUpcoming] = useState<MyGoingRow[] | null>(null);
  const [recent, setRecent] = useState<MyGoingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const load = useCallback(async (mode: "initial" | "refresh") => {
    if (mode === "refresh") setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await api.myGoing();
      setUpcoming(res.upcoming);
      setRecent(res.recent);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load your plans. Is the API running?");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load("initial");
  }, [load]);

  async function cancel(row: MyGoingRow): Promise<void> {
    const doIt = async (): Promise<void> => {
      setCancellingId(row.event.id);
      try {
        const res = await api.cancelGoing(row.event.id);
        await load("refresh");
        if (res.settlement === "soft_no_show") {
          Alert.alert("Late cancel", "This counts as a soft no-show (−30).");
        }
      } catch (e) {
        Alert.alert("Cancel failed", e instanceof ApiError ? e.message : "Try again.");
      } finally {
        setCancellingId(null);
      }
    };
    if (!freeCancel(row)) {
      Alert.alert(
        "Cancel within 2 hours?",
        "This counts as a soft no-show and dings your stars. Sure?",
        [{ text: "Keep plan", style: "cancel" }, { text: "Cancel anyway", style: "destructive", onPress: () => void doIt() }],
      );
      return;
    }
    await doIt();
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void load("refresh")} tintColor={colors.primary} />
      }
    >
      <Text style={styles.title}>My Plans</Text>
      {loading ? (
        <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: spacing.xl }} />
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Pressable onPress={() => void load("initial")} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <Text style={styles.section}>Upcoming</Text>
          {upcoming && upcoming.length > 0 ? (
            upcoming.map((row) => (
              <PlanCard
                key={row.event.id}
                row={row}
                cancelling={cancellingId === row.event.id}
                onCancel={() => void cancel(row)}
              />
            ))
          ) : (
            <Text style={styles.empty}>No upcoming plans — announce one from Trending.</Text>
          )}
          <Text style={styles.section}>Recent outcomes</Text>
          {recent.length > 0 ? (
            recent.map((row) => (
              <PlanCard
                key={row.event.id}
                row={row}
                cancelling={false}
                onCancel={() => undefined}
              />
            ))
          ) : (
            <Text style={styles.empty}>Nothing in the last 7 days.</Text>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
  },
  title: {
    color: colors.text,
    fontSize: 26,
    fontWeight: "800",
  },
  section: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  cardTitle: {
    flex: 1,
  },
  name: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  time: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: "600",
    marginTop: 2,
  },
  note: {
    color: colors.textDim,
    fontSize: 13,
    fontStyle: "italic",
    marginTop: spacing.sm,
  },
  gwyWrap: {
    marginTop: spacing.sm,
  },
  cardFoot: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.sm,
  },
  outcome: {
    fontSize: 13,
    fontWeight: "700",
  },
  cancel: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  cancelPressed: {
    opacity: 0.7,
  },
  cancelText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: "700",
  },
  warn: {
    color: colors.star,
    fontSize: 12,
    marginTop: spacing.sm,
  },
  center: {
    alignItems: "center",
    marginTop: spacing.xl,
  },
  error: {
    color: colors.danger,
    fontSize: 14,
    textAlign: "center",
  },
  retry: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    backgroundColor: colors.primary,
  },
  retryText: {
    color: "#fff",
    fontWeight: "700",
  },
  empty: {
    color: colors.textDim,
    fontSize: 14,
  },
});
