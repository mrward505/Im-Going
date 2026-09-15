/**
 * Shared presentational bits for the hero loop (spec §3): category pill,
 * star-weighted avatar cluster, rank badge, time formatting.
 */
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { GoerIdentity } from "../api/types";
import { colors, spacing } from "../theme";
import { AvatarStack } from "./Avatar";

const CATEGORY_LABELS: Record<string, string> = {
  bar: "Bar",
  club: "Club",
  concert: "Concert",
  restaurant: "Food",
  house: "House",
  other: "Spot",
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

export function CategoryPill({ category }: { category: string }): React.JSX.Element {
  return (
    <View style={styles.pill}>
      <Text style={styles.pillText}>{categoryLabel(category)}</Text>
    </View>
  );
}

/** "★ 3.0" inline rating. */
export function StarTag({ stars }: { stars: number }): React.JSX.Element {
  return (
    <Text style={styles.starTag}>
      ★ {Number.isFinite(stars) ? stars.toFixed(1) : "–"}
    </Text>
  );
}

/**
 * Avatar cluster for a spot card (spec §3.2, extended REVAMP 5): the real
 * goers' profile pictures, overlapped, highest credibility first. The server
 * sends the identities (Going ⋈ users) so nothing is fabricated; members
 * without a picture show their initials, and the count is always the true
 * number of active confirmations. Nobody going yet → honest empty copy.
 */
export function AvatarCluster({
  count,
  goers,
  size = 26,
}: {
  count: number;
  goers?: GoerIdentity[] | null;
  size?: number;
}): React.JSX.Element {
  const people = (goers ?? []).slice(0, 5);
  if (count <= 0 && people.length === 0) {
    return (
      <View style={styles.emptyCluster}>
        <Text style={styles.emptyClusterText}>Be the first going</Text>
      </View>
    );
  }
  return (
    <View style={styles.cluster}>
      <AvatarStack goers={people} count={count} size={size} />
      <Text style={styles.clusterCount}>{count} going</Text>
    </View>
  );
}

/** Rank badge for the trending list (#1 highlighted). */
export function RankBadge({ rank }: { rank: number }): React.JSX.Element {
  const hot = rank <= 3;
  return (
    <View style={[styles.rank, hot && styles.rankHot]}>
      <Text style={[styles.rankText, hot && styles.rankHotText]}>{rank}</Text>
    </View>
  );
}

/** "Tonight 9:00 PM" / "Tomorrow 10:30 PM" / "Sat, Sep 12 · 9 PM". */
export function formatNextStart(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  if (diffDays <= 0) return `Tonight ${time}`;
  if (diffDays === 1) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} · ${time}`;
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    alignSelf: "flex-start",
  },
  pillText: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: "600",
  },
  starTag: {
    color: colors.star,
    fontSize: 12,
    fontWeight: "700",
  },
  cluster: {
    flexDirection: "row",
    alignItems: "center",
  },
  clusterCount: {
    color: colors.textDim,
    fontSize: 12,
    marginLeft: spacing.sm,
    fontWeight: "600",
  },
  emptyCluster: {
    paddingVertical: 2,
  },
  emptyClusterText: {
    color: colors.textDim,
    fontSize: 12,
    fontStyle: "italic",
  },
  rank: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  rankHot: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  rankText: {
    color: colors.textDim,
    fontSize: 14,
    fontWeight: "800",
  },
  rankHotText: {
    color: "#fff",
  },
});
