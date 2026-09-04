# I'm Going — iOS client (placeholder)

The SwiftUI app is **Slice 4** of the MVP build. This directory is reserved for it.

Planned (per spec §3):
- Onboarding: value pitch → phone + OTP → name/username/DOB (18+ gate with rejection screen).
- Tab bar: **Trending | My Plans | Profile**, floating "I'm going tonight" button.
- Announce sheet: POI search over seeded venues + "Create custom spot" (name, pin/address,
  description, category) → start time + note + publish.
- Event/Spot detail: going list (name + stars), "I'm going" toggle, check-in button inside the
  event window, Live feed of posts, Share button, report button.
- My Plans, Post composer (requires verified check-in), Profile (stars), Settings.
- Share card handed to the native iOS share sheet (no per-platform API keys).

API base URL for dev: `http://127.0.0.1:8080` (or the LAN host where the API runs).

Nothing to build here until Slice 4.