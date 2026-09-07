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
function usePulse(enabled: boolean): Animated.Value {
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
});