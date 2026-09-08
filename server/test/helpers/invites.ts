/**
 * Shared LIVE-test helper: invite-aware user signup.
 *
 * Register now requires an invite_code (Tempe launch gate), so every test
 * helper that signs a user up mints a fresh single-use code via the admin
 * endpoint first. Mint-then-register keeps each helper self-contained and
 * exercises the real gate path (no shortcuts, no fabricated rows).
 */
export async function mintInvite(
  jfetch: (path: string, init?: RequestInit) => Promise<{ status: number; body: Record<string, unknown> }>,
  label = "test",
): Promise<string> {
  const mint = await jfetch("/api/v1/admin/invites/mint", {
    method: "POST",
    body: JSON.stringify({ count: 1, label }),
  });
  if (mint.status !== 201) throw new Error(`invite mint failed: ${JSON.stringify(mint.body)}`);
  const codes = mint.body.codes as { code: string }[];
  return codes[0].code;
}

/** Full OTP → verify → register loop for a fresh phone, using a minted code. */
export async function signupUser(
  jfetch: (path: string, init?: RequestInit) => Promise<{ status: number; body: Record<string, unknown> }>,
  opts: { phone: string; displayName: string; username: string; dob?: string; inviteCode?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const code = opts.inviteCode ?? (await mintInvite(jfetch));
  const req = await jfetch("/api/v1/auth/otp/request", {
    method: "POST",
    body: JSON.stringify({ phone: opts.phone }),
  });
  if (req.status !== 201) throw new Error(`otp request failed: ${JSON.stringify(req.body)}`);
  const ver = await jfetch("/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ phone: opts.phone, code: req.body.dev_code as string }),
  });
  if (ver.body.type !== "signup" || !ver.body.signup_token) {
    throw new Error(`expected signup token, got: ${JSON.stringify(ver.body)}`);
  }
  return jfetch("/api/v1/auth/register", {
    method: "POST",
    body: JSON.stringify({
      signup_token: ver.body.signup_token,
      display_name: opts.displayName,
      username: opts.username,
      dob: opts.dob ?? "2000-01-01",
      invite_code: code,
    }),
  });
}
