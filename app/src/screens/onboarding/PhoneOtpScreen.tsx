/**
 * Onboarding — Phone + OTP step.
 * Dev flow: the API runs with OTP_PROVIDER=console, so the code is returned
 * in the request response as dev_code AND printed to the server log. We show
 * the dev code inline so the web preview is testable end-to-end.
 */
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { authApi } from "../../api/client";
import { ApiError } from "../../api/client";
import { colors, neon, spacing } from "../../theme";
import { NightlifeBackdrop } from "../../components/NightlifeBackdrop";

interface Props {
  onVerified: (phone: string, signupToken: string) => void;
  onBack: () => void;
  /** true when a login token was just received (straight into the app) */
  onLoggedIn: (phone: string) => void;
}

export function PhoneOtpScreen({ onVerified, onBack, onLoggedIn }: Props): React.JSX.Element {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Send once the phone is filled (button-triggered below).

  const normalizedPhone = phone.trim().replace(/[ ()-]/g, "");

  async function requestCode(): Promise<void> {
    setError(null);
    setSending(true);
    try {
      const res = await authApi.requestOtp(normalizedPhone);
      setRequestId(res.request_id);
      setDevCode(res.dev_code ?? null);
      setExpiresAt(res.expires_at);
      if (!res.dev_code) {
        setError("Check your texts for a 6-digit code (dev: it also prints to the server log).");
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not request a code. Is the API running?");
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    if (requestId && devCode) setCode(devCode); // prefill dev code for fast testing
  }, [devCode, requestId]);

  async function verify(): Promise<void> {
    if (code.length !== 6) {
      setError("Enter the 6-digit code");
      return;
    }
    setError(null);
    setVerifying(true);
    try {
      const res = await authApi.verifyOtp(normalizedPhone, code);
      if (res.type === "login") {
        onLoggedIn(normalizedPhone);
      } else {
        onVerified(normalizedPhone, res.signup_token);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Verification failed");
    } finally {
      setVerifying(false);
    }
  }

  const expiry = expiresAt ? new Date(expiresAt) : null;
  const valid = normalizedPhone.length >= 11;

  return (
    <View style={styles.container}>
      <NightlifeBackdrop />
      <View style={styles.content}>
      <Pressable onPress={onBack} hitSlop={12}>
        <Text style={styles.back}>← Back</Text>
      </Pressable>
      <Text style={styles.title}>Your phone number</Text>
      <Text style={styles.subtitle}>We&apos;ll text you a code to verify it&apos;s you.</Text>

      <TextInput
        style={styles.input}
        placeholder="+1 602 555 0123"
        placeholderTextColor={colors.textDim}
        autoComplete="tel"
        keyboardType="phone-pad"
        value={phone}
        onChangeText={setPhone}
        editable={!sending && !verifying}
      />
      <Pressable
        style={({ pressed }) => [
          styles.button,
          (!valid || sending) && styles.buttonDisabled,
          pressed && styles.buttonPressed,
        ]}
        onPress={requestCode}
        disabled={!valid || sending}
      >
        {sending ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>{devCode ? "Resend code" : "Send code"}</Text>
        )}
      </Pressable>

      {requestId && (
        <View style={styles.codeBox}>
          <Text style={styles.codeLabel}>6-digit code</Text>
          <TextInput
            style={styles.input}
            placeholder="000000"
            placeholderTextColor={colors.textDim}
            keyboardType="number-pad"
            maxLength={6}
            value={code}
            onChangeText={setCode}
            editable={!verifying}
            autoFocus
          />
          {devCode ? (
            <Text style={styles.devHint}>
              Dev console OTP — code {devCode} has been auto-filled for you.
            </Text>
          ) : null}
          <Pressable
            style={({ pressed }) => [
              styles.button,
              (code.length !== 6 || verifying) && styles.buttonDisabled,
              pressed && styles.buttonPressed,
            ]}
            onPress={verify}
            disabled={code.length !== 6 || verifying}
          >
            {verifying ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>Verify</Text>
            )}
          </Pressable>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}
      {expiry && <Text style={styles.hint}>Code expires {expiry.toLocaleTimeString()}.</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: neon.bgDeep,
  },
  content: {
    flex: 1,
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
    fontSize: 28,
    fontWeight: "800",
    textShadowColor: neon.purpleGlow,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 18,
  },
  subtitle: {
    color: colors.textDim,
    fontSize: 15,
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
  },
  input: {
    backgroundColor: "rgba(13, 16, 38, 0.85)",
    borderColor: neon.purple,
    borderWidth: 1,
    borderRadius: 12,
    color: colors.text,
    fontSize: 17,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  button: {
    backgroundColor: neon.pink,
    borderColor: "#FF7AA5",
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: spacing.md,
    alignItems: "center",
    shadowColor: neon.pink,
    shadowOpacity: 0.8,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
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
  codeBox: {
    marginTop: spacing.xl,
  },
  codeLabel: {
    color: colors.textDim,
    fontSize: 13,
    marginBottom: spacing.sm,
  },
  devHint: {
    color: colors.star,
    fontSize: 13,
    marginBottom: spacing.md,
  },
  error: {
    color: colors.danger,
    fontSize: 14,
    marginTop: spacing.md,
  },
  hint: {
    color: colors.textDim,
    fontSize: 12,
    marginTop: spacing.sm,
  },
});