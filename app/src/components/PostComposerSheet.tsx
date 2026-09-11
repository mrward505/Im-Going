/**
 * Post composer sheet (slice 4d-2, spec §2f): reachable only with a verified
 * check-in for the event (the Spot Detail gates on `my_checked_in`). Take a
 * photo or short clip with the camera, or pick from the library
 * (expo-image-picker), add a ≤140-char caption, then upload via the storage
 * contract (requestUploadUrl → PUT bytes with XHR upload progress →
 * createPost(object_key)).
 *
 * Guards: image ≤ 10 MB / video ≤ 25 MB before upload (picker quality 0.8 is
 * the client-side compression); staged upload progress + error states; 409
 * (already posted from this check-in) and 403 (no check-in) surfaced as
 * friendly lines.
 */
import React, { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { api, ApiError } from "../api/client";
import type { Post, PostMediaType } from "../api/types";
import { colors, spacing } from "../theme";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
export const MAX_CAPTION = 140;

const CONTENT_TYPE_BY_EXT: Record<string, "image/jpeg" | "image/png" | "image/heic" | "video/mp4" | "video/quicktime"> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

function extOf(name: string | null | undefined, fallback: string): string {
  const m = (name ?? "").toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  return m?.[1] ?? fallback;
}

// REVAMP 3: exported so the "Bring your nights" import flow reuses the same
// honest media contract (requestUploadUrl → PUT bytes → object_key). Third
// parties' post content is never fetched — this uploads media the user owns.
export { CONTENT_TYPE_BY_EXT, extOf };

interface Picked {
  uri: string;
  kind: PostMediaType;
  fileName: string;
  width: number;
  height: number;
  duration_s?: number;
}

/** Normalize an ImagePicker result into our Picked shape (asset decides type). */
function toPicked(res: ImagePicker.ImagePickerResult): Picked | null {
  if (res.canceled || res.assets.length === 0) return null;
  const a = res.assets[0]!;
  const type: PostMediaType = a.type === "video" ? "video" : "image";
  return {
    uri: a.uri,
    kind: type,
    fileName: a.fileName ?? (type === "video" ? "clip.mp4" : "photo.jpg"),
    width: a.width,
    height: a.height,
    duration_s: type === "video" && a.duration != null ? Math.round(a.duration / 1000) : undefined,
  };
}

/** Camera shot (photo or ≤60 s clip) via expo-image-picker. */
async function takeShot(kind: PostMediaType): Promise<Picked | null> {
  const res = await ImagePicker.launchCameraAsync({
    mediaTypes: kind === "image" ? ["images"] : ["videos"],
    allowsMultipleSelection: false,
    quality: 0.8,
    videoMaxDuration: 60,
  });
  return toPicked(res);
}

/** Library pick; `kind` null lets the asset type decide (images + videos). */
async function pickFromLibrary(kind: PostMediaType | null): Promise<Picked | null> {
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: kind === "image" ? ["images"] : kind === "video" ? ["videos"] : ["images", "videos"],
    allowsMultipleSelection: false,
    quality: 0.8,
  });
  return toPicked(res);
}

/** Fetch local uri → bytes (works with file://, content://, and web blob:). */
export async function readBytes(uri: string): Promise<ArrayBuffer> {
  const res = await fetch(uri);
  if (!res.ok) throw new ApiError(0, "read_failed", "Could not read the selected media.");
  return res.arrayBuffer();
}

/**
 * PUT the media bytes with real upload progress via XHR (fetch has no upload
 * progress in RN). RN and web both accept ArrayBuffer bodies.
 */
