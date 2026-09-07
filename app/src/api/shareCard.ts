/**
 * Shared share-card helper for "I'm Going" (slice 4d-2, polished in 4d-3b):
 * build the one-tap share payload from GET /api/v1/spots/:id/share, open the
 * native share sheet (RN Share API — iOS sheet, Android chooser, web
 * navigator.share/clipboard), and record attribution (POST /api/v1/shares).
 *
 * The share text is a nightlife share-card in one line (spec §2g + owner
 * 2026-09-07): dark-gradient card, big type "I'm going — are you? 🎟️", venue,
 * live going-now + heat badge when the spot is live, and the imgoing link —
 * real wire numbers only, never invented.
 */
import { Platform, Share } from "react-native";
import { api, ApiError } from "./client";
import type { SpotShareResponse } from "./types";

export interface ShareCardResult {
  status: "shared" | "dismissed" | "copied";
  remaining: number | null;
}

const HEAT_LABELS: Record<number, string> = {
  0: "Calm",
  1: "Warming",
  2: "Hot",
  3: "On fire",
};

/** Render the card text from the share snapshot payload. */
export function buildShareMessage(
  card: SpotShareResponse["card"],
  deepLink: string,
): string {
  const when = card.next_start_at
    ? new Date(card.next_start_at).toLocaleString([], {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "soon";
  const where =
    card.is_verified && card.address
      ? card.address
      : (card.masked_address ?? card.city);
  const heat = card.heat_level != null ? HEAT_LABELS[card.heat_level] ?? "Calm" : null;
  const live = card.going_now != null && card.going_now > 0
    ? `· ${card.going_now} going now ${heat ? `· ${heat}` : ""}`
    : heat && heat !== "Calm"
      ? ` · ${heat}`
      : "";
  const who = card.going_count > 0 ? `${card.going_count} going` : "Be the first going";
  return `I'm going — are you? 🎟️ → ${card.spot_name} (${when}, ${where}). ${who}${live}. via I'm Going ${deepLink}`;
}

/**
 * Full share flow for a spot: fetch the card snapshot (throws 429 when the
 * 10/day budget is exhausted), open the sheet, record the share.
 * `eventId` attributes the share when launched from an announce success.
 * `record` lets headless verification compose the message without side effects.
 */
export async function shareSpot(
  spotId: string,
  opts: { eventId?: string; record?: boolean } = {},
): Promise<ShareCardResult> {
  const snap = await api.spotShare(spotId);
  const message = buildShareMessage(snap.card, snap.share.deep_link);
  const record = opts.record ?? true;

  const onWeb = Platform.OS === "web";
  if (onWeb && typeof navigator !== "undefined") {
    const nav = navigator as Navigator & {
      share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
      clipboard?: { writeText: (t: string) => Promise<void> };
    };
    if (nav.share) {
      try {
        await nav.share({ title: "I'm Going", text: message });
      } catch (e) {
        // User dismissed the in-app share dialog — treat as a dismiss, not an error.
        if (e instanceof Error && /abort/i.test(e.message)) {
          return { status: "dismissed", remaining: snap.share.remaining };
        }
        throw e;
      }
    } else if (nav.clipboard) {
      await nav.clipboard.writeText(message);
      if (record) {
        try {
          await api.recordShare({ event_id: opts.eventId });
        } catch {
          // clipboard copy already succeeded — budget errors are non-fatal
        }
      }
      return { status: "copied", remaining: snap.share.remaining };
    } else {
      throw new ApiError(0, "share_unavailable", "Sharing isn't available in this browser.");
    }
  } else {
    try {
      const res = await Share.share({ message, title: "I'm Going" });
      if (res.action === Share.dismissedAction) {
        return { status: "dismissed", remaining: snap.share.remaining };
      }
    } catch (e) {
      // No share targets (common on simulators): fall back to clipboard copy.
      const msg = e instanceof Error ? e.message : "";
      if (/no activity|not available|no apps/i.test(msg)) {
        throw new ApiError(0, "share_unavailable", "No share targets on this device — copy the link instead.");
      }
      throw e;
    }
  }

  if (record) {
    try {
      const budget = await api.recordShare({ event_id: opts.eventId });
      return { status: "shared", remaining: budget.remaining };
    } catch (e) {
      // The card send already happened — a 429 here just means the budget ran
      // out between snapshot and record; surface the snapshot value instead.
      if (e instanceof ApiError && e.status === 429) {
        return { status: "shared", remaining: 0 };
      }
      throw e;
    }
  }
  return { status: "shared", remaining: snap.share.remaining };
}

/** Human copy for the 10/day budget error (spec §2g). */
export function shareErrorCopy(e: unknown): string {
  if (e instanceof ApiError && e.status === 429) {
    return "Daily share limit reached (10/day) — come back tomorrow.";
  }
  return e instanceof ApiError ? e.message : "Share failed. Try again.";
}
