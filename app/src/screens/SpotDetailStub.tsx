/**
 * Spot Detail (slice 4d-2, spec §3.4): the real spot screen.
 *
 * - Spot info: name, category, city; verified → real address + map coords;
 *   custom (unverified) → masked address until the viewer confirms going.
 * - Next upcoming event (formatted start, going count) + "I'm going" toggle
 *   (POST / DELETE /api/v1/events/:id/going via the shared client).
 * - Going list: names + star ratings from GET /events/:id/going (viewer
 *   highlighted via is_me).
 * - Check-in button: rendered ONLY inside the event window
 *   [start − 30 min, start + 150 min] (spec §2e); one-shot expo-location fix
 *   → POST /events/:id/checkin; verified state shown after.
 * - Live feed: GET /spots/:id/feed rows (poster name + stars, caption, media
 *   inline — image rendered, video as a placeholder with duration/size),
 *   pull-to-refresh, load-more pagination.
 * - Report button per post: reason picker → POST /posts/:id/report.
 * - Share: GET /spots/:id/share → native share sheet via RN Share (web
 *   navigator.share) → POST /shares attribution; 429 (10/day budget) surfaces
 *   as a friendly line and flips to the disabled state.
 * - Post composer: gated on my_checked_in — "Post" appears after check-in.
 *
 * Navigation contract is unchanged: props { spotId, onBack }.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Location from "expo-location";
import { api, ApiError } from "../api/client";
import { shareSpot, shareErrorCopy } from "../api/shareCard";
import type {
  EventGoingResponse,
  ModerationReason,
  Post,
  SpotDetailResponse,
  SpotFeedRow,
} from "../api/types";
import { colors, spacing } from "../theme";
import { CategoryPill, StarTag, formatNextStart } from "../components/hero";
import { GoingWithYou, HeatBadge } from "../components/live";
import { PostComposerSheet } from "../components/PostComposerSheet";

interface Props {
  spotId: string;
  onBack: () => void;
}

const FEED_PAGE = 20;

/** Check-in window per spec §2e: [start − 30 min, start + 150 min]. */
function checkinWindow(startAtIso: string): { open: number; close: number } {
  const start = new Date(startAtIso).getTime();
  return { open: start - 30 * 60_000, close: start + 150 * 60_000 };
}

function fmtPostDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function videoMeta(row: SpotFeedRow): string {
  const bits: string[] = [];
  if (row.duration_s != null) bits.push(`${Math.round(row.duration_s)}s`);
  if (row.width != null && row.height != null) bits.push(`${row.width}×${row.height}`);
  return bits.join(" · ");
}

const REPORT_REASONS: ModerationReason[] = ["spam", "harassment", "nudity", "violence", "other"];

function FeedItem({
  row,
  reported,
  reporting,
  onReport,
}: {
  row: SpotFeedRow;
  reported: boolean;
  reporting: boolean;
  onReport: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.post}>
      <View style={styles.postHead}>
        <Text style={styles.poster} numberOfLines={1}>
          {row.poster.display_name}
        </Text>
        <StarTag stars={row.poster.star_rating} />
        <Text style={styles.postDate}>{fmtPostDate(row.created_at)}</Text>
      </View>
      {row.caption ? (
        <Text style={styles.caption}>{row.caption}</Text>
      ) : null}
      {row.type === "image" ? (
        row.media_url ? (
          <Image source={{ uri: row.media_url }} style={styles.media} resizeMode="cover" />
        ) : (
          <View style={styles.mediaMissing}>
            <Text style={styles.mediaMissingText}>Photo unavailable</Text>
          </View>
        )
      ) : (
        <View style={styles.videoBox}>
          <Text style={styles.videoGlyph}>▶</Text>
          <Text style={styles.videoMeta}>
            Video{videoMeta(row) ? ` · ${videoMeta(row)}` : ""}
          </Text>
          {!row.media_url ? (
            <Text style={styles.videoMeta}>Preview unavailable</Text>
          ) : null}
        </View>
      )}
      <View style={styles.postFoot}>
        <Text style={styles.eventLine} numberOfLines={1}>
          {formatNextStart(row.event.start_at)} · {row.event.going_count} going
        </Text>
        {reported ? (
          <Text style={styles.reported}>Reported ✓</Text>
        ) : (
          <Pressable onPress={onReport} disabled={reporting} hitSlop={8}>
            {reporting ? (
              <ActivityIndicator size="small" color={colors.textDim} />
            ) : (
              <Text style={styles.report}>Report</Text>
            )}
          </Pressable>
        )}
      </View>
    </View>
  );
}

