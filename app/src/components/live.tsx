/**
 * Live-audience presentational bits (Slice 4d-3b): heat badge + live "N going
 * now" counter for spots, and the "going with you" line. ALL numbers come from
 * the wire (spot detail / share / me-going payloads) — never invented.
 *
 * Heat buckets mirror the server (lib/audience.ts heatLevel by 60-min
 * confirmation velocity): 0 calm / 1 warming / 2 hot / 3 on_fire.
 */
import React, { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { colors, spacing } from "../theme";

export interface HeatSignal {
  going_now: number;
  heat_level: 0 | 1 | 2 | 3;
  heat_count?: number;
}

export interface HeatStyle {
  label: string;
  color: string;
  glow: string;
}

export const HEAT_STYLES: Record<0 | 1 | 2 | 3, HeatStyle> = {
  0: { label: "Calm", color: colors.textDim, glow: colors.border },
  1: { label: "Warming", color: "#FFB020", glow: "rgba(255, 176, 32, 0.35)" },
  2: { label: "Hot", color: "#FF7A3D", glow: "rgba(255, 122, 61, 0.4)" },
  3: { label: "On fire", color: "#FF4D6D", glow: "rgba(255, 77, 109, 0.5)" },
};

const PULSE_MIN = 0.55;
const PULSE_MAX = 1;

/** Soft continuous pulse — the "alive" tick when a counter is live. */
export function usePulse(enabled: boolean): Animated.Value {
  const pulse = useRef(new Animated.Value(PULSE_MAX)).current;
  useEffect(() => {
    if (!enabled) {
      pulse.stopAnimation();
      pulse.setValue(PULSE_MAX);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: PULSE_MIN,
          duration: 1100,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: PULSE_MAX,
          duration: 1100,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(PULSE_MAX);
    };
  }, [enabled, pulse]);
  return pulse;
}

/** "On fire"/"Hot"/"Warming" (+ live going-now count) — or "Calm". */
export function HeatBadge({
  signals,
  size = "md",
}: {
  signals: HeatSignal | null | undefined;
  size?: "sm" | "md";
}): React.JSX.Element | null {
  if (!signals) return null;
  const style = HEAT_STYLES[signals.heat_level] ?? HEAT_STYLES[0];
  const live = signals.going_now > 0;
  const pulse = usePulse(live);
  const pad = size === "sm" ? 6 : 9;
  const font = size === "sm" ? 11 : 13;
  return (
    <Animated.View
      style={[
        styles.badge,
        {
          paddingHorizontal: pad + 2,
          paddingVertical: pad / 2,
          borderColor: style.color,
          opacity: pulse,
          shadowColor: style.glow,
          shadowOpacity: live ? 0.9 : 0,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 0 },
          elevation: live ? 6 : 0,
        },
      ]}
    >
      <View style={[styles.dot, { backgroundColor: style.color }]} />
      <Text style={[styles.badgeText, { color: style.color, fontSize: font }]}>
        {style.label}
      </Text>
      {live ? (
        <Text style={[styles.nowText, { color: style.color, fontSize: font }]}>
          {signals.going_now} going now
        </Text>
      ) : null}
    </Animated.View>
  );
}

/** "N going with you" — real audience on your next event (0 → invite line). */
export function GoingWithYou({
  count,
  mine,
}: {
  count: number | null | undefined;
  mine: boolean;
}): React.JSX.Element {
  if (count == null) return <Text style={styles.gwyLine}>{""}</Text>;
  if (count > 0) {
    return (
      <Text style={styles.gwyLine}>
        <Text style={styles.gwyBold}>{count} going with you</Text>
        <Text style={styles.gwyDim}> — your audience is showing up.</Text>
      </Text>
    );
  }
  if (mine) {
    return (
      <Text style={styles.gwyLine}>
        <Text style={styles.gwyDim}>You&apos;re the first — </Text>
        <Text style={styles.gwyBold}>invite friends</Text>
        <Text style={styles.gwyDim}> to make this one count.</Text>
      </Text>
    );
  }
  return (
    <Text style={styles.gwyLine}>
      <Text style={styles.gwyDim}>No one else going yet — </Text>
      <Text style={styles.gwyBold}>be the first.</Text>
    </Text>
  );
}
/**
 * REVAMP 4 — pulsing "N going now" inline (bodies on the floor RIGHT NOW from
 * real Going rows in the event window). Renders nothing for 0 (honest quiet).
 */
