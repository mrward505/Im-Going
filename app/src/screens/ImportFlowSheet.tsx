/**
 * "Bring your nights" import flow (REVAMP 3, owner 2026-09-09) as a modal sheet.
 *
 * Step 1 — platform + paste the PUBLIC post URL. Honest note is mandatory UI:
 * we store the link as proof; we never fetch content from IG/X/TikTok; a
 * visual comes from media the user owns (a photo they upload via the media
 * contract, or a URL they host). Nothing is ever fabricated.
 * Step 2 — pick the ONE spot this post belongs to via the universal metro
 * search (GET /api/v1/venues/search — same real API the Search tab uses).
 * Step 3 — optional ≤140 caption + optional media (photo upload via
 * requestUploadUrl → PUT → object_key XOR a pasted media_url) + the been-there
 * gate: submit WITHOUT been_there first so the API auto-uses a REAL verified
 * check-in when one exists; only when the API rejects (400 no-checkin) does
 * the flow require the explicit "I've been here" claim checkbox (with optional
 * ≤140 corroboration). The claim is an explicit user action with clear copy —
 * never auto-asserted.
 *
 * Errors mapped: 409 (cap/duplicate) and 400 (no check-in) → clear lines.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { api, ApiError } from "../api/client";
import type { CreateImportInput, ImportPlatform, ImportedPost, VenueSearchRow } from "../api/types";
import { colors, spacing } from "../theme";
import { CategoryPill } from "../components/hero";
import { MAX_IMAGE_BYTES, readBytes, uploadWithProgress, CONTENT_TYPE_BY_EXT, extOf } from "../components/PostComposerSheet";

export const MAX_IMPORT_CAPTION = 140;
export const MAX_CLAIM = 140;

const PLATFORMS: { key: ImportPlatform; label: string; glyph: string }[] = [
  { key: "instagram", label: "Instagram", glyph: "📸" },
  { key: "x", label: "X (Twitter)", glyph: "𝕏" },
  { key: "tiktok", label: "TikTok", glyph: "🎵" },
  { key: "other", label: "Other", glyph: "🔗" },
];

const HONEST_NOTE =
  "We store the link as proof — we never fetch content from Instagram, X or TikTok. " +
  "Add your own photo (a screenshot you own) if you want a visual.";
const CLAIM_NOTE = "I've been here — this claim is shown until verified.";

interface PickedImage {
  uri: string;
  fileName: string;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called with the created import so the profile can refresh. */
  onImported: (imported: ImportedPost) => void;
}

