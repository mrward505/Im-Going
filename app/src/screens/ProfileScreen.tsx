/**
 * Profile tab — real user data (GET /me) + star rating + logout.
 * Placeholder-quality for this slice, but wired to the real API.
 */
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { api } from "../api/client";
import type { User } from "../api/types";
import { colors, spacing } from "../theme";

interface Props {
  onLogout: () => void;
}

export function ProfileScreen({ onLogout }: Props): React.JSX.Element {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.me();
      setUser(res.user);
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