/**
 * Shared presentational bits for the hero loop (spec §3): category pill,
 * star-weighted avatar cluster, rank badge, time formatting.
 */
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, spacing } from "../theme";

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
 * Star-weighted avatar cluster (spec §3.2): up to 5 overlapping initial
 * circles; border color encodes the confirmer's star band (gold ≥ 4,
 * purple ≥ 3, dim below). Trending rows only carry a count, so the count
 * doubles as the cluster seed — full confirmer names arrive in 4c.
 */
export function AvatarCluster({ count }: { count: number }): React.JSX.Element {
  const shown = Math.min(5, Math.max(count, 0));
  if (shown === 0) {
    return (
      <View style={styles.emptyCluster}>
        <Text style={styles.emptyClusterText}>Be the first going</Text>
      </View>
    );
  }
  const bands = [colors.star, colors.star, colors.primary, colors.primary, colors.textDim];
  return (
    <View style={styles.cluster}>
      {Array.from({ length: shown }, (_, i) => (
        <View
          key={i}
          style={[
            styles.avatar,
            { borderColor: bands[i] ?? colors.textDim, marginLeft: i === 0 ? 0 : -10, zIndex: shown - i },
          ]}
        >
          <Text style={styles.avatarText}>●</Text>
        </View>
      ))}
      <Text style={styles.clusterCount}>
        {count} going
      </Text>
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
  avatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: colors.textDim,
    fontSize: 8,
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
