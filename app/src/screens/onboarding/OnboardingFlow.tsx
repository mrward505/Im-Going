/**
 * Onboarding orchestration — step state machine (spec §2a): Welcome →
 * phone+OTP → profile (name/username/DOB+18+) → done (hand off to main tabs).
 * On "login" (existing user) it hands off immediately.
 */
import React, { useCallback, useState } from "react";
import { View } from "react-native";
import { setCachedUser } from "../../api/tokenStorage";
import type { User } from "../../api/types";
import { colors } from "../../theme";
import { WelcomeScreen } from "./WelcomeScreen";
import { PhoneOtpScreen } from "./PhoneOtpScreen";
import { ProfileStepScreen } from "./ProfileStepScreen";
import { UnderageScreen } from "./UnderageScreen";

type Step = "welcome" | "phone" | "profile" | "underage";

interface Props {
  onDone: (user: User | null) => void;
}

export function OnboardingFlow({ onDone }: Props): React.JSX.Element {
  const [step, setStep] = useState<Step>("welcome");
  const [phone, setPhone] = useState<string>("");
  const [signupToken, setSignupToken] = useState<string>("");

  const handleRegistered = useCallback(
    async (token: string) => {
      // We have a token; user row comes from GET /me or the register payload.
      // Persist the token in api client (setToken already called by client).
      await setCachedUser(null);
      onDone(null); // token stored; main nav reads user via /me
      void token;
    },
    [onDone],
  );

  const handleLogin = useCallback(
    (p: string) => {
      setPhone(p);
      onDone(null);
    },
    [onDone],
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {step === "welcome" && <WelcomeScreen onStart={() => setStep("phone")} />}
      {step === "phone" && (
        <PhoneOtpScreen
          onBack={() => setStep("welcome")}
          onVerified={(p, st) => {
            setPhone(p);
            setSignupToken(st);
            setStep("profile");
          }}
          onLoggedIn={handleLogin}
        />
      )}
      {step === "profile" && (
        <ProfileStepScreen
          phone={phone}
          signupToken={signupToken}
          onRegistered={handleRegistered}
          onBack={() => setStep("phone")}
          onUnderage={() => setStep("underage")}
          onCancel={() => setStep("welcome")}
        />
      )}
      {step === "underage" && <UnderageScreen onExit={() => setStep("welcome")} />}
    </View>
  );
}