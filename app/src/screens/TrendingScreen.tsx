/**
 * Trending (Home) — the hero screen (spec §3.2). Top-20 spots with rank,
 * name, category pill, next event time, live going count with star-weighted
 * avatar cluster, post-thumbnail placeholder; each row taps into the spot
 * screen (stub in this slice — full spot detail + posts land in 4c).
 * Pull-to-refresh; floating "I'm going tonight" button opens Announce.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { api, ApiError } from "../api/client";
import type { TrendingRow } from "../api/types";
import { colors, spacing } from "../theme";
import { AvatarCluster, CategoryPill, RankBadge, formatNextStart } from "../components/hero";

interface Props {
  onAnnounce: () => void;
  onOpenSpot: (spotId: string) => void;
}

function spotAddressLine(row: TrendingRow): string {
  const { spot } = row;
  if (!spot.is_verified) return spot.masked_address ?? "Private spot";
  return spot.address ?? spot.city;
}

function TrendingCard({ row, rank, onOpen }: { row: TrendingRow; rank: number; onOpen: () => void }): React.JSX.Element {
  return (
    <Pressable onPress={onOpen} style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}>
      <View style={styles.cardTop}>
        <RankBadge rank={rank} />
        <View style={styles.cardHead}>
          <Text style={styles.name} numberOfLines={1}>
            {row.spot.name}
          </Text>
          <Text style={styles.address} numberOfLines={1}>
            {spotAddressLine(row)}
          </Text>
        </View>
        <View style={styles.thumb}>
          <Ionicons name="image-outline" size={18} color={colors.textDim} />
        </View>
      </View>
      <View style={styles.cardMeta}>
        <CategoryPill category={row.spot.category} />
        <Text style={styles.time}>{formatNextStart(row.next_start_at)}</Text>
      </View>
      <View style={styles.cardFoot}>
        <AvatarCluster count={row.going_count} />
      </View>
    </Pressable>
  );
}

export function TrendingScreen({ onAnnounce, onOpenSpot }: Props): React.JSX.Element {
  const [rows, setRows] = useState<TrendingRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (mode: "initial" | "refresh") => {
    if (mode === "refresh") setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await api.trending();
      setRows(res.trending);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load trending. Is the API running?");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load("initial");
  }, [load]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.city}>📍 Tempe, AZ</Text>
        <Text style={styles.title}>Trending tonight</Text>
      </View>
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Pressable onPress={() => void load("initial")} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : rows && rows.length > 0 ? (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.spot.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void load("refresh")} tintColor={colors.primary} />
          }
          renderItem={({ item, index }) => (
            <TrendingCard row={item} rank={index + 1} onOpen={() => onOpenSpot(item.spot.id)} />
          )}
        />
      ) : (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Nothing trending yet</Text>
          <Text style={styles.emptySub}>Be the first — announce where you&apos;re going tonight.</Text>
        </View>
      )}
      <Pressable onPress={onAnnounce} style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}>
        <Ionicons name="add" size={22} color="#fff" />
        <Text style={styles.fabText}>I&apos;m going tonight</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  city: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: "600",
  },
  title: {
    color: colors.text,
    fontSize: 26,
    fontWeight: "800",
    marginTop: 2,
  },
  list: {
    paddingHorizontal: spacing.md,
    paddingBottom: 96,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  cardPressed: {
    opacity: 0.75,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  cardHead: {
    flex: 1,
  },
  name: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  address: {
    color: colors.textDim,
    fontSize: 12,
    marginTop: 2,
  },
  thumb: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  cardMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  time: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "600",
  },
  cardFoot: {
    marginTop: spacing.sm,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
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
  emptyTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
  },
  emptySub: {
    color: colors.textDim,
    fontSize: 14,
    marginTop: spacing.sm,
    textAlign: "center",
  },
  fab: {
    position: "absolute",
    bottom: spacing.lg,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
    borderRadius: 999,
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  fabPressed: {
    opacity: 0.85,
  },
  fabText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "800",
  },
});
