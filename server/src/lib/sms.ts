/**
 * SMS provider interface + implementations. Slice 1 ships the `console`
 * provider (code printed to the server log) so the whole OTP flow works in
 * dev with zero credentials. The `twilio` implementation is a structured
 * stub: it documents the exact env vars and throws a clear error until a
 * later slice wires real Twilio Verify calls.
 */
import { getConfig } from "../env";

export interface SmsProvider {
  readonly name: string;
  /** Deliver a 6-digit OTP to an E.164 phone number. */
  sendOtp(phone: string, code: string): Promise<void>;
}

export class ConsoleSmsProvider implements SmsProvider {
  readonly name = "console";
  async sendOtp(phone: string, code: string): Promise<void> {
    console.log(`[OTP:console] code for ${phone}: ${code}  (dev only — never in production)`);
  }
}

export class TwilioSmsProvider implements SmsProvider {
  readonly name = "twilio";
  async sendOtp(phone: string, code: string): Promise<void> {
    // Stub: shape of the real Twilio Verify call (later slice).
    // fetch(`https://verify.twilio.com/v2/Services/${SID}/Verifications`, {
    //   method: "POST",
    //   headers: { Authorization: `Basic ${btoa(`${SID}:${TOKEN}`)}` },
    //   body: new URLSearchParams({ To: phone, Channel: "sms" }),
    // })
    void phone;
    void code;
    throw new Error(
      "Twilio SMS provider is not wired yet (slice 1 stub). Set OTP_PROVIDER=console for dev, " +
        "or add the Twilio Verify call in src/lib/sms.ts when credentials are provided.",
    );
  }
}

export function smsProviderFromConfig(): SmsProvider {
  const cfg = getConfig();
  return cfg.OTP_PROVIDER === "twilio" ? new TwilioSmsProvider() : new ConsoleSmsProvider();
}