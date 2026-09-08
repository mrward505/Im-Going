/**
 * Design tokens for I'm Going — dark, night-out-first palette.
 */
export const colors = {
  background: "#0B0D10",
  surface: "#15181E",
  surfaceAlt: "#1E222B",
  border: "#2A2F3A",
  text: "#F5F7FA",
  textDim: "#9AA3B2",
  primary: "#7C5CFF", // going-purple
  primaryDim: "#5A43C4",
  accent: "#FF4D6D", // live/trending pink
  success: "#3DDC97",
  danger: "#FF5A5F",
  star: "#FFC24B",
  card: "#171A21",
} as const;

/**
 * Nightlife accent family for the alive/onboarding polish (owner direction
 * 2026-09-07). Additive only — existing tokens above are untouched.
 */
export const neon = {
  bgDeep: "#07080D", // near-black navy base
  bgNavy: "#0D1026", // deep navy wash
  pink: "#FF3D7F", // hot pink — primary neon
  purple: "#8B5CFF", // electric purple
  cyan: "#3DE8FF", // cyan spark
  pinkGlow: "rgba(255, 61, 127, 0.45)",
  purpleGlow: "rgba(139, 92, 255, 0.4)",
  cyanGlow: "rgba(61, 232, 255, 0.28)",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;