export function SpotDetailStub({ spotId, onBack }: Props): React.JSX.Element {
  const [detail, setDetail] = useState<SpotDetailResponse | null>(null);
  const [going, setGoing] = useState<EventGoingResponse | null>(null);
  const [posts, setPosts] = useState<SpotFeedRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [checkingIn, setCheckingIn] = useState(false);
  const [checkinError, setCheckinError] = useState<string | null>(null);
  const [checkedIn, setCheckedIn] = useState(false);
  const [reportedIds, setReportedIds] = useState<Set<string>>(new Set());
  const [reportingId, setReportingId] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareDisabled, setShareDisabled] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);

  const loadFeedPage = useCallback(
    async (offset: number): Promise<void> => {
      const res = await api.spotFeed(spotId, { limit: FEED_PAGE, offset });
      if (offset === 0) setPosts(res.posts);
      else setPosts((prev) => [...prev, ...res.posts]);
      setHasMore(res.pagination.count >= FEED_PAGE);
    },
    [spotId],
  );

  const load = useCallback(
    async (mode: "initial" | "refresh" | "quiet") => {
      if (mode === "initial") setLoading(true);
      else if (mode === "refresh") setRefreshing(true);
      setError(null);
      try {
        const res = await api.spot(spotId);
        setDetail(res);
        setCheckedIn(res.my_checked_in ?? false);
        const eventId = res.next_event?.id ?? null;
        if (eventId) {
          const [g] = await Promise.all([api.eventGoing(eventId), loadFeedPage(0)]);
          void g;
          setGoing(g);
        } else {
          setGoing(null);
          await loadFeedPage(0);
        }
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Could not load this spot. Is the API running?");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [spotId, loadFeedPage],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  async function loadMore(): Promise<void> {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      await loadFeedPage(posts.length);
    } catch (e) {
      Alert.alert("Feed", e instanceof ApiError ? e.message : "Could not load more posts.");
    } finally {
      setLoadingMore(false);
    }
  }

  async function toggleGoing(): Promise<void> {
    const eventId = detail?.next_event?.id;
    if (!eventId || toggling) return;
    setToggling(true);
    setActionError(null);
    try {
      if (myGoing) {
        const res = await api.cancelGoing(eventId);
        if (res.settlement === "soft_no_show") {
          Alert.alert("Late cancel", "This counts as a soft no-show (−30).");
        }
      } else {
        await api.confirmGoing(eventId);
      }
      await load("quiet");
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : "Try again.");
    } finally {
      setToggling(false);
    }
  }

  async function checkIn(): Promise<void> {
    const eventId = detail?.next_event?.id;
    if (!eventId || checkingIn) return;
    setCheckingIn(true);
    setCheckinError(null);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        setCheckinError("Location permission is needed to verify you're here.");
        return;
      }
      const fix = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      await api.checkin(eventId, {
        lat: fix.coords.latitude,
        lon: fix.coords.longitude,
        accuracy_m: fix.coords.accuracy ?? undefined,
        method: "manual_gps",
      });
      setCheckedIn(true);
      await load("quiet");
    } catch (e) {
      setCheckinError(e instanceof ApiError ? e.message : "Check-in failed — try again.");
    } finally {
      setCheckingIn(false);
    }
  }

  function report(row: SpotFeedRow): void {
    Alert.alert("Report post", "Why are you reporting this?", [
      ...REPORT_REASONS.map((reason) => ({
        text: reason.charAt(0).toUpperCase() + reason.slice(1),
        onPress: () => void sendReport(row.id, reason),
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);
  }

  async function sendReport(postId: string, reason: ModerationReason): Promise<void> {
    setReportingId(postId);
    try {
      await api.reportPost(postId, reason);
      setReportedIds((prev) => new Set(prev).add(postId));
      Alert.alert("Reported", "Thanks — our team will review it.");
    } catch (e) {
      Alert.alert("Report failed", e instanceof ApiError ? e.message : "Try again.");
    } finally {
      setReportingId(null);
    }
  }

  async function sendShare(): Promise<void> {
    if (shareDisabled) return;
    setShareError(null);
    try {
      const res = await shareSpot(spotId, {
        eventId: detail?.next_event?.id ?? undefined,
        record: true,
      });
      if (res.status === "dismissed" || res.status === "copied") {
        // dismissed or copied-to-clipboard — no record, no toast
        if (res.remaining === 0) setShareDisabled(true);
        return;
      }
      if (res.remaining === 0) setShareDisabled(true);
    } catch (e) {
      setShareError(shareErrorCopy(e));
      if (e instanceof ApiError && e.status === 429) setShareDisabled(true);
    }
  }

  function handlePosted(_post: Post): void {
    // close the composer and refresh the live feed from the server so the
    // fresh post carries real poster identity (name + stars)
    setComposerOpen(false);
    void load("quiet");
  }

  const spot = detail?.spot ?? null;
  const next = detail?.next_event ?? null;
  const eventIdForComposer = next?.id ?? null;
  const win = next ? checkinWindow(next.start_at) : null;
  const now = Date.now();
  const inWindow = win != null && now >= win.open && now <= win.close;
  const goingCount = detail?.going_count ?? 0;
  const myGoing = detail?.my_going ?? false;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={() => void load("refresh")} tintColor={colors.primary} />
      }
    >
      <Pressable onPress={onBack} hitSlop={12} style={styles.back}>
        <Text style={styles.backText}>← Back</Text>
      </Pressable>
      {loading ? (
        <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: spacing.xl }} />
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <Pressable onPress={() => void load("initial")} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : spot ? (
        <>
          <View style={styles.nameRow}>
            <Text style={styles.name}>{spot.name}</Text>
            <HeatBadge
              signals={{
                going_now: detail?.going_now ?? 0,
                heat_level: detail?.heat_level ?? 0,
                heat_count: detail?.heat_count ?? 0,
              }}
              size="sm"
            />
          </View>
          <View style={styles.meta}>
            <CategoryPill category={spot.category} />
            <Text style={styles.city}>{spot.city}</Text>
          </View>
          <Text style={styles.address}>
            {spot.address ?? spot.masked_address ?? "Private spot"}
          </Text>
          {spot.lat !== undefined && spot.lon !== undefined ? (
            <Text style={styles.coords}>
              📍 {spot.lat.toFixed(4)}, {spot.lon.toFixed(4)}
            </Text>
          ) : null}
          {!spot.is_verified && spot.address == null ? (
            <Text style={styles.maskNote}>Exact address unlocks after you tap “I&apos;m going.”</Text>
          ) : null}

          {next ? (
            <View style={[styles.eventCard, myGoing && styles.eventCardMine]}>
              <Text style={styles.next}>
                Next: {formatNextStart(next.start_at)} · {goingCount} going
              </Text>
              {detail?.going_now != null && detail.going_now > 0 ? (
                <Text style={styles.liveNowDetail}>
                  <Text style={styles.liveDot}>●</Text> {detail.going_now} here now
                </Text>
              ) : null}
              {detail?.going_with_you != null ? (
                <View style={styles.gwyWrap}>
                  <GoingWithYou count={detail.going_with_you} mine={detail.my_going} />
                </View>
              ) : null}
              {next.note ? (
                <Text style={styles.note} numberOfLines={2}>
                  “{next.note}”
                </Text>
              ) : null}
              <View style={styles.actionRow}>
                <Pressable
                  onPress={() => void toggleGoing()}
                  disabled={toggling}
                  style={({ pressed }) => [
                    styles.goingButton,
                    myGoing && styles.goingButtonActive,
                    pressed && styles.pressed,
                  ]}
                >
                  {toggling ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.goingButtonText}>
                      {myGoing ? "I'm going ✓" : "I'm going"}
                    </Text>
                  )}
                </Pressable>
                {inWindow && !checkedIn ? (
                  <Pressable
                    onPress={() => void checkIn()}
                    disabled={checkingIn}
                    style={({ pressed }) => [styles.checkinButton, pressed && styles.pressed]}
                  >
                    {checkingIn ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={styles.goingButtonText}>I&apos;m here</Text>
                    )}
                  </Pressable>
                ) : null}
                {checkedIn ? <Text style={styles.verified}>Checked in ✓</Text> : null}
                {checkedIn ? (
                  <Pressable
                    onPress={() => setComposerOpen(true)}
                    style={({ pressed }) => [styles.postButton, pressed && styles.pressed]}
                  >
                    <Text style={styles.goingButtonText}>Post 📸</Text>
                  </Pressable>
                ) : null}
              </View>
              {!inWindow && !checkedIn ? (
                <Text style={styles.windowHint}>
                  {win && now < win.open
                    ? "Check-in opens 30 min before start."
                    : "Check-in window has closed."}
                </Text>
              ) : null}
              {actionError ? <Text style={styles.inlineError}>{actionError}</Text> : null}
              {checkinError ? <Text style={styles.inlineError}>{checkinError}</Text> : null}
            </View>
          ) : (
            <Text style={styles.next}>No upcoming event yet — be the first to announce.</Text>
          )}

          {next ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Going · {going?.count ?? goingCount}</Text>
              {going && going.going.length > 0 ? (
                going.going.map((g) => (
                  <View key={g.user_id} style={[styles.goingRow, g.is_me && styles.goingRowMe]}>
                    <Text style={[styles.goingName, g.is_me && styles.goingNameMe]} numberOfLines={1}>
                      {g.display_name}
                      {g.is_me ? " · you" : ""}
                    </Text>
                    <StarTag stars={g.star_rating} />
                  </View>
                ))
              ) : (
                <Text style={styles.empty}>No confirmations yet.</Text>
              )}
            </View>
          ) : null}

          <View style={styles.shareRow}>
            <Pressable
              onPress={() => void sendShare()}
              disabled={shareDisabled}
              style={({ pressed }) => [
                styles.shareButton,
                shareDisabled && styles.shareButtonDisabled,
                pressed && !shareDisabled && styles.pressed,
              ]}
            >
              <Text style={styles.shareButtonText}>
                {shareDisabled ? "Daily share limit reached" : "Share — I'm going"}
              </Text>
            </Pressable>
            {shareError ? <Text style={styles.inlineError}>{shareError}</Text> : null}
            {!shareDisabled ? (
              <Text style={styles.stubNote}>Share the card to any app — your night, your audience.</Text>
            ) : null}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Live · {posts.length}</Text>
            {posts.length > 0 ? (
              posts.map((row) => (
                <FeedItem
                  key={row.id}
                  row={row}
                  reported={reportedIds.has(row.id)}
                  reporting={reportingId === row.id}
                  onReport={() => report(row)}
                />
              ))
            ) : (
              <Text style={styles.empty}>No posts from this spot yet — check in and post the first.</Text>
            )}
            {hasMore ? (
              <Pressable
                onPress={() => void loadMore()}
                disabled={loadingMore}
                style={({ pressed }) => [styles.more, pressed && styles.pressed]}
              >
                {loadingMore ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Text style={styles.moreText}>Load more</Text>
                )}
              </Pressable>
            ) : null}
          </View>
        </>
      ) : null}
      <PostComposerSheet
        visible={composerOpen && eventIdForComposer != null}
        eventId={eventIdForComposer ?? ""}
        onClose={() => setComposerOpen(false)}
        onPosted={handlePosted}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
  },
  back: {
    marginBottom: spacing.md,
  },
  backText: {
    color: colors.primary,
    fontWeight: "700",
    fontSize: 15,
  },
  center: {
    alignItems: "center",
    marginTop: spacing.xl,
  },
  error: {
    color: colors.danger,
    fontSize: 14,
    textAlign: "center",
  },
  retry: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    backgroundColor: colors.primary,
  },
  retryText: {
    color: "#fff",
    fontWeight: "700",
  },
  name: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "800",
    flex: 1,
    marginRight: spacing.sm,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  city: {
    color: colors.textDim,
    fontSize: 13,
  },
  address: {
    color: colors.text,
    fontSize: 15,
    marginTop: spacing.sm,
  },
  coords: {
    color: colors.textDim,
    fontSize: 13,
    marginTop: 4,
  },
  maskNote: {
    color: colors.star,
    fontSize: 13,
    marginTop: 4,
  },
  eventCard: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: 14,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  eventCardMine: {
    borderColor: colors.primary,
  },
  next: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
  },
  liveNowDetail: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "800",
    marginTop: spacing.xs,
  },
  liveDot: {
    color: colors.accent,
    fontSize: 10,
  },
  gwyWrap: {
    marginTop: spacing.sm,
  },
  note: {
    color: colors.textDim,
    fontSize: 13,
    fontStyle: "italic",
    marginTop: spacing.sm,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.md,
    flexWrap: "wrap",
  },
  goingButton: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: 999,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  goingButtonActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  checkinButton: {
    backgroundColor: colors.success,
    borderRadius: 999,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  goingButtonText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 14,
  },
  verified: {
    color: colors.success,
    fontSize: 14,
    fontWeight: "700",
  },
  windowHint: {
    color: colors.textDim,
    fontSize: 12,
    marginTop: spacing.sm,
  },
  inlineError: {
    color: colors.danger,
    fontSize: 13,
    marginTop: spacing.sm,
  },
  pressed: {
    opacity: 0.7,
  },
  section: {
    marginTop: spacing.lg,
  },
  sectionTitle: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  goingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.xs,
  },
  goingRowMe: {
    borderColor: colors.primary,
  },
  goingName: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
    flex: 1,
    marginRight: spacing.sm,
  },
  goingNameMe: {
    color: colors.primary,
    fontWeight: "800",
  },
  empty: {
    color: colors.textDim,
    fontSize: 14,
  },
  shareRow: {
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
  shareButton: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: 999,
    paddingVertical: spacing.sm,
    alignItems: "center",
  },
  shareButtonDisabled: {
    borderColor: colors.border,
    opacity: 0.6,
  },
  shareButtonText: {
    color: colors.text,
    fontWeight: "700",
    fontSize: 15,
  },
  stubNote: {
    color: colors.textDim,
    fontSize: 12,
    fontStyle: "italic",
  },
  postButton: {
    backgroundColor: colors.accent,
    borderRadius: 999,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  post: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  postHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  poster: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700",
    flex: 1,
  },
  postDate: {
    color: colors.textDim,
    fontSize: 12,
  },
  caption: {
    color: colors.text,
    fontSize: 14,
    marginTop: spacing.sm,
    lineHeight: 20,
  },
  media: {
    width: "100%",
    height: 220,
    borderRadius: 10,
    marginTop: spacing.sm,
    backgroundColor: colors.surfaceAlt,
  },
  mediaMissing: {
    width: "100%",
    height: 120,
    borderRadius: 10,
    marginTop: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  mediaMissingText: {
    color: colors.textDim,
    fontSize: 13,
    fontStyle: "italic",
  },
  videoBox: {
    width: "100%",
    borderRadius: 10,
    marginTop: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.lg,
    gap: 4,
  },
  videoGlyph: {
    color: colors.primary,
    fontSize: 28,
  },
  videoMeta: {
    color: colors.textDim,
    fontSize: 12,
  },
  postFoot: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.sm,
  },
  eventLine: {
    color: colors.textDim,
    fontSize: 12,
    flex: 1,
    marginRight: spacing.sm,
  },
  report: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: "600",
  },
  reported: {
    color: colors.success,
    fontSize: 12,
    fontWeight: "700",
  },
  more: {
    marginTop: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
  },
  moreText: {
    color: colors.primary,
    fontWeight: "700",
    fontSize: 14,
  },
});
