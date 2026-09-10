/**
 * Map (REVAMP 2, owner 2026-09-09) — the metro map view: the night feels
 * physical. Real venue pins (lat/lon from the API), sized by the LIVE going
 * count; tap a pin → detail card → full spot screen.
 *
 * Data: GET /api/v1/venues/search (sort=going, limit=100) — filtered by a
 * city chip (or whole metro). All pins/counts are real API data; a quiet
 * metro renders honest quiet pins, never invented numbers.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Location from "expo-location";
import { api, ApiError } from "../api/client";
import type { CityRow, VenueSearchRow } from "../api/types";
import { colors, spacing } from "../theme";
import { MetroMap, VenuePin } from "../components/MetroMap";
import { CategoryPill } from "../components/hero";
import { formatDistanceM } from "../lib/metro";

interface Props {
  onOpenSpot: (spotId: string) => void;
}

const MAP_PAGE = 100;

export function MapScreen({ onOpenSpot }: Props): React.JSX.Element {
  const [cities, setCities] = useState<CityRow[] | null>(null);
  const [city, setCity] = useState<string | null>(null); // null = whole metro
  const [venues, setVenues] = useState<VenueSearchRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<VenueSearchRow | null>(null);
  const [locating, setLocating] = useState(false);
  const [near, setNear] = useState<{ lat: number; lon: number } | null>(null);

  const pins: VenuePin[] = useMemo(
    () =>
      (venues ?? []).map((v) => ({
        id: v.id,
        name: v.name,
        city: v.city,
        category: v.category,
        lat: v.lat,
        lon: v.lon,
        going_count: v.going_count,
        trending_score: v.trending_score,
      })),
    [venues],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSelected(null);
    try {
      const res = await api.venuesSearch({
        city: city ?? undefined,
        sort: "going",
        limit: MAP_PAGE,
        lat: near?.lat,
        lon: near?.lon,
        radius_km: near ? 25 : undefined,
      });
      setVenues(res.venues);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load the map. Is the API up?");
      setVenues([]);
    } finally {
      setLoading(false);
    }
  }, [city, near]);

  useEffect(() => {
    void load();
  }, [load]);

  // City chips (real counts from the API).
  useEffect(() => {
    let alive = true;
    void api
      .cities()
      .then((res) => {
        if (alive) setCities(res.cities);
      })
      .catch(() => {
        // non-fatal: map works without the chip list
      });
    return () => {
      alive = false;
    };
  }, []);

  const nearMe = useCallback(async () => {
    if (locating) return;
    setLocating(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        setError("Location permission is off — pick a city chip instead.");
        return;
      }
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setNear({ lat: fix.coords.latitude, lon: fix.coords.longitude });
      setCity(null);
    } catch {
      setError("Couldn't get your location — pick a city chip instead.");
    } finally {
      setLocating(false);
    }
  }, [locating]);

  const metroCount = useMemo(
    () => (cities ? cities.reduce((s, c) => s + c.venue_count, 0) : null),
    [cities],
  );

  const selectedPin = selected
    ? pins.find((p) => p.id === selected.id) ?? null
    : null;

  const distanceLine = selected ? formatDistanceM(selected.distance_m) : null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.kicker}>{near ? "Near you" : "Phoenix metro"}</Text>
        <Text style={styles.title}>The map tonight</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
          <Pressable onPress={() => setCity(null)} style={[styles.chip, city === null && styles.chipActive]}>
            <Text style={[styles.chipText, city === null && styles.chipTextActive]}>
              All metro{metroCount != null ? ` · ${metroCount.toLocaleString()}` : ""}
            </Text>
          </Pressable>
          {(cities ?? []).map((c) => (
            <Pressable
              key={c.city}
              onPress={() => {
                setCity(c.city);
                setNear(null);
              }}
              style={[styles.chip, city === c.city && styles.chipActive]}
            >
              <Text style={[styles.chipText, city === c.city && styles.chipTextActive]}>
                {c.city} · {c.venue_count.toLocaleString()}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {loading && venues === null ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : error && venues !== null && venues.length === 0 && !selected ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Pressable onPress={() => void load()} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <View style={styles.mapWrap}>
            <MetroMap
              venues={pins}
              selectedId={selected?.id}
              onSelectVenue={(v) => {
                const row = venues?.find((r) => r.id === v.id) ?? null;
                setSelected(row);
              }}
              height={380}
            />
            <Pressable
              onPress={() => void nearMe()}
              disabled={locating}
              style={({ pressed }) => [styles.nearButton, pressed && styles.pressed, locating && styles.disabled]}
            >
              {locating ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Text style={styles.nearText}>📍 Near me</Text>
              )}
            </Pressable>
          </View>

          {selected && selectedPin ? (
            <View style={styles.card}>
              <View style={styles.cardTop}>
                <Text style={styles.cardName} numberOfLines={1}>
                  {selectedPin.name}
                </Text>
                <Pressable onPress={() => setSelected(null)} hitSlop={10}>
                  <Text style={styles.cardClose}>✕</Text>
                </Pressable>
              </View>
              <View style={styles.cardMeta}>
                <CategoryPill category={selectedPin.category} />
                <Text style={styles.cardCity}>{selectedPin.city}</Text>
                <Text style={[styles.cardGoing, selectedPin.going_count > 0 && styles.cardGoingHot]}>
                  {selectedPin.going_count > 0 ? `● ${selectedPin.going_count} going` : "quiet — no one going yet"}
                </Text>
              </View>
              {distanceLine ? <Text style={styles.cardDistance}>{distanceLine}</Text> : null}
              <Pressable
                onPress={() => onOpenSpot(selectedPin.id)}
                style={({ pressed }) => [styles.cardButton, pressed && styles.pressed]}
              >
                <Text style={styles.cardButtonText}>See the spot →</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.hint}>
              <Text style={styles.hintText}>
                {pins.length > 0
                  ? "Tap a pin to see what's happening there."
                  : "No venues here yet — announce where you're going and a spot lights up."}
              </Text>
            </View>
          )}
          {error ? <Text style={styles.inlineError}>{error}</Text> : null}
        </>
      )}
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
  },
  chipRow: {
    gap: spacing.sm,
    paddingVertical: spacing.sm,
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
  mapWrap: {
    marginHorizontal: spacing.md,
  },
  nearButton: {
    position: "absolute",
    top: 10,
    right: 10,
    backgroundColor: "rgba(21, 24, 30, 0.92)",
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  nearText: {
    color: colors.primary,
    fontWeight: "700",
    fontSize: 13,
  },
  disabled: {
    opacity: 0.6,
  },
  pressed: {
    opacity: 0.75,
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
  card: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: spacing.md,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  cardName: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "800",
    flex: 1,
  },
  cardClose: {
    color: colors.textDim,
    fontSize: 16,
    padding: 4,
  },
  cardMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
    flexWrap: "wrap",
  },
  cardCity: {
    color: colors.textDim,
    fontSize: 13,
  },
  cardGoing: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: "700",
  },
  cardGoingHot: {
    color: colors.accent,
    fontWeight: "800",
  },
  cardDistance: {
    color: colors.textDim,
    fontSize: 12,
    marginTop: 4,
  },
  cardButton: {
    marginTop: spacing.sm,
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: "center",
  },
  cardButtonText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 14,
  },
  hint: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    alignItems: "center",
  },
  hintText: {
    color: colors.textDim,
    fontSize: 13,
    textAlign: "center",
  },
  inlineError: {
    color: colors.danger,
    fontSize: 13,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    textAlign: "center",
  },
});