export function GoingNowInline({
  count,
  color = colors.primary,
  compact = false,
}: {
  count: number | null | undefined;
  color?: string;
  compact?: boolean;
}): React.JSX.Element | null {
  const live = (count ?? 0) > 0;
  const pulse = usePulse(live);
  if (!live) return null;
  return (
    <Animated.View style={[styles.goingNowLine, { opacity: pulse }]}>
      <View style={[styles.goingNowDot, { backgroundColor: color }]} />
      <Text style={[styles.goingNowText, { color }, compact && styles.goingNowCompact]}>
        {count} going now
      </Text>
    </Animated.View>
  );
}
/**
 * REVAMP 4 — "X's going" pull line: the highest-star active goer on the next
 * event (real Going rows, server picks top_goer). Makes an influencer's pull
 * concrete. Renders nothing when no one else is going.
 */
export function TopGoerLine({
  topGoer,
}: {
  topGoer: { display_name: string; star_rating: number } | null | undefined;
}): React.JSX.Element | null {
  if (!topGoer) return null;
  const gold = topGoer.star_rating >= 4;
  return (
    <View style={styles.topGoerLine}>
      <Text style={styles.topGoerStar}>{gold ? "★" : "·"}</Text>
      <Text style={styles.topGoerName} numberOfLines={1}>
        {topGoer.display_name}&apos;s going
      </Text>
      <Text style={[styles.topGoerStars, gold && styles.topGoerStarsGold]}>
        {Number.isFinite(topGoer.star_rating) ? topGoer.star_rating.toFixed(1) : "–"}★
      </Text>
    </View>
  );
}
/**
 * REVAMP 4 — soft pulsing skeleton block for loaders (no numbers, just a
 * breathing placeholder so screens feel alive while real data arrives).
 */
export function Skeleton({
  width = "100%",
  height = 14,
  radius = 8,
  style,
}: {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: object;
}): React.JSX.Element {
  const pulse = usePulse(true);
  return (
    <Animated.View
      style={[
        { width, height, borderRadius: radius, backgroundColor: colors.surfaceAlt, opacity: pulse },
        style,
      ]}
    />
  );
}
/** REVAMP 4 — a full card-shaped skeleton row (used by Trending/Search). */
export function CardSkeleton(): React.JSX.Element {
  return (
    <View style={styles.skelCard}>
      <Skeleton width="62%" height={16} />
      <Skeleton width="80%" height={11} style={{ marginTop: 6 }} />
      <View style={styles.skelFoot}>
        <Skeleton width={64} height={18} radius={999} />
        <Skeleton width={44} height={18} radius={999} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: colors.background,
    alignSelf: "flex-start",
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  badgeText: {
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  nowText: {
    fontWeight: "700",
  },
  gwyLine: {
    fontSize: 14,
    lineHeight: 20,
  },
  gwyBold: {
    color: "#fff",
    fontWeight: "800",
  },
  gwyDim: {
    color: colors.textDim,
  },
  goingNowLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
  },
  goingNowDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  goingNowText: {
    fontSize: 13,
    fontWeight: "800",
  },
  goingNowCompact: {
    fontSize: 12,
  },
  topGoerLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
    alignSelf: "flex-start",
    backgroundColor: "rgba(255, 77, 109, 0.08)",
    borderColor: "rgba(255, 77, 109, 0.25)",
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  topGoerStar: {
    color: "#FFD166",
    fontSize: 11,
  },
  topGoerName: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "800",
    flexShrink: 1,
  },
  topGoerStars: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: "700",
  },
  topGoerStarsGold: {
    color: "#FFD166",
  },
  skelCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 14,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  skelFoot: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: 10,
  },
});