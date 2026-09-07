/**
 * Profile tab — real user data (GET /me) + star rating + the "your pull"
 * section (Slice 4d-3b): real aggregates from GET /api/v1/me/pull proving the
 * audience-visibility thesis — how many confirmations your announcements drew,
 * and your goers' follow-through. Nullable states render honest empty copy;
 * numbers are never invented.
 */
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { api } from "../api/client";
import type { InfluencerPull, User } from "../api/types";
import { colors, spacing } from "../theme";

interface Props {
  onLogout: () => void;
}

const EMPTY_PULL: InfluencerPull = {
  announcements_total: 0,
  confirmations_drawn_total: 0,
  goers_follow_through_pct: null,
  avg_confirmations_per_announcement: null,
};

/** "your pull" — the concrete proof of the audience-visibility thesis. */
function PullSection({ pull }: { pull: InfluencerPull }): React.JSX.Element {
  const follow =
    pull.goers_follow_through_pct != null
      ? `${pull.goers_follow_through_pct.toFixed(1)}%`
      : pull.announcements_total > 0
        ? "—"
        : null;
  return (
    <View style={styles.pull}>
      <View style={styles.pullHead}>
        <Text style={styles.pullTitle}>Your pull</Text>
        <Text style={styles.pullSub}>When you announce, people show up.</Text>
      </View>
      <View style={styles.pullMetrics}>
        <View style={styles.pullMetric}>
          <Text style={styles.pullValue}>{pull.announcements_total}</Text>
          <Text style={styles.pullLabel}>announced</Text>
        </View>
        <View style={styles.pullMetric}>
          <Text style={styles.pullValue}>{pull.confirmations_drawn_total}</Text>
          <Text style={styles.pullLabel}>confirmations drawn</Text>
        </View>
        <View style={styles.pullMetric}>
          <Text style={styles.pullValue}>{follow ?? "–"}</Text>
          <Text style={styles.pullLabel}>follow-through</Text>
        </View>
        {pull.avg_confirmations_per_announcement != null &&
        pull.announcements_total > 0 ? (
          <View style={styles.pullMetric}>
            <Text style={styles.pullValue}>
              {pull.avg_confirmations_per_announcement.toFixed(1)}
            </Text>
            <Text style={styles.pullLabel}>per announcement</Text>
          </View>
        ) : null}
      </View>
      {pull.announcements_total === 0 ? (
        <Text style={styles.pullHint}>
          Announce a spot and watch your room fill — your pull is built from
          real confirmations, never invented numbers.
        </Text>
      ) : (
        <Text style={styles.pullHint}>
          {follow
            ? `${follow} of your goers actually show up.`
            : "Your first goers haven't been settled yet — follow-through appears after your night."}
        </Text>
      )}
    </View>
  );
}

export function ProfileScreen({ onLogout }: Props): React.JSX.Element {
  const [user, setUser] = useState<User | null>(null);
  const [pull, setPull] = useState<InfluencerPull>(EMPTY_PULL);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [me, pullRes] = await Promise.all([
        api.me(),
        api.myPull().catch(() => null),
      ]);
      setUser(me.user);
      if (pullRes) setPull(pullRes.pull);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load profile");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const initials = user?.display_name
    ? user.display_name.split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase()
    : "??";

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Profile</Text>
      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
      ) : error ? (
        <>
          <Text style={styles.error}>{error}</Text>
          <Pressable onPress={() => void load()} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </>
      ) : user ? (
        <View style={styles.card}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <Text style={styles.name}>{user.display_name}</Text>
          <Text style={styles.username}>@{user.username}</Text>
          <Text style={styles.city}>📍 {user.city}</Text>

          <View style={styles.stars}>
            <Text style={styles.starText}>{"★".repeat(Math.round(user.star_rating))}</Text>
            <Text style={styles.starValue}>{user.star_rating.toFixed(1)}</Text>
          </View>
          <Text style={styles.meta}>
            {user.verified_checkin_count} verified check-ins · {user.reputation_points} reputation pts
          </Text>
          <Text style={styles.hint}>
            Show up where you say you&apos;ll be to raise your stars. No-shows hurt.
          </Text>
          <PullSection pull={pull} />
          <Pressable style={styles.logout} onPress={onLogout}>
            <Text style={styles.logoutText}>Log out</Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.xl,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: "800",
    marginBottom: spacing.lg,
  },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 18,
    padding: spacing.xl,
    alignItems: "center",
  },
  avatar: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  avatarText: {
    color: "#fff",
    fontSize: 30,
    fontWeight: "800",
  },
  name: {
    color: colors.text,
    fontSize: 22,
    fontWeight: "700",
  },
  username: {
    color: colors.textDim,
    fontSize: 15,
    marginTop: 2,
  },
  city: {
    color: colors.textDim,
    fontSize: 14,
    marginTop: spacing.sm,
  },
  stars: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  starText: {
    color: colors.star,
    fontSize: 24,
    letterSpacing: 2,
  },
  starValue: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  meta: {
    color: colors.textDim,
    fontSize: 13,
    marginTop: spacing.sm,
  },
  hint: {
    color: colors.textDim,
    fontSize: 12,
    textAlign: "center",
    marginTop: spacing.md,
    lineHeight: 18,
  },
  pull: {
    marginTop: spacing.lg,
    padding: spacing.md,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primary,
    alignSelf: "stretch",
  },
  pullHead: {
    gap: 2,
  },
  pullTitle: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  pullSub: {
    color: colors.textDim,
    fontSize: 12,
  },
  pullMetrics: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  pullMetric: {
    flex: 1,
  },
  pullValue: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "800",
  },
  pullLabel: {
    color: colors.textDim,
    fontSize: 11,
    marginTop: 2,
  },
  pullHint: {
    color: colors.textDim,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.sm,
  },
  logout: {
    marginTop: spacing.xl,
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  logoutText: {
    color: colors.danger,
    fontSize: 15,
    fontWeight: "600",
  },
  error: {
    color: colors.danger,
    fontSize: 15,
    marginTop: spacing.lg,
    textAlign: "center",
  },
  retry: {
    marginTop: spacing.md,
    alignSelf: "center",
    backgroundColor: colors.surfaceAlt,
    borderRadius: 10,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  retryText: {
    color: colors.text,
  },
});