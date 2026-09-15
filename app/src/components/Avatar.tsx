/**
 * REVAMP 5 — the one circular avatar component the whole app renders (owner
 * 2026-09-11: "I should be able to add a profile picture"). Every identity
 * surface — profile header, going rows, post rows, trending clusters, the
 * "X's going" pull line — uses these so a person looks the same everywhere.
 *
 * Real data only: an uploaded profile picture when the user has one, initials
 * derived from their real display name when they don't. Never a stock photo,
 * never a fake identity.
 */
import React from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import type { GoerIdentity } from "../api/types";
import { colors } from "../theme";

export interface AvatarIdentity {
  display_name: string;
  avatar_url?: string | null;
}

/** "Ada Lovelace" → "AL"; single names → first two letters; empty → "··". */
export function initialsOf(displayName: string | null | undefined): string {
  const parts = (displayName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "··";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Deterministic circle tint per person so initials avatars read as "theirs". */
const TINTS = ["#FF4D6D", "#7C5CFF", "#3DDC97", "#FFB020", "#4EA8FF", "#FF7A3D"];
export function tintFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 9973;
  return TINTS[h % TINTS.length];
}

export function Avatar({
  identity,
  size = 36,
  ring = false,
  ringColor,
}: {
  identity: AvatarIdentity;
  size?: number;
  /** Draw the outline that separates overlapping cluster avatars. */
  ring?: boolean;
  ringColor?: string;
}): React.JSX.Element {
  const radius = size / 2;
  const border = ring ? { borderWidth: 2, borderColor: ringColor ?? colors.background } : null;
  if (identity.avatar_url) {
    return (
      <Image
        source={{ uri: identity.avatar_url }}
        style={[{ width: size, height: size, borderRadius: radius, backgroundColor: colors.surfaceAlt }, border]}
        resizeMode="cover"
        accessibilityLabel={`${identity.display_name} profile photo`}
      />
    );
  }
  return (
    <View
      style={[
        styles.initials,
        {
          width: size,
          height: size,
          borderRadius: radius,
          backgroundColor: tintFor(identity.display_name || "?"),
        },
        border,
      ]}
    >
      <Text style={[styles.initialsText, { fontSize: Math.max(9, Math.round(size * 0.38)) }]}>
        {initialsOf(identity.display_name)}
      </Text>
    </View>
  );
}

/**
 * Overlapping cluster of REAL goers (highest credibility first, server-ordered).
 * `count` is the true number of active goings; when it exceeds the identities
 * we have, an honest "+N" chip fills the gap — the number is never invented.
 * With nobody going, the caller's empty copy shows instead.
 */
export function AvatarStack({
  goers,
  count,
  size = 26,
  max = 5,
}: {
  goers?: GoerIdentity[] | null;
  count: number;
  size?: number;
  max?: number;
}): React.JSX.Element | null {
  const people = (goers ?? []).slice(0, max);
  if (people.length === 0) return null;
  const overflow = Math.max(0, count - people.length);
  return (
    <View style={styles.stack}>
      {people.map((g, i) => (
        <View key={g.id} style={{ marginLeft: i === 0 ? 0 : -Math.round(size * 0.35), zIndex: max - i }}>
          <Avatar identity={g} size={size} ring />
        </View>
      ))}
      {overflow > 0 ? (
        <View
          style={[
            styles.more,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              marginLeft: -Math.round(size * 0.35),
            },
          ]}
        >
          <Text style={[styles.moreText, { fontSize: Math.max(9, Math.round(size * 0.34)) }]}>
            +{overflow}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  initials: {
    alignItems: "center",
    justifyContent: "center",
  },
  initialsText: {
    color: "#fff",
    fontWeight: "800",
  },
  stack: {
    flexDirection: "row",
    alignItems: "center",
  },
  more: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 2,
    borderColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
  },
  moreText: {
    color: colors.textDim,
    fontWeight: "800",
  },
});
