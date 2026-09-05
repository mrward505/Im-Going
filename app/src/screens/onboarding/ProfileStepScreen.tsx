/**
 * Onboarding — Name / username / DOB step with 18+ gate (spec §2a + §3).
 * DOB is self-reported; anyone under 18 is rejected client-side AND the
 * server rejects too (`assertAdult` in server route). A local 18+ check here
 * gives instant feedback before calling the API.
 */
import React, { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { authApi } from "../../api/client";
import { ApiError } from "../../api/client";
import { colors, spacing } from "../../theme";

interface Props {
  phone: string;
  signupToken: string;
  onRegistered: (token: string) => void;
  onBack: () => void;
  onUnderage: () => void;
  onCancel: () => void;
}

const DAY = 86_400_000;

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local 18+ gate — mirrors the server rule (spec §2a, owner decision). */
function ageYears(dob: Date): number {
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age;
}

export function ProfileStepScreen({
  phone,
  signupToken,
  onRegistered,
  onBack,
  onUnderage,
  onCancel,
}: Props): React.JSX.Element {
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [dob, setDob] = useState<Date | null>(null);
  const [dobText, setDobText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dobParsed = useMemo(() => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dobText.trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }, [dobText]);

  const under18 = dobParsed !== null && ageYears(dobParsed) < 18;
  const usernameOk = /^[a-z0-9_]{3,20}$/.test(username);
  const canSubmit = displayName.trim().length >= 1 && usernameOk && dobParsed !== null && !under18;

  async function submit(): Promise<void> {
    if (!canSubmit || !dobParsed) return;
    // 18+ gate: instant local rejection (server enforces the same rule).
    if (ageYears(dobParsed) < 18) {
      onUnderage();
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await authApi.register({
        signup_token: signupToken,
        display_name: displayName.trim(),
        username: username.trim().toLowerCase(),
        dob: toIso(dobParsed),
      });
      onRegistered(res.token);
    } catch (e) {
      if (e instanceof ApiError && e.code === "forbidden") {
        onUnderage();
        return;
      }
      setError(e instanceof ApiError ? e.message : "Signup failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.container}>
      <Pressable onPress={onBack} hitSlop={12}>
        <Text style={styles.back}>← Back</Text>
      </Pressable>
      <Text style={styles.title}>Make it yours</Text>
      <Text style={styles.subtitle}>
        Verified {phone} — now tell us who you are. (18+ only.)
      </Text>

      <Text style={styles.label}>Name</Text>
      <TextInput
        style={styles.input}
        placeholder="Ethan"
        placeholderTextColor={colors.textDim}
        value={displayName}
        onChangeText={setDisplayName}
        maxLength={60}
      />

      <Text style={styles.label}>Username</Text>
      <TextInput
        style={styles.input}
        placeholder="ethan_t (3–20: a-z, 0-9, _)"
        placeholderTextColor={colors.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        value={username}
        onChangeText={(t) => setUsername(t.toLowerCase())}
        maxLength={20}
      />
      {username.length > 0 && !usernameOk && (
        <Text style={styles.hint}>Only lowercase letters, numbers and underscores (3–20).</Text>
      )}

      <Text style={styles.label}>Date of birth</Text>
      <TextInput
        style={styles.input}
        placeholder="YYYY-MM-DD (e.g. 2002-05-14)"
        placeholderTextColor={colors.textDim}
        keyboardType="numbers-and-punctuation"
        value={dobText}
        onChangeText={(t) => {
          setDobText(t);
          setDob(null);
        }}
        onBlur={() => dobParsed && setDob(dobParsed)}
        maxLength={10}
      />
      {under18 ? (
        <Text style={styles.underage}>I&apos;m Going is 18+ — you&apos;re not old enough yet.</Text>
      ) : null}

      {error && <Text style={styles.error}>{error}</Text>}

      <Pressable
        style={({ pressed }) => [
          styles.button,
          (!canSubmit || submitting) && styles.buttonDisabled,
          pressed && styles.buttonPressed,
        ]}
        onPress={submit}
        disabled={!canSubmit || submitting}
      >
        {submitting ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Create account</Text>
        )}
      </Pressable>
      <Pressable onPress={onCancel} hitSlop={8} style={styles.cancelWrap}>
        <Text style={styles.cancel}>Cancel signup</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.xl,
    paddingTop: spacing.xl * 1.5,
  },
  back: {
    color: colors.textDim,
    fontSize: 15,
    marginBottom: spacing.lg,
  },
  title: {
    color: colors.text,
    fontSize: 26,
    fontWeight: "700",
  },
  subtitle: {
    color: colors.textDim,
    fontSize: 14,
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
    lineHeight: 20,
  },
  label: {
    color: colors.textDim,
    fontSize: 13,
    marginBottom: spacing.xs,
    marginTop: spacing.md,
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    color: colors.text,
    fontSize: 16,
    padding: spacing.md,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: spacing.md,
    alignItems: "center",
    marginTop: spacing.xl,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonText: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "700",
  },
  underage: {
    color: colors.danger,
    fontSize: 14,
    marginTop: spacing.sm,
  },
  error: {
    color: colors.danger,
    fontSize: 14,
    marginTop: spacing.md,
  },
  hint: {
    color: colors.textDim,
    fontSize: 12,
    marginTop: spacing.xs,
  },
  cancelWrap: {
    marginTop: spacing.md,
    alignItems: "center",
  },
  cancel: {
    color: colors.textDim,
    fontSize: 14,
  },
});
void DAY;