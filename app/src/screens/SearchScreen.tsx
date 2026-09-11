/**
 * Search (REVAMP 2, owner 2026-09-09) — the universal metro search list.
 *
 * Queries GET /api/v1/venues/search across the 7 launch cities with:
 *   - debounced text query (name/address substring)
 *   - city chips built from GET /api/v1/cities (real counts, never hardcoded)
 *   - category filter (the 6 real SpotCategory enums)
 *   - sort toggle: name | trending | going (real API sort keys)
 * Every row shows name, city, category and the LIVE going_count straight from
 * the API (0 when quiet — never invented). Empty states are honest copy, not
 * fake numbers.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { api, ApiError } from "../api/client";
import type { CityRow, SpotCategory, VenueSearchRow, VenueSort } from "../api/types";
import { colors, spacing } from "../theme";
import { CategoryPill } from "../components/hero";
import { CardSkeleton, GoingNowInline, HeatBadge } from "../components/live";

interface Props {
  onOpenSpot: (spotId: string) => void;
}

const CATEGORIES: SpotCategory[] = ["bar", "club", "concert", "restaurant", "house", "other"];
const SORTS: { key: VenueSort; label: string }[] = [
  { key: "name", label: "A–Z" },
  { key: "trending", label: "Trending" },
  { key: "going", label: "Going" },
];
const PAGE_SIZE = 30;

export function SearchScreen({ onOpenSpot }: Props): React.JSX.Element {
  const [cities, setCities] = useState<CityRow[] | null>(null);
  const [city, setCity] = useState<string | null>(null); // null = whole metro
  const [category, setCategory] = useState<SpotCategory | null>(null);
  const [sort, setSort] = useState<VenueSort>("name");
  const [query, setQuery] = useState("");

  const [rows, setRows] = useState<VenueSearchRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const metroTotal = useMemo(
    () => (cities ? cities.reduce((sum, c) => sum + c.venue_count, 0) : null),
    [cities],
  );

  const runSearch = useCallback(
    async (targetPage: number, reset: boolean) => {
      if (reset) setLoading(true);
      setError(null);
      try {
        const res = await api.venuesSearch({
          q: query.trim() || undefined,
          city: city ?? undefined,
          category: category ?? undefined,
          sort,
          page: targetPage,
          limit: PAGE_SIZE,
        });
        setRows((prev) => (reset ? res.venues : [...(prev ?? []), ...res.venues]));
        setPage(res.page);
        setTotal(res.total);
        setHasMore(res.page < res.total_pages);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Search failed. Is the API up?");
        if (reset) setRows([]);
      } finally {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    },
    [query, city, category, sort],
  );

  // Initial fetch + debounced re-search on any filter change.
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void runSearch(1, true), query.trim() ? 300 : 0);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, city, category, sort, runSearch]);

  // City chips (real counts from the API).
  useEffect(() => {
    let alive = true;
    void api
      .cities()
      .then((res) => {
        if (alive) setCities(res.cities);
      })
      .catch(() => {
        // search still works without chips — show nothing and let search run
      });
    return () => {
      alive = false;
    };
  }, []);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void runSearch(1, true);
  }, [runSearch]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    void runSearch(page + 1, false);
  }, [loadingMore, hasMore, runSearch, page]);

  const chipLabel = (c: CityRow): string => `${c.city} ${c.venue_count.toLocaleString()}`;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.kicker}>Phoenix metro</Text>
        <Text style={styles.title}>Where's the night taking you?</Text>
        <View style={styles.searchBox}>
          <TextInput
            style={styles.input}
            placeholder="Search venues, streets, parties…"
            placeholderTextColor={colors.textDim}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
          />
          {query.length > 0 ? (
            <Pressable onPress={() => setQuery("")} hitSlop={10}>
              <Text style={styles.clear}>✕</Text>
            </Pressable>
          ) : null}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          <Pressable
            onPress={() => setCity(null)}
            style={[styles.chip, city === null && styles.chipActive]}
          >
            <Text style={[styles.chipText, city === null && styles.chipTextActive]}>
              All metro{metroTotal != null ? ` · ${metroTotal.toLocaleString()}` : ""}
            </Text>
          </Pressable>
          {(cities ?? []).map((c) => (
            <Pressable
              key={c.city}
              onPress={() => setCity(c.city)}
              style={[styles.chip, city === c.city && styles.chipActive]}
            >
              <Text style={[styles.chipText, city === c.city && styles.chipTextActive]}>{chipLabel(c)}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <View style={styles.filterRow}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            <Pressable
              onPress={() => setCategory(null)}
              style={[styles.chip, category === null && styles.chipActive]}
            >
              <Text style={[styles.chipText, category === null && styles.chipTextActive]}>Any</Text>
            </Pressable>
            {CATEGORIES.map((c) => (
              <Pressable
                key={c}
                onPress={() => setCategory(category === c ? null : c)}
                style={[styles.chip, category === c && styles.chipActive]}
              >
                <Text style={[styles.chipText, category === c && styles.chipTextActive]}>
                  {c.charAt(0).toUpperCase() + c.slice(1)}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
        <View style={styles.sortRow}>
          <Text style={styles.sortLabel}>Sort</Text>
          {SORTS.map((s) => (
            <Pressable
              key={s.key}
              onPress={() => setSort(s.key)}
              style={[styles.sortChip, sort === s.key && styles.sortChipActive]}
            >
              <Text style={[styles.sortText, sort === s.key && styles.sortTextActive]}>{s.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {loading && rows === null ? (
        <View style={styles.center}>
          <View style={styles.skelList}>
            {Array.from({ length: 5 }, (_, i) => (
              <CardSkeleton key={i} />
            ))}
          </View>
        </View>
      ) : error && rows !== null && rows.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Pressable onPress={() => void runSearch(1, true)} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : rows !== null && rows.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No one's out there yet</Text>
          <Text style={styles.emptySub}>
            {query.trim()
              ? `Nothing matches “${query.trim()}”${city ? ` in ${city}` : " in the metro"} — be the first to say you're going.`
              : city
                ? `No ${category ?? "spots"} in ${city} yet — be the first to announce.`
                : "The metro's quiet tonight — be the first to say you're going."}
          </Text>
        </View>
      ) : rows !== null ? (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />
          }
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListHeaderComponent={
            total != null ? (
              <Text style={styles.resultMeta}>
                {total.toLocaleString()} {total === 1 ? "spot" : "spots"}
                {city ? ` in ${city}` : " across the metro"} · live going counts
              </Text>
            ) : null
          }
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator color={colors.primary} style={{ marginVertical: spacing.lg }} />
            ) : null
          }
          renderItem={({ item }) => {
            const hot = item.going_count > 0;
            return (
              <Pressable
                onPress={() => onOpenSpot(item.id)}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              >
                <View style={styles.rowTop}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <View style={styles.rowCount}>
                    {hot ? <View style={styles.liveDot} /> : null}
                    <Text style={[styles.rowGoing, hot ? styles.rowGoingHot : styles.rowGoingQuiet]}>
                      {item.going_count} going
                    </Text>
                  </View>
                </View>
                <View style={styles.rowMeta}>
                  <CategoryPill category={item.category} />
                  <Text style={styles.rowCity} numberOfLines={1}>
                    {item.city}
                    {item.address ? ` · ${item.address}` : ""}
                  </Text>
                </View>
                <View style={styles.rowFoot}>
                  <HeatBadge
                    signals={{
                      going_now: item.going_now ?? 0,
                      heat_level: item.heat_level ?? 0,
                      heat_count: item.heat_count ?? 0,
                    }}
                    size="sm"
                  />
                  <GoingNowInline count={item.going_now} compact />
                </View>
              </Pressable>
            );
          }}
        />
      ) : null}
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
  kicker: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1.5,
    textTransform: "uppercase",
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "800",
    marginTop: 2,
    marginBottom: spacing.sm,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
  },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 16,
    paddingVertical: 12,
  },
  clear: {
    color: colors.textDim,
    fontSize: 16,
    padding: 6,
  },
  chipRow: {
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  filterRow: {
    marginTop: -spacing.xs,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryDim,
  },
  chipText: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: "600",
  },
  chipTextActive: {
    color: "#fff",
  },
  sortRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: 2,
  },
  sortLabel: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: "700",
  },
  sortChip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
  },
  sortChipActive: {
    borderColor: colors.accent,
    backgroundColor: "rgba(255, 77, 109, 0.15)",
  },
  sortText: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: "700",
  },
  sortTextActive: {
    color: colors.accent,
  },
  resultMeta: {
    color: colors.textDim,
    fontSize: 12,
    marginBottom: spacing.sm,
  },
  list: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xl,
  },
  row: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowPressed: {
    opacity: 0.75,
  },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  rowName: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
    flex: 1,
  },
  rowCount: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  rowGoing: {
    fontSize: 13,
    fontWeight: "800",
  },
  rowGoingHot: {
    color: colors.accent,
  },
  rowGoingQuiet: {
    color: colors.textDim,
  },
  rowMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  rowCity: {
    color: colors.textDim,
    fontSize: 12,
    flex: 1,
  },
  rowFoot: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
    flexWrap: "wrap",
  },
  skelList: {
    width: "100%",
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
    lineHeight: 20,
  },
});