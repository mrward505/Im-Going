/**
 * Announce flow (spec §3.3 + §2b) as a modal sheet:
 *   1. Search seeded venues (api.venues) → pick one, or "Create custom spot"
 *      (name, address, lat/lon pin input, category — house/frat/backyard
 *      first-class; masked-address rule is display-only here).
 *   2. Start-time picker (quick chips defaulting to Tonight 21:00, plus a
 *      custom datetime input; 14-day cap + 30-min floor enforced server-side
 *      and pre-checked client-side) + optional 140-char note.
 *   3. Publish → POST /api/v1/events → success state (snapped-to-existing
 *      noted when the server merges into a shared event).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { api, ApiError } from "../api/client";
import { shareSpot, shareErrorCopy } from "../api/shareCard";
import type { EventView, Spot, Venue } from "../api/types";
import { colors, spacing } from "../theme";
import { CategoryPill } from "../components/hero";

type Step = "pick" | "custom" | "time";
type StartPreset = "tonight" | "tomorrow" | "custom";

const CUSTOM_CATEGORIES = ["house", "bar", "club", "concert", "restaurant", "other"] as const;

const MAX_DAYS_AHEAD = 14;
const MIN_START_DELTA_MS = 30 * 60_000;

function defaultTonight(): Date {
  const d = new Date();
  d.setHours(21, 0, 0, 0);
  if (d.getTime() < Date.now() + MIN_START_DELTA_MS) d.setDate(d.getDate() + 1);
  return d;
}

function validateStart(d: Date): string | null {
  const now = Date.now();
  if (d.getTime() < now + MIN_START_DELTA_MS) return "Start must be at least 30 minutes out.";
  if (d.getTime() > now + MAX_DAYS_AHEAD * 86_400_000) return "Start must be within 14 days.";
  return null;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  onPublished: (event: EventView) => void;
}

export function AnnounceSheet({ visible, onClose, onPublished }: Props): React.JSX.Element {
  const [step, setStep] = useState<Step>("pick");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Venue[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [spot, setSpot] = useState<{ id: string; name: string } | null>(null);

  // custom-spot form
  const [cName, setCName] = useState("");
  const [cAddress, setCAddress] = useState("");
  const [cLat, setCLat] = useState("");
  const [cLon, setCLon] = useState("");
  const [cCategory, setCCategory] = useState<string>("house");
  const [creating, setCreating] = useState(false);

  // time + note
  const [preset, setPreset] = useState<StartPreset>("tonight");
  const [customText, setCustomText] = useState("");
  const [note, setNote] = useState("");
  const [publishing, setPublishing] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ event: EventView; snapped: boolean } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareMsg, setShareMsg] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = useCallback(() => {
    setStep("pick");
    setQuery("");
    setResults(null);
    setSpot(null);
    setCName("");
    setCAddress("");
    setCLat("");
    setCLon("");
    setCCategory("house");
    setPreset("tonight");
    setCustomText("");
    setNote("");
    setError(null);
    setDone(null);
    setSharing(false);
    setShareMsg(null);
  }, []);

  useEffect(() => {
    if (visible) reset();
  }, [visible, reset]);

  const search = useCallback(async (q: string) => {
    setSearching(true);
    setSearchError(null);
    try {
      const res = await api.venues({ q: q.trim() || undefined, limit: 15 });
      setResults(res.venues);
    } catch (e) {
      setSearchError(e instanceof ApiError ? e.message : "Search failed. Is the API running?");
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  // initial list + debounced search
  useEffect(() => {
    if (!visible || step !== "pick") return;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void search(query), query.trim() ? 300 : 0);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [visible, step, query, search]);

  const startDate: Date | null = useMemo(() => {
    if (preset === "tonight") return defaultTonight();
    if (preset === "tomorrow") {
      const d = defaultTonight();
      d.setDate(d.getDate() + 1);
      return d;
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(customText.trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
    return Number.isNaN(d.getTime()) ? null : d;
  }, [preset, customText]);

  async function createCustomSpot(): Promise<void> {
    setError(null);
    const lat = Number(cLat);
    const lon = Number(cLon);
    if (!cName.trim()) {
      setError("Give the spot a name.");
      return;
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      setError("Enter a valid pin: latitude −90…90, longitude −180…180.");
      return;
    }
    setCreating(true);
    try {
      const res = await api.createSpot({
        name: cName.trim(),
        address: cAddress.trim() || undefined,
        lat,
        lon,
        category: cCategory,
      });
      const created: Spot = res.spot;
      setSpot({ id: created.id, name: created.name });
      setStep("time");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not create the spot.");
    } finally {
      setCreating(false);
    }
  }

  async function publish(): Promise<void> {
    setError(null);
    if (!spot) {
      setError("Pick a spot first.");
      return;
    }
    if (!startDate) {
      setError("Enter a valid start (YYYY-MM-DD HH:MM).");
      return;
    }
    const problem = validateStart(startDate);
    if (problem) {
      setError(problem);
      return;
    }
    if (note.length > 140) {
      setError("Note must be 140 characters or fewer.");
      return;
    }
    setPublishing(true);
    try {
      const res = await api.announceEvent({
        spot_id: spot.id,
        start_at: startDate.toISOString(),
        note: note.trim() || undefined,
      });
      setDone({ event: res.event, snapped: res.snapped_to_existing });
      onPublished(res.event);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not publish. Try again.");
    } finally {
      setPublishing(false);
    }
  }

  async function shareTheAnnouncement(): Promise<void> {
    if (!done || sharing) return;
    setSharing(true);
    setShareMsg(null);
    try {
      const res = await shareSpot(done.event.spot.id, {
        eventId: done.event.id,
        record: true,
      });
      if (res.status === "shared") {
        setShareMsg(
          res.remaining === 0
            ? "Shared — today's 10/day budget is used up."
            : `Shared 🎉 ${res.remaining} of 10 left today.`,
        );
      }
      // dismissed / copied → no message needed
    } catch (e) {
      setShareMsg(`Share failed: ${shareErrorCopy(e)}`);
    } finally {
      setSharing(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.head}>
          <Text style={styles.title}>{done ? "You're going 🎉" : "I'm going…"}</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.close}>✕</Text>
          </Pressable>
        </View>

        {done ? (
          <View style={styles.done}>
            <Text style={styles.doneSpot}>{done.event.spot.name}</Text>
            <Text style={styles.doneTime}>
              {new Date(done.event.start_at).toLocaleString([], {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </Text>
            {done.snapped ? (
              <Text style={styles.doneNote}>Joined the existing event at this spot — the more the merrier.</Text>
            ) : (
              <Text style={styles.doneNote}>New event created — friends can now tap “I&apos;m going”.</Text>
            )}
            <Pressable onPress={onClose} style={styles.primary}>
              <Text style={styles.primaryText}>Done</Text>
            </Pressable>
            <Pressable onPress={() => void shareTheAnnouncement()} disabled={sharing} style={styles.sharePrimary}>
              {sharing ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryText}>Share — I'm going</Text>
              )}
            </Pressable>
            {shareMsg ? <Text style={styles.doneNote}>{shareMsg}</Text> : null}
          </View>
        ) : step === "pick" ? (
          <>
            <TextInput
              style={styles.search}
              placeholder="Search bars, clubs, venues…"
              placeholderTextColor={colors.textDim}
              value={query}
              onChangeText={setQuery}
              autoCapitalize="none"
              returnKeyType="search"
            />
            {searchError ? <Text style={styles.error}>{searchError}</Text> : null}
            <ScrollView style={styles.results} keyboardShouldPersistTaps="handled">
              {searching && results === null ? (
                <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.lg }} />
              ) : (
                (results ?? []).map((v) => (
                  <Pressable
                    key={v.id}
                    onPress={() => {
                      setSpot({ id: v.id, name: v.name });
                      setStep("time");
                    }}
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                  >
                    <View style={styles.rowHead}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {v.name}
                      </Text>
                      <CategoryPill category={v.category} />
                    </View>
                    {v.address ? (
                      <Text style={styles.rowAddr} numberOfLines={1}>
                        {v.address}
                      </Text>
                    ) : null}
                  </Pressable>
                ))
              )}
              {results !== null && results.length === 0 && !searching ? (
                <Text style={styles.empty}>No venues match — create a custom spot below.</Text>
              ) : null}
            </ScrollView>
            <Pressable onPress={() => setStep("custom")} style={styles.secondary}>
              <Text style={styles.secondaryText}>＋ Create custom spot (house / frat / backyard)</Text>
            </Pressable>
          </>
        ) : step === "custom" ? (
          <ScrollView style={styles.form} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>Spot name</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Jake's backyard bash"
              placeholderTextColor={colors.textDim}
              value={cName}
              onChangeText={setCName}
            />
            <Text style={styles.label}>Address (optional — stays masked until friends confirm)</Text>
            <TextInput
              style={styles.input}
              placeholder="Street address"
              placeholderTextColor={colors.textDim}
              value={cAddress}
              onChangeText={setCAddress}
            />
            <Text style={styles.label}>Pin (latitude / longitude)</Text>
            <View style={styles.latlon}>
              <TextInput
                style={[styles.input, styles.latlonInput]}
                placeholder="33.42"
                placeholderTextColor={colors.textDim}
                value={cLat}
                onChangeText={setCLat}
                keyboardType="numbers-and-punctuation"
              />
              <TextInput
                style={[styles.input, styles.latlonInput]}
                placeholder="-111.93"
                placeholderTextColor={colors.textDim}
                value={cLon}
                onChangeText={setCLon}
                keyboardType="numbers-and-punctuation"
              />
            </View>
            <Text style={styles.label}>Category</Text>
            <View style={styles.chips}>
              {CUSTOM_CATEGORIES.map((c) => (
                <Pressable
                  key={c}
                  onPress={() => setCCategory(c)}
                  style={[styles.chip, cCategory === c && styles.chipActive]}
                >
                  <Text style={[styles.chipText, cCategory === c && styles.chipTextActive]}>{c}</Text>
                </Pressable>
              ))}
            </View>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Pressable onPress={() => void createCustomSpot()} style={styles.primary} disabled={creating}>
              {creating ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Create spot</Text>}
            </Pressable>
            <Pressable onPress={() => setStep("pick")} style={styles.ghost}>
              <Text style={styles.ghostText}>← Back to search</Text>
            </Pressable>
          </ScrollView>
        ) : (
          <ScrollView style={styles.form} keyboardShouldPersistTaps="handled">
            <Text style={styles.spotName}>{spot?.name}</Text>
            <Text style={styles.label}>Start time</Text>
            <View style={styles.chips}>
              {(["tonight", "tomorrow", "custom"] as StartPreset[]).map((p) => (
                <Pressable
                  key={p}
                  onPress={() => setPreset(p)}
                  style={[styles.chip, preset === p && styles.chipActive]}
                >
                  <Text style={[styles.chipText, preset === p && styles.chipTextActive]}>
                    {p === "tonight"
                      ? `Tonight ${defaultTonight().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                      : p === "tomorrow"
                        ? "Tomorrow night"
                        : "Custom…"}
                  </Text>
                </Pressable>
              ))}
            </View>
            {preset === "custom" ? (
              <TextInput
                style={styles.input}
                placeholder="YYYY-MM-DD HH:MM"
                placeholderTextColor={colors.textDim}
                value={customText}
                onChangeText={setCustomText}
              />
            ) : null}
            {startDate ? (
              <Text style={styles.startPreview}>
                {startDate.toLocaleString([], {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </Text>
            ) : null}
            <Text style={styles.label}>Note (optional, 140 chars)</Text>
            <TextInput
              style={styles.input}
              placeholder="meeting at the bar"
              placeholderTextColor={colors.textDim}
              value={note}
              onChangeText={setNote}
              maxLength={140}
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Pressable onPress={() => void publish()} style={styles.primary} disabled={publishing}>
              {publishing ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Publish — I&apos;m going</Text>}
            </Pressable>
            <Pressable onPress={() => setStep("pick")} style={styles.ghost}>
              <Text style={styles.ghostText}>← Change spot</Text>
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
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: "center",
    marginBottom: spacing.sm,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: "800",
  },
  close: {
    color: colors.textDim,
    fontSize: 20,
    padding: spacing.sm,
  },
  search: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 16,
  },
  results: {
    flex: 1,
    marginTop: spacing.sm,
  },
  row: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: 10,
    marginBottom: 2,
  },
  rowPressed: {
    backgroundColor: colors.surface,
  },
  rowHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  rowName: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
    flex: 1,
  },
  rowAddr: {
    color: colors.textDim,
    fontSize: 12,
    marginTop: 2,
  },
  empty: {
    color: colors.textDim,
    fontSize: 14,
    marginTop: spacing.lg,
    textAlign: "center",
  },
  error: {
    color: colors.danger,
    fontSize: 13,
    marginTop: spacing.sm,
  },
  secondary: {
    marginVertical: spacing.md,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: "center",
  },
  secondaryText: {
    color: colors.primary,
    fontWeight: "700",
    fontSize: 15,
  },
  form: {
    flex: 1,
  },
  spotName: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "700",
    marginBottom: spacing.sm,
  },
  label: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: "600",
    marginTop: spacing.md,
    marginBottom: 6,
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    color: colors.text,
    fontSize: 16,
  },
  latlon: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  latlonInput: {
    flex: 1,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryDim,
  },
  chipText: {
    color: colors.textDim,
    fontWeight: "600",
  },
  chipTextActive: {
    color: "#fff",
  },
  startPreview: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "600",
    marginTop: spacing.sm,
  },
  primary: {
    marginTop: spacing.lg,
    paddingVertical: 15,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: "center",
  },
  primaryText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 16,
  },
  sharePrimary: {
    marginTop: spacing.sm,
    paddingVertical: 15,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: "center",
    minWidth: 200,
  },
  ghost: {
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
    paddingVertical: 12,
    alignItems: "center",
  },
  ghostText: {
    color: colors.textDim,
    fontWeight: "600",
  },
  done: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
  },
  doneSpot: {
    color: colors.text,
    fontSize: 22,
    fontWeight: "800",
    textAlign: "center",
  },
  doneTime: {
    color: colors.primary,
    fontSize: 16,
    fontWeight: "700",
    marginTop: spacing.sm,
  },
  doneNote: {
    color: colors.textDim,
    fontSize: 14,
    marginTop: spacing.sm,
    textAlign: "center",
    lineHeight: 20,
  },
});