type Step = "post" | "spot" | "details";
type MediaMode = "none" | "upload" | "url";
type Phase = { name: "idle" } | { name: "submitting"; label: string } | { name: "error"; message: string };

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function ImportFlowSheet({ visible, onClose, onImported }: Props): React.JSX.Element {
  const [step, setStep] = useState<Step>("post");
  const [platform, setPlatform] = useState<ImportPlatform | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);

  const [spotQuery, setSpotQuery] = useState("");
  const [spotRows, setSpotRows] = useState<VenueSearchRow[] | null>(null);
  const [spotLoading, setSpotLoading] = useState(false);
  const [spotError, setSpotError] = useState<string | null>(null);
  const [selectedSpot, setSelectedSpot] = useState<VenueSearchRow | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [caption, setCaption] = useState("");
  const [mediaMode, setMediaMode] = useState<MediaMode>("none");
  const [picked, setPicked] = useState<PickedImage | null>(null);
  const [mediaUrlText, setMediaUrlText] = useState("");
  const [claimChecked, setClaimChecked] = useState(false);
  const [claimText, setClaimText] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "idle" });

  // --- spot search (same real API as the Search tab) --------------------------
  const runSpotSearch = useCallback(async (q: string) => {
    setSpotLoading(true);
    setSpotError(null);
    try {
      const res = await api.venuesSearch({ q: q.trim() || undefined, sort: "name", limit: 20 });
      setSpotRows(res.venues);
    } catch (e) {
      setSpotRows([]);
      setSpotError(e instanceof ApiError ? e.message : "Search failed. Is the API up?");
    } finally {
      setSpotLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void runSpotSearch(spotQuery), spotQuery.trim() ? 300 : 0);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [spotQuery, runSpotSearch]);

  // --- close/reset ------------------------------------------------------------
  function reset(): void {
    setStep("post");
    setPlatform(null);
    setSourceUrl("");
    setUrlError(null);
    setSpotQuery("");
    setSpotRows(null);
    setSpotError(null);
    setSelectedSpot(null);
    setCaption("");
    setMediaMode("none");
    setPicked(null);
    setMediaUrlText("");
    setClaimChecked(false);
    setClaimText("");
    setPhase({ name: "idle" });
  }

  function close(): void {
    reset();
    onClose();
  }

  function goNextFromPost(): void {
    const url = sourceUrl.trim();
    if (!platform) {
      setUrlError("Pick the platform your post is on.");
      return;
    }
    if (!isHttpUrl(url)) {
      setUrlError("That doesn't look like a public post URL — paste the full https:// link.");
      return;
    }
    setUrlError(null);
    setStep("spot");
    setSpotQuery("");
    void runSpotSearch("");
  }

  function pickSpot(r: VenueSearchRow): void {
    setSelectedSpot(r);
    setStep("details");
  }

  // --- media: upload a photo the user owns (honest contract) ------------------
  async function choosePhoto(): Promise<void> {
    setPhase({ name: "idle" });
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setPhase({ name: "error", message: "Photo library permission is needed to add a visual." });
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: false,
        quality: 0.8,
      });
      if (res.canceled || res.assets.length === 0) return;
      const a = res.assets[0]!;
      setPicked({ uri: a.uri, fileName: a.fileName ?? "photo.jpg" });
      setMediaMode("upload");
      setMediaUrlText("");
    } catch {
      setPhase({ name: "error", message: "Could not open the photo library." });
    }
  }

  // --- submit ----------------------------------------------------------------
  async function submit(): Promise<void> {
    if (!platform || !selectedSpot || phase.name === "submitting") return;
    // Media XOR rule (mirrors the API): upload OR pasted URL, never both.
    if (mediaMode === "url" && mediaUrlText.trim() && !isHttpUrl(mediaUrlText.trim())) {
      setPhase({ name: "error", message: "That media URL doesn't look valid — paste the full https:// link." });
      return;
    }
    const payload: CreateImportInput = {
      platform,
      source_url: sourceUrl.trim(),
      spot_id: selectedSpot.id,
    };
    if (caption.trim()) payload.caption = caption.trim().slice(0, MAX_IMPORT_CAPTION);
    if (claimChecked) {
      // Explicit claim — the API never asserts a check-in for us.
      payload.been_there = "claim";
      if (claimText.trim()) payload.claim = claimText.trim().slice(0, MAX_CLAIM);
    }
    // (been_there omitted → the API auto-uses a real verified check-in if one exists)
    try {
      // Optional media first, if the user chose a photo to upload.
      if (mediaMode === "upload" && picked) {
        setPhase({ name: "submitting", label: "Uploading your photo…" });
        const body = await readBytes(picked.uri);
        if (body.byteLength > MAX_IMAGE_BYTES) {
          setPhase({
            name: "error",
            message: "That photo is too large — keep it under 10 MB.",
          });
          return;
        }
        const ext = extOf(picked.fileName, "jpg");
        const contentType = CONTENT_TYPE_BY_EXT[ext] ?? "image/jpeg";
        const slot = await api.requestUploadUrl({ content_type: contentType, ext, kind: "post" });
        await uploadWithProgress(slot.upload.upload_url, slot.upload.method, slot.upload.headers, body, () => {});
        payload.object_key = slot.upload.object_key;
      } else if (mediaMode === "url" && mediaUrlText.trim()) {
        payload.media_url = mediaUrlText.trim();
      }
      setPhase({ name: "submitting", label: "Importing your night…" });
      const res = await api.createImport(payload);
      setPhase({ name: "idle" });
      const imported = res.imported;
      reset();
      onImported(imported);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Cap (3 max) and duplicate share the same status; the server message
        // tells them apart ("import limit reached" vs "already imported").
        setPhase({
          name: "error",
          message: e.message.toLowerCase().includes("limit")
            ? "You've filled your 3 nights — remove one before adding another."
            : "That post is already on your profile.",
        });
      } else if (e instanceof ApiError && e.status === 400 && e.message.toLowerCase().includes("check-in")) {
        // Auto-check-in path failed → the explicit claim is now REQUIRED.
        setPhase({
          name: "error",
          message:
            "You don't have a verified check-in at that spot — tick “I've been here” below to claim it (shown until verified).",
        });
        setStep("details");
      } else {
        setPhase({
          name: "error",
          message: e instanceof ApiError ? e.message : "Import failed. Try again.",
        });
      }
    }
  }

  function back(): void {
    if (step === "spot") setStep("post");
    else if (step === "details") setStep("spot");
  }

  const busy = phase.name === "submitting";
  const platformLabel = PLATFORMS.find((p) => p.key === platform)?.label ?? "Post";
  const spotName = selectedSpot ? selectedSpot.name : null;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.head}>
          <Pressable onPress={back} hitSlop={12} disabled={busy || step === "post"}>
            <Text style={[styles.back, (busy || step === "post") && styles.backDisabled]}>‹ Back</Text>
          </Pressable>
          <Text style={styles.headTitle}>Bring your nights</Text>
          <Pressable onPress={close} hitSlop={12} disabled={busy}>
            <Text style={styles.close}>✕</Text>
          </Pressable>
        </View>
        <View style={styles.steps}>
          {(["post", "spot", "details"] as const).map((s, i) => (
            <View key={s} style={styles.stepDotWrap}>
              <View style={[styles.stepDot, (step === s || (step === "details" && s === "spot") || i === 0) && styles.stepDotActive]} />
              {i < 2 ? <View style={[styles.stepLine, (step === "spot" || step === "details") && i === 0 ? styles.stepLineActive : (step === "details" && i === 1 ? styles.stepLineActive : null)]} /> : null}
            </View>
          ))}
        </View>

        {step === "post" ? (
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={styles.lead}>Import one of your own posts — attached to the spot it belongs to.</Text>
            <Text style={styles.label}>Where is the post?</Text>
            <View style={styles.platformRow}>
              {PLATFORMS.map((p) => (
                <Pressable
                  key={p.key}
                  onPress={() => {
                    setPlatform(p.key);
                    setUrlError(null);
                  }}
                  disabled={busy}
                  style={[styles.platform, platform === p.key && styles.platformActive]}
                >
                  <Text style={styles.platformGlyph}>{p.glyph}</Text>
                  <Text style={[styles.platformText, platform === p.key && styles.platformTextActive]}>{p.label}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.label}>Paste your public post URL</Text>
            <TextInput
              style={styles.input}
              placeholder="https://instagram.com/p/…"
              placeholderTextColor={colors.textDim}
              value={sourceUrl}
              onChangeText={(t) => {
                setSourceUrl(t);
                setUrlError(null);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
            />
            {urlError ? <Text style={styles.error}>{urlError}</Text> : null}
            <View style={styles.note}>
              <Text style={styles.noteText}>{HONEST_NOTE}</Text>
            </View>
            <Pressable onPress={goNextFromPost} disabled={busy} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
              <Text style={styles.primaryText}>Next: pick the spot</Text>
            </Pressable>
          </ScrollView>
        ) : step === "spot" ? (
          <View style={styles.body}>
            <Text style={styles.lead}>Which spot was this night at?</Text>
            <View style={styles.searchBox}>
              <TextInput
                style={styles.input}
                placeholder="Search venues, streets, parties…"
                placeholderTextColor={colors.textDim}
                value={spotQuery}
                onChangeText={setSpotQuery}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                editable={!busy}
              />
            </View>
            {spotLoading && spotRows === null ? (
              <View style={styles.center}>
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : spotError && (spotRows?.length ?? 0) === 0 ? (
              <View style={styles.center}>
                <Text style={styles.error}>{spotError}</Text>
              </View>
            ) : spotRows !== null && spotRows.length === 0 ? (
              <View style={styles.center}>
                <Text style={styles.emptyTitle}>No spot matches that yet</Text>
                <Text style={styles.emptySub}>
                  Try a venue name or street in the metro — or go back and pick a different post.
                </Text>
              </View>
            ) : (
              <FlatList
                data={spotRows ?? []}
                keyExtractor={(r) => r.id}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.spotList}
                renderItem={({ item }) => (
                  <Pressable
                    onPress={() => pickSpot(item)}
                    disabled={busy}
                    style={({ pressed }) => [styles.spotRow, pressed && styles.rowPressed]}
                  >
                    <View style={styles.spotTop}>
                      <Text style={styles.spotName} numberOfLines={1}>{item.name}</Text>
                      <Text style={[styles.spotGoing, item.going_count > 0 && styles.spotGoingHot]}>
                        {item.going_count} going
                      </Text>
                    </View>
                    <View style={styles.spotMeta}>
                      <CategoryPill category={item.category} />
                      <Text style={styles.spotCity} numberOfLines={1}>
                        {item.city}
                        {item.address ? ` · ${item.address}` : ""}
                      </Text>
                    </View>
                  </Pressable>
                )}
              />
            )}
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={styles.lead}>
              Post: <Text style={styles.leadStrong}>{platformLabel}</Text> at{" "}
              <Text style={styles.leadStrong}>{spotName ?? "a spot"}</Text>.
            </Text>
            <Text style={styles.label}>Caption (optional)</Text>
            <TextInput
              style={styles.input}
              placeholder="What kind of night was it? (140 chars)"
              placeholderTextColor={colors.textDim}
              value={caption}
              onChangeText={(t) => setCaption(t.slice(0, MAX_IMPORT_CAPTION))}
              maxLength={MAX_IMPORT_CAPTION}
              multiline
              editable={!busy}
            />
            <Text style={styles.count}>{caption.length}/{MAX_IMPORT_CAPTION}</Text>

            <Text style={styles.label}>Visual (optional — one or the other)</Text>
            <View style={styles.mediaRow}>
              <Pressable
                onPress={() => void choosePhoto()}
                disabled={busy}
                style={[styles.mediaChoice, mediaMode === "upload" && styles.mediaChoiceActive]}
              >
                <Text style={styles.mediaChoiceText}>{picked ? "🖼️ Photo picked" : "📷 Add a photo you own"}</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setMediaMode("url");
                  setPicked(null);
                }}
                disabled={busy}
                style={[styles.mediaChoice, mediaMode === "url" && styles.mediaChoiceActive]}
              >
                <Text style={styles.mediaChoiceText}>🔗 Paste a media URL</Text>
              </Pressable>
              {mediaMode !== "none" ? (
                <Pressable
                  onPress={() => {
                    setMediaMode("none");
                    setPicked(null);
                    setMediaUrlText("");
                  }}
                  disabled={busy}
                >
                  <Text style={styles.mediaClear}>✕ remove</Text>
                </Pressable>
              ) : null}
            </View>
            {mediaMode === "upload" && picked ? (
              <Image source={{ uri: picked.uri }} style={styles.preview} resizeMode="cover" />
            ) : null}
            {mediaMode === "url" ? (
              <TextInput
                style={styles.input}
                placeholder="https://… (media you host)"
                placeholderTextColor={colors.textDim}
                value={mediaUrlText}
                onChangeText={setMediaUrlText}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
              />
            ) : null}
            <Text style={styles.mediaHint}>A screenshot you own is proof of the night — we never fetch the other post's media.</Text>

            <View style={styles.claimBox}>
              <Pressable
                onPress={() => {
                  setClaimChecked((c) => !c);
                  setPhase({ name: "idle" });
                }}
                disabled={busy}
                style={styles.claimCheckRow}
              >
                <View style={[styles.checkbox, claimChecked && styles.checkboxOn]}>
                  {claimChecked ? <Text style={styles.checkboxMark}>✓</Text> : null}
                </View>
                <Text style={styles.claimLabel}>{CLAIM_NOTE}</Text>
              </Pressable>
              {claimChecked ? (
                <TextInput
                  style={styles.input}
                  placeholder="Anything to back it up? (optional, 140 chars)"
                  placeholderTextColor={colors.textDim}
                  value={claimText}
                  onChangeText={(t) => setClaimText(t.slice(0, MAX_CLAIM))}
                  maxLength={MAX_CLAIM}
                  multiline
                  editable={!busy}
                />
              ) : null}
              {claimChecked ? <Text style={styles.count}>{claimText.length}/{MAX_CLAIM}</Text> : null}
              {!claimChecked ? (
                <Text style={styles.claimHint}>
                  If you've checked in here before, we'll attach that automatically. Otherwise tick the box to claim it.
                </Text>
              ) : null}
            </View>

            {phase.name === "error" ? <Text style={styles.error}>{phase.message}</Text> : null}
            {phase.name === "submitting" ? (
              <View style={styles.busyRow}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.busyText}>{phase.label}</Text>
              </View>
            ) : null}
            <Pressable
              onPress={() => void submit()}
              disabled={busy}
              style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
            >
              <Text style={styles.primaryText}>{Platform.OS === "web" ? "Add to profile" : "Add to profile ✨"}</Text>
            </Pressable>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  handle: {
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.border,
    alignSelf: "center",
    marginBottom: spacing.sm,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headTitle: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "800",
  },
  back: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: "700",
    minWidth: 60,
  },
  backDisabled: {
    opacity: 0.35,
  },
  close: {
    color: colors.textDim,
    fontSize: 18,
    fontWeight: "700",
    minWidth: 24,
    textAlign: "right",
  },
  steps: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: spacing.md,
  },
  stepDotWrap: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
  },
  stepDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.border,
  },
  stepDotActive: {
    backgroundColor: colors.primary,
  },
  stepLine: {
    flex: 1,
    height: 2,
    backgroundColor: colors.border,
    marginHorizontal: 6,
  },
  stepLineActive: {
    backgroundColor: colors.primary,
  },
  body: {
    paddingBottom: spacing.xl,
  },
  lead: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: spacing.md,
  },
  leadStrong: {
    color: colors.primary,
    fontWeight: "700",
  },
  label: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: "700",
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  platformRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  platform: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  platformActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryDim,
  },
  platformGlyph: {
    fontSize: 16,
  },
  platformText: {
    color: colors.textDim,
    fontSize: 14,
    fontWeight: "700",
  },
  platformTextActive: {
    color: "#fff",
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 15,
    padding: spacing.md,
    minHeight: 48,
    textAlignVertical: "top",
  },
  note: {
    backgroundColor: "rgba(61, 232, 255, 0.08)",
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  noteText: {
    color: colors.textDim,
    fontSize: 13,
    lineHeight: 19,
  },
  primary: {
    marginTop: spacing.lg,
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 16,
  },
  pressed: {
    opacity: 0.85,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  spotList: {
    paddingBottom: spacing.xl,
    gap: spacing.sm,
  },
  spotRow: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  rowPressed: {
    opacity: 0.75,
  },
  spotTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  spotName: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
    flex: 1,
  },
  spotGoing: {
    fontSize: 13,
    fontWeight: "800",
    color: colors.textDim,
  },
  spotGoingHot: {
    color: colors.accent,
  },
  spotMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  spotCity: {
    color: colors.textDim,
    fontSize: 12,
    flex: 1,
  },
  center: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.xl,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  emptySub: {
    color: colors.textDim,
    fontSize: 13,
    marginTop: spacing.sm,
    textAlign: "center",
    lineHeight: 19,
  },
  count: {
    color: colors.textDim,
    fontSize: 12,
    textAlign: "right",
    marginTop: 4,
  },
  mediaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: spacing.sm,
  },
  mediaChoice: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
  },
  mediaChoiceActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryDim,
  },
  mediaChoiceText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "700",
  },
  mediaClear: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: "700",
  },
  preview: {
    width: "100%",
    height: 180,
    borderRadius: 12,
    backgroundColor: colors.surfaceAlt,
    marginTop: spacing.sm,
  },
  mediaHint: {
    color: colors.textDim,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.sm,
  },
  claimBox: {
    marginTop: spacing.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing.md,
    gap: spacing.sm,
  },
  claimCheckRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: {
    backgroundColor: colors.primary,
  },
  checkboxMark: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "900",
  },
  claimLabel: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "600",
    flex: 1,
    lineHeight: 19,
  },
  claimHint: {
    color: colors.textDim,
    fontSize: 12,
    lineHeight: 17,
  },
  error: {
    color: colors.danger,
    fontSize: 14,
    marginTop: spacing.sm,
    lineHeight: 19,
  },
  busyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  busyText: {
    color: colors.textDim,
    fontSize: 14,
  },
});