export function uploadWithProgress(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: ArrayBuffer,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    const up = xhr.upload;
    if (up) {
      up.addEventListener("progress", (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      });
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new ApiError(xhr.status, "upload_failed", `Upload failed (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new ApiError(0, "upload_failed", "Upload failed — check your connection."));
    xhr.send(body);
  });
}

type Phase =
  | { name: "idle" }
  | { name: "uploading"; label: string; fraction?: number }
  | { name: "error"; message: string };

interface Props {
  visible: boolean;
  eventId: string;
  onClose: () => void;
  onPosted: (post: Post) => void;
}

export function PostComposerSheet({ visible, eventId, onClose, onPosted }: Props): React.JSX.Element {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [caption, setCaption] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "idle" });

  function reset(): void {
    setPicked(null);
    setCaption("");
    setPhase({ name: "idle" });
  }

  function close(): void {
    reset();
    onClose();
  }

  async function chooseCamera(kind: PostMediaType): Promise<void> {
    setPhase({ name: "idle" });
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        setPhase({ name: "error", message: "Camera permission is needed to take a photo or clip." });
        return;
      }
      const p = await takeShot(kind);
      if (p) setPicked(p);
    } catch {
      setPhase({ name: "error", message: "Could not open the camera." });
    }
  }

  async function chooseLibrary(kind: PostMediaType | null = null): Promise<void> {
    setPhase({ name: "idle" });
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        setPhase({ name: "error", message: "Photo library permission is needed to pick media." });
        return;
      }
      const p = await pickFromLibrary(kind);
      if (p) setPicked(p);
    } catch {
      setPhase({ name: "error", message: "Could not open the media library." });
    }
  }

  async function publish(): Promise<void> {
    if (!picked || phase.name === "uploading") return;
    const text = caption.trim().slice(0, MAX_CAPTION);
    try {
      setPhase({ name: "uploading", label: "Reading media…" });
      const body = await readBytes(picked.uri);
      const limit = picked.kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
      if (body.byteLength > limit) {
        const mb = Math.round(limit / (1024 * 1024));
        setPhase({
          name: "error",
          message: `${picked.kind === "image" ? "Photo" : "Video"} is too large — keep it under ${mb} MB.`,
        });
        return;
      }
      const ext = extOf(picked.fileName, picked.kind === "image" ? "jpg" : "mp4");
      const contentType = CONTENT_TYPE_BY_EXT[ext] ?? (picked.kind === "image" ? "image/jpeg" : "video/mp4");
      const slot = await api.requestUploadUrl({ content_type: contentType, ext, kind: "post" });
      setPhase({ name: "uploading", label: "Uploading…" });
      let lastPct = -1;
      await uploadWithProgress(
        slot.upload.upload_url,
        slot.upload.method,
        slot.upload.headers,
        body,
        (frac) => {
          const pct = Math.floor(frac * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            setPhase((cur) =>
              cur.name === "uploading"
                ? { name: "uploading", label: "Uploading…", fraction: frac }
                : cur,
            );
          }
        },
      );
      setPhase({ name: "uploading", label: "Posting…" });
      const created = await api.createPost(eventId, {
        type: picked.kind,
        caption: text || undefined,
        object_key: slot.upload.object_key,
        width: picked.width || undefined,
        height: picked.height || undefined,
        duration_s: picked.duration_s,
      });
      reset();
      onPosted(created.post);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setPhase({ name: "error", message: "You already posted from this check-in." });
      } else if (e instanceof ApiError && e.status === 403) {
        setPhase({ name: "error", message: "Check in at this event before posting." });
      } else {
        setPhase({ name: "error", message: e instanceof ApiError ? e.message : "Publish failed. Try again." });
      }
    }
  }

  const busy = phase.name === "uploading";
  const pct = phase.name === "uploading" && phase.fraction != null ? Math.floor(phase.fraction * 100) : null;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <View style={styles.head}>
          <Text style={styles.title}>Post to this event</Text>
          <Pressable onPress={close} hitSlop={12} disabled={busy}>
            <Text style={styles.close}>✕</Text>
          </Pressable>
        </View>
        {picked ? (
          <>
            {picked.kind === "image" ? (
              <Image source={{ uri: picked.uri }} style={styles.preview} resizeMode="cover" />
            ) : (
              <View style={styles.videoBadge}>
                <Text style={styles.videoBadgeText}>🎬 {picked.fileName}</Text>
                {picked.duration_s ? <Text style={styles.videoSub}>{picked.duration_s}s clip</Text> : null}
              </View>
            )}
            <Pressable onPress={() => void chooseLibrary(picked.kind)} disabled={busy} style={styles.reselect}>
              <Text style={styles.reselectText}>Choose a different {picked.kind} from library</Text>
            </Pressable>
          </>
        ) : (
          <>
            <View style={styles.pickRow}>
              <Pressable onPress={() => void chooseCamera("image")} disabled={busy} style={styles.pick}>
                <Text style={styles.pickIcon}>📷</Text>
                <Text style={styles.pickText}>Photo</Text>
              </Pressable>
              <Pressable onPress={() => void chooseCamera("video")} disabled={busy} style={styles.pick}>
                <Text style={styles.pickIcon}>🎬</Text>
                <Text style={styles.pickText}>Video</Text>
              </Pressable>
              <Pressable onPress={() => void chooseLibrary(null)} disabled={busy} style={styles.pick}>
                <Text style={styles.pickIcon}>🖼️</Text>
                <Text style={styles.pickText}>Library</Text>
              </Pressable>
            </View>
            <Text style={styles.sourceHint}>Photo or short clip from your camera, or anything from your library.</Text>
          </>
        )}
        <TextInput
          style={styles.caption}
          placeholder="Add a caption (140 chars)…"
          placeholderTextColor={colors.textDim}
          value={caption}
          onChangeText={(t) => setCaption(t.slice(0, MAX_CAPTION))}
          maxLength={MAX_CAPTION}
          multiline
          editable={!busy}
        />
        <Text style={styles.count}>
          {caption.length}/{MAX_CAPTION}
        </Text>
        {phase.name === "error" ? <Text style={styles.error}>{phase.message}</Text> : null}
        {phase.name === "uploading" ? (
          <View style={styles.busyRow}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.busyText}>
              {phase.label}
              {pct != null ? ` ${pct}%` : ""}
            </Text>
          </View>
        ) : null}
        {phase.name === "uploading" && phase.fraction != null ? (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.max(2, pct ?? 0)}%` }]} />
          </View>
        ) : null}
        <Pressable
          onPress={() => void publish()}
          disabled={!picked || busy}
          style={({ pressed }) => [
            styles.publish,
            (!picked || busy) && styles.publishDisabled,
            pressed && picked && !busy && styles.publishPressed,
          ]}
        >
          <Text style={styles.publishText}>{Platform.OS === "web" ? "Post" : "Post 📸"}</Text>
        </Pressable>
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
    marginBottom: spacing.md,
  },
  title: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "800",
  },
  close: {
    color: colors.textDim,
    fontSize: 18,
    fontWeight: "700",
  },
  pickRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  pick: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.lg,
    alignItems: "center",
    gap: spacing.sm,
  },
  pickIcon: {
    fontSize: 28,
  },
  pickText: {
    color: colors.text,
    fontWeight: "700",
  },
  sourceHint: {
    color: colors.textDim,
    fontSize: 12,
    marginBottom: spacing.md,
  },
  preview: {
    width: "100%",
    height: 240,
    borderRadius: 12,
    backgroundColor: colors.surfaceAlt,
    marginBottom: spacing.sm,
  },
  videoBadge: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  videoBadgeText: {
    color: colors.text,
    fontWeight: "700",
  },
  videoSub: {
    color: colors.textDim,
    fontSize: 12,
    marginTop: 4,
  },
  reselect: {
    alignSelf: "flex-start",
    marginBottom: spacing.md,
  },
  reselectText: {
    color: colors.primary,
    fontWeight: "700",
    fontSize: 13,
  },
  caption: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 15,
    padding: spacing.md,
    minHeight: 72,
    textAlignVertical: "top",
  },
  count: {
    color: colors.textDim,
    fontSize: 12,
    textAlign: "right",
    marginTop: 4,
  },
  error: {
    color: colors.danger,
    fontSize: 14,
    marginTop: spacing.sm,
  },
  busyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  busyText: {
    color: colors.textDim,
    fontSize: 14,
  },
  progressTrack: {
    marginTop: spacing.sm,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.surfaceAlt,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  publish: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  publishDisabled: {
    opacity: 0.4,
  },
  publishPressed: {
    opacity: 0.85,
  },
  publishText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 16,
  },
});