/**
 * Profile tab — real user data (GET /me) + star rating + the "your pull"
 * section (Slice 4d-3b): real aggregates from GET /api/v1/me/pull proving the
 * audience-visibility thesis — how many confirmations your announcements drew,
 * and your goers' follow-through. Nullable states render honest empty copy;
 * numbers are never invented.
 */
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { api, ApiError } from "../api/client";
import type { ImportedPost, InfluencerPull, MyPostRow, User } from "../api/types";
import { colors, spacing } from "../theme";
import { Avatar } from "../components/Avatar";
import { CONTENT_TYPE_BY_EXT, extOf, readBytes, uploadWithProgress } from "../components/PostComposerSheet";
import { ImportFlowSheet } from "./ImportFlowSheet";

interface Props {
  onLogout: () => void;
}

const PLATFORM_LABEL: Record<ImportedPost["platform"], string> = {
  instagram: "Instagram",
  x: "X",
  tiktok: "TikTok",
  other: "Other",
};

/** Been-there badge copy — mirrors the trust semantics exactly (nothing auto-asserted). */
function BeenThereBadge({ post }: { post: ImportedPost }): React.JSX.Element {
  if (post.been_there.kind === "checkin" && post.verification === "verified") {
    return (
      <View style={[styles.badge, styles.badgeVerified]}>
        <Text style={[styles.badgeText, styles.badgeTextVerified]}>✓ You've been here</Text>
      </View>
    );
  }
  if (post.been_there.kind === "claim" && post.verification === "verified") {
    return (
      <View style={[styles.badge, styles.badgeVerified]}>
        <Text style={[styles.badgeText, styles.badgeTextVerified]}>✓ Claim verified</Text>
      </View>
    );
  }
  if (post.verification === "rejected") {
    return (
      <View style={[styles.badge, styles.badgeRejected]}>
        <Text style={[styles.badgeText, styles.badgeTextRejected]}>Claim not verified</Text>
      </View>
    );
  }
  return (
    <View style={[styles.badge, styles.badgePending]}>
      <Text style={[styles.badgeText, styles.badgeTextPending]}>Claimed — verifying</Text>
    </View>
  );
}

/**
 * "Bring your nights" (REVAMP 3, owner 2026-09-09): import up to 3 of your own
 * posts from other platforms, each attached to ONE spot you've actually been
 * to. Count/remaining come straight from GET /api/v1/me/imports — the API's
 * own cap — and the list shows only real rows (media thumbnail when present,
 * platform, spot, been-there status). Empty copy is honest, never a fake
 * number.
 */
function ImportSection({
  imports,
  limit,
  loading,
  error,
  onRetry,
  onAdd,
  onDelete,
  deletingId,
}: {
  imports: ImportedPost[];
  limit: number;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
  deletingId: string | null;
}): React.JSX.Element {
  const remaining = Math.max(0, limit - imports.length);
  return (
    <View style={styles.imports}>
      <View style={styles.importsHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.importsKicker}>Bring your nights</Text>
          <Text style={styles.importsSub}>
            {imports.length === 0
              ? "Your nights, in one place — posts from your other platforms, attached to spots you've actually been to."
              : "Posts from your nights — shown with the spot and real been-there proof."}
          </Text>
        </View>
        <View style={styles.importsCount}>
          <Text style={styles.importsCountText}>{imports.length}/{limit}</Text>
        </View>
      </View>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.md }} />
      ) : error ? (
        <View style={styles.importsError}>
          <Text style={styles.error}>{error}</Text>
          <Pressable onPress={onRetry} style={styles.retrySmall}>
            <Text style={styles.retrySmallText}>Retry</Text>
          </Pressable>
        </View>
      ) : imports.length === 0 ? (
        <View style={styles.importsEmpty}>
          <Text style={styles.importsEmptyTitle}>Your nights deserve an audience.</Text>
          <Text style={styles.importsEmptySub}>
            Import a post from Instagram, X or TikTok — or any spot your nights live on — and your
            profile starts telling the story of what you're into. Nobody can see what you haven't shared.
          </Text>
          {remaining > 0 ? (
            <Pressable onPress={onAdd} style={styles.importsAdd}>
              <Text style={styles.importsAddText}>Add your first night</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <>
          {imports.map((post) => (
            <View key={post.id} style={styles.importRow}>
              {post.media_url ? (
                <Image source={{ uri: post.media_url }} style={styles.importThumb} resizeMode="cover" />
              ) : (
                <View style={[styles.importThumb, styles.importThumbEmpty]}>
                  <Text style={styles.importThumbGlyph}>
                    {post.platform === "instagram" ? "📸" : post.platform === "x" ? "𝕏" : post.platform === "tiktok" ? "🎵" : "🔗"}
                  </Text>
                </View>
              )}
              <View style={styles.importBody}>
                <View style={styles.importTop}>
                  <Text style={styles.importSpot} numberOfLines={1}>
                    {post.spot ? post.spot.name : "Spot"}
                  </Text>
                  <Text style={styles.importPlatform}>{PLATFORM_LABEL[post.platform]}</Text>
                </View>
                <View style={styles.importBadges}>
                  <BeenThereBadge post={post} />
                  {post.is_recent ? <Text style={styles.recentTag}>recent</Text> : null}
                </View>
                {post.caption ? (
                  <Text style={styles.importCaption} numberOfLines={1}>{post.caption}</Text>
                ) : null}
              </View>
              <Pressable
                onPress={() => onDelete(post.id)}
                hitSlop={8}
                style={[styles.importDelete, deletingId === post.id && styles.importDeleteArmed]}
              >
                <Text style={[styles.importDeleteText, deletingId === post.id && styles.importDeleteTextArmed]}>
                  {deletingId === post.id ? "Sure?" : "✕"}
                </Text>
              </Pressable>
            </View>
          ))}
          {remaining > 0 ? (
            <Pressable onPress={onAdd} style={styles.importsAdd}>
              <Text style={styles.importsAddText}>+ Add another night ({remaining} left)</Text>
            </Pressable>
          ) : (
            <Text style={styles.importsFull}>3 of 3 — your nights are full. Remove one to add another.</Text>
          )}
        </>
      )}
    </View>
  );
}

const EMPTY_PULL: InfluencerPull = {
  announcements_total: 0,
  confirmations_drawn_total: 0,
  goers_follow_through_pct: null,
  avg_confirmations_per_announcement: null,
};

/**
 * REVAMP 5 — "Your posts": the IG-style grid of photos/videos the viewer
 * posted from a real spot (GET /api/v1/me/posts). Tap a tile to open it full
 * screen with its caption and spot. A profile with no posts shows honest empty
 * copy and points at the check-in → post loop (never a placeholder image).
 */
function PostsGrid({
  posts,
  loading,
  error,
  onRetry,
  onOpen,
}: {
  posts: MyPostRow[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onOpen: (post: MyPostRow) => void;
}): React.JSX.Element {
  return (
    <View style={styles.posts}>
      <View style={styles.postsHead}>
        <Text style={styles.postsKicker}>Your posts</Text>
        <Text style={styles.postsCount}>{posts.length}</Text>
      </View>
      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.md }} />
      ) : error ? (
        <View style={styles.importsError}>
          <Text style={styles.error}>{error}</Text>
          <Pressable onPress={onRetry} style={styles.retrySmall}>
            <Text style={styles.retrySmallText}>Retry</Text>
          </Pressable>
        </View>
      ) : posts.length === 0 ? (
        <Text style={styles.postsEmpty}>
          Nothing posted yet. Check in at a spot when you&apos;re there, then post a photo of your
          night — it shows up here and on the spot.
        </Text>
      ) : (
        <View style={styles.grid}>
          {posts.map((p) => (
            <Pressable key={p.id} onPress={() => onOpen(p)} style={styles.tile}>
              {p.media_url && p.type === "image" ? (
                <Image source={{ uri: p.media_url }} style={styles.tileImage} resizeMode="cover" />
              ) : (
                <View style={[styles.tileImage, styles.tileFallback]}>
                  <Text style={styles.tileGlyph}>{p.type === "video" ? "▶" : "🖼"}</Text>
                  <Text style={styles.tileGlyphLabel}>{p.type === "video" ? "Video" : "Post"}</Text>
                </View>
              )}
              <View style={styles.tileFoot}>
                <Text style={styles.tileSpot} numberOfLines={1}>
                  {p.spot.name}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

/** Full-screen viewer for one of my posts (photo + caption + spot + time). */
function PostViewer({
  post,
  onClose,
}: {
  post: MyPostRow | null;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Modal visible={post != null} animationType="slide" onRequestClose={onClose}>
      <View style={styles.viewer}>
        <View style={styles.viewerHead}>
          <Text style={styles.viewerSpot} numberOfLines={1}>
            {post?.spot.name ?? ""}
          </Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.close}>✕</Text>
          </Pressable>
        </View>
        {post?.media_url && post.type === "image" ? (
          <Image source={{ uri: post.media_url }} style={styles.viewerImage} resizeMode="contain" />
        ) : (
          <View style={styles.viewerFallback}>
            <Text style={styles.viewerFallbackText}>
              {post?.type === "video" ? "Video post" : "Media unavailable"}
            </Text>
          </View>
        )}
        {post?.caption ? <Text style={styles.viewerCaption}>{post.caption}</Text> : null}
        <Text style={styles.viewerMeta}>
          {post ? new Date(post.created_at).toLocaleString() : ""} · {post?.spot.city ?? ""}
        </Text>
      </View>
    </Modal>
  );
}

/** "your pull" — the concrete proof of the audience-visibility thesis. */
function PullSection({ pull }: { pull: InfluencerPull }): React.JSX.Element {
  const follow =
    pull.goers_follow_through_pct != null
      ? `${pull.goers_follow_through_pct.toFixed(1)}%`
      : pull.announcements_total > 0
        ? "—"
        : null;
  return (
    <View style={styles.pull}>
      <View style={styles.pullHead}>
        <Text style={styles.pullTitle}>Your pull</Text>
        <Text style={styles.pullSub}>When you announce, people show up.</Text>
      </View>
      <View style={styles.pullMetrics}>
        <View style={styles.pullMetric}>
          <Text style={styles.pullValue}>{pull.announcements_total}</Text>
          <Text style={styles.pullLabel}>announced</Text>
        </View>
        <View style={styles.pullMetric}>
          <Text style={styles.pullValue}>{pull.confirmations_drawn_total}</Text>
          <Text style={styles.pullLabel}>confirmations drawn</Text>
        </View>
        <View style={styles.pullMetric}>
          <Text style={styles.pullValue}>{follow ?? "–"}</Text>
          <Text style={styles.pullLabel}>follow-through</Text>
        </View>
        {pull.avg_confirmations_per_announcement != null &&
        pull.announcements_total > 0 ? (
          <View style={styles.pullMetric}>
            <Text style={styles.pullValue}>
              {pull.avg_confirmations_per_announcement.toFixed(1)}
            </Text>
            <Text style={styles.pullLabel}>per announcement</Text>
          </View>
        ) : null}
      </View>
      {pull.announcements_total === 0 ? (
        <Text style={styles.pullHint}>
          Announce a spot and watch your room fill — your pull is built from
          real confirmations, never invented numbers.
        </Text>
      ) : (
        <Text style={styles.pullHint}>
          {follow
            ? `${follow} of your goers actually show up.`
            : "Your first goers haven't been settled yet — follow-through appears after your night."}
        </Text>
      )}
    </View>
  );
}

export function ProfileScreen({ onLogout }: Props): React.JSX.Element {
  const [user, setUser] = useState<User | null>(null);
  const [pull, setPull] = useState<InfluencerPull>(EMPTY_PULL);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // REVAMP 5 — profile picture state (upload in flight / last failure).
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  // REVAMP 5 — my own native posts (the profile grid).
  const [myPosts, setMyPosts] = useState<MyPostRow[]>([]);
  const [postsLoading, setPostsLoading] = useState(true);
  const [postsError, setPostsError] = useState<string | null>(null);
  const [openPost, setOpenPost] = useState<MyPostRow | null>(null);

  // REVAMP 3: "Bring your nights" imports (own load path — the card should
  // still render honestly if /me/pull hiccups).
  const [imports, setImports] = useState<ImportedPost[]>([]);
  const [importsLimit, setImportsLimit] = useState(3);
  const [importsLoading, setImportsLoading] = useState(true);
  const [importsError, setImportsError] = useState<string | null>(null);
  const [flowOpen, setFlowOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [me, pullRes] = await Promise.all([
        api.me(),
        api.myPull().catch(() => null),
      ]);
      setUser(me.user);
      if (pullRes) setPull(pullRes.pull);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load profile");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadImports = useCallback(async () => {
    setImportsLoading(true);
    setImportsError(null);
    try {
      const res = await api.myImports();
      setImports(res.imports);
      setImportsLimit(res.limit);
    } catch (e) {
      setImportsError(e instanceof ApiError ? e.message : "Could not load your nights");
    } finally {
      setImportsLoading(false);
    }
  }, []);

  const loadMyPosts = useCallback(async () => {
    setPostsLoading(true);
    setPostsError(null);
    try {
      const res = await api.myPosts({ limit: 30 });
      setMyPosts(res.posts);
    } catch (e) {
      setPostsError(e instanceof ApiError ? e.message : "Could not load your posts");
    } finally {
      setPostsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadImports();
    void loadMyPosts();
  }, [load, loadImports, loadMyPosts]);

  /**
   * REVAMP 5 — set my profile picture through the real media contract:
   * pick (or shoot) an image → requestUploadUrl(kind:"avatar") → PUT the bytes
   * → PATCH /me/avatar with the returned object_key. The server resolves the
   * public URL; the header re-renders from the returned user.
   */
  async function uploadAvatar(source: "camera" | "library"): Promise<void> {
    setAvatarError(null);
    try {
      let picked: ImagePicker.ImagePickerAsset | null = null;
      if (source === "camera") {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          setAvatarError("Camera permission is needed to take your picture.");
          return;
        }
        const res = await ImagePicker.launchCameraAsync({
          mediaTypes: ["images"],
          allowsEditing: true,
          aspect: [1, 1],
          quality: 0.7,
        });
        picked = res.canceled ? null : res.assets[0] ?? null;
      } else {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          setAvatarError("Photo library permission is needed to pick your picture.");
          return;
        }
        const res = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"],
          allowsEditing: true,
          aspect: [1, 1],
          quality: 0.7,
        });
        picked = res.canceled ? null : res.assets[0] ?? null;
      }
      if (!picked) return;

      setAvatarBusy(true);
      const body = await readBytes(picked.uri);
      const ext = extOf(picked.fileName, "jpg");
      const contentType = CONTENT_TYPE_BY_EXT[ext] ?? "image/jpeg";
      if (contentType.startsWith("video/")) {
        setAvatarError("Pick a photo — profile pictures can't be video.");
        return;
      }
      const slot = await api.requestUploadUrl({ content_type: contentType, ext, kind: "avatar" });
      await uploadWithProgress(
        slot.upload.upload_url,
        slot.upload.method,
        slot.upload.headers,
        body,
        () => undefined,
      );
      const res = await api.setAvatar(slot.upload.object_key);
      setUser(res.user);
    } catch (e) {
      setAvatarError(e instanceof ApiError ? e.message : "Could not update your photo. Try again.");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function removeAvatar(): Promise<void> {
    setAvatarError(null);
    setAvatarBusy(true);
    try {
      const res = await api.clearAvatar();
      setUser(res.user);
    } catch (e) {
      setAvatarError(e instanceof ApiError ? e.message : "Could not remove your photo.");
    } finally {
      setAvatarBusy(false);
    }
  }

  /** The photo affordance: camera, library, or remove (only when one is set). */
  function pickAvatar(): void {
    if (avatarBusy) return;
    Alert.alert(
      user?.avatar_url ? "Change your photo" : "Add a profile photo",
      "Your picture shows wherever you appear — going lists, clusters and your posts.",
      [
        { text: "Take photo", onPress: () => void uploadAvatar("camera") },
        { text: "Choose from library", onPress: () => void uploadAvatar("library") },
        ...(user?.avatar_url
          ? [{ text: "Remove photo", style: "destructive" as const, onPress: () => void removeAvatar() }]
          : []),
        { text: "Cancel", style: "cancel" as const },
      ],
    );
  }

  async function handleDelete(id: string): Promise<void> {
    if (deletingId === id) {
      // Second tap = confirmed. Delete, then let the API's own remaining count
      // drive the UI (refresh from GET /me/imports).
      setDeletingId(null);
      try {
        await api.deleteImport(id);
        await loadImports();
      } catch (e) {
        setImportsError(e instanceof ApiError ? e.message : "Could not remove that night");
      }
    } else {
      setDeletingId(id);
      setTimeout(() => setDeletingId((cur) => (cur === id ? null : cur)), 4000);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Profile</Text>
      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
      ) : error ? (
        <>
          <Text style={styles.error}>{error}</Text>
          <Pressable onPress={() => void load()} style={styles.retry}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </>
      ) : user ? (
        <View style={styles.card}>
          <Pressable onPress={pickAvatar} disabled={avatarBusy} style={styles.avatarWrap}>
            <Avatar identity={user} size={96} />
            <View style={styles.avatarBadge}>
              <Text style={styles.avatarBadgeText}>{avatarBusy ? "…" : user.avatar_url ? "✎" : "+"}</Text>
            </View>
          </Pressable>
          <Pressable onPress={pickAvatar} disabled={avatarBusy}>
            <Text style={styles.avatarCta}>
              {avatarBusy ? "Uploading…" : user.avatar_url ? "Change photo" : "Add photo"}
            </Text>
          </Pressable>
          {avatarError ? <Text style={styles.error}>{avatarError}</Text> : null}
          <Text style={styles.name}>{user.display_name}</Text>
          <Text style={styles.username}>@{user.username}</Text>
          <Text style={styles.city}>📍 {user.city}</Text>

          <View style={styles.stars}>
            <Text style={styles.starText}>{"★".repeat(Math.round(user.star_rating))}</Text>
            <Text style={styles.starValue}>{user.star_rating.toFixed(1)}</Text>
          </View>
          <Text style={styles.meta}>
            {user.verified_checkin_count} verified check-ins · {user.reputation_points} reputation pts
          </Text>
          <Text style={styles.hint}>
            Show up where you say you&apos;ll be to raise your stars. No-shows hurt.
          </Text>
          <PullSection pull={pull} />
          <Pressable style={styles.logout} onPress={onLogout}>
            <Text style={styles.logoutText}>Log out</Text>
          </Pressable>
        </View>
      ) : null}
      <PostsGrid
        posts={myPosts}
        loading={postsLoading}
        error={postsError}
        onRetry={() => void loadMyPosts()}
        onOpen={(p) => setOpenPost(p)}
      />
      <PostViewer post={openPost} onClose={() => setOpenPost(null)} />
      <ImportSection
        imports={imports}
        limit={importsLimit}
        loading={importsLoading}
        error={importsError}
        onRetry={() => void loadImports()}
        onAdd={() => setFlowOpen(true)}
        onDelete={(id) => void handleDelete(id)}
        deletingId={deletingId}
      />
      <ImportFlowSheet
        visible={flowOpen}
        onClose={() => setFlowOpen(false)}
        onImported={() => {
          setFlowOpen(false);
          void loadImports();
        }}
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
    padding: spacing.xl,
  },
  title: {
    color: colors.text,
    fontSize: 28,
    fontWeight: "800",
    marginBottom: spacing.lg,
  },
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 18,
    padding: spacing.xl,
    alignItems: "center",
  },
  avatar: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  avatarText: {
    color: "#fff",
    fontSize: 30,
    fontWeight: "800",
  },
  name: {
    color: colors.text,
    fontSize: 22,
    fontWeight: "700",
  },
  username: {
    color: colors.textDim,
    fontSize: 15,
    marginTop: 2,
  },
  city: {
    color: colors.textDim,
    fontSize: 14,
    marginTop: spacing.sm,
  },
  stars: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
  starText: {
    color: colors.star,
    fontSize: 24,
    letterSpacing: 2,
  },
  starValue: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700",
  },
  meta: {
    color: colors.textDim,
    fontSize: 13,
    marginTop: spacing.sm,
  },
  hint: {
    color: colors.textDim,
    fontSize: 12,
    textAlign: "center",
    marginTop: spacing.md,
    lineHeight: 18,
  },
  pull: {
    marginTop: spacing.lg,
    padding: spacing.md,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primary,
    alignSelf: "stretch",
  },
  pullHead: {
    gap: 2,
  },
  pullTitle: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  pullSub: {
    color: colors.textDim,
    fontSize: 12,
  },
  pullMetrics: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  pullMetric: {
    flex: 1,
  },
  pullValue: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "800",
  },
  pullLabel: {
    color: colors.textDim,
    fontSize: 11,
    marginTop: 2,
  },
  pullHint: {
    color: colors.textDim,
    fontSize: 12,
    lineHeight: 17,
    marginTop: spacing.sm,
  },
  logout: {
    marginTop: spacing.xl,
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  logoutText: {
    color: colors.danger,
    fontSize: 15,
    fontWeight: "600",
  },
  error: {
    color: colors.danger,
    fontSize: 15,
    marginTop: spacing.lg,
    textAlign: "center",
  },
  retry: {
    marginTop: spacing.md,
    alignSelf: "center",
    backgroundColor: colors.surfaceAlt,
    borderRadius: 10,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  retryText: {
    color: colors.text,
  },
  // --- REVAMP 3: "Bring your nights" ----------------------------------------
  // --- REVAMP 5: profile picture + my posts grid ------------------------------
  avatarWrap: {
    marginBottom: spacing.sm,
  },
  avatarBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.primary,
    borderWidth: 2,
    borderColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarBadgeText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "800",
    lineHeight: 20,
  },
  avatarCta: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: "800",
    marginBottom: spacing.sm,
  },
  posts: {
    marginTop: spacing.lg,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 18,
    padding: spacing.lg,
  },
  postsHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  postsKicker: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  postsCount: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "800",
  },
  postsEmpty: {
    color: colors.textDim,
    fontSize: 13,
    lineHeight: 19,
    marginTop: spacing.sm,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: spacing.md,
  },
  tile: {
    width: "31.5%",
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: colors.surface,
  },
  tileImage: {
    width: "100%",
    aspectRatio: 1,
    backgroundColor: colors.surfaceAlt,
  },
  tileFallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  tileGlyph: {
    fontSize: 22,
    color: colors.text,
  },
  tileGlyphLabel: {
    color: colors.textDim,
    fontSize: 11,
    marginTop: 2,
  },
  tileFoot: {
    paddingHorizontal: 6,
    paddingVertical: 5,
  },
  tileSpot: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: "700",
  },
  viewer: {
    flex: 1,
    backgroundColor: colors.background,
    padding: spacing.md,
  },
  viewerHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.md,
  },
  viewerSpot: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "800",
    flex: 1,
    marginRight: spacing.sm,
  },
  close: {
    color: colors.textDim,
    fontSize: 18,
    fontWeight: "700",
  },
  viewerImage: {
    width: "100%",
    height: 380,
    borderRadius: 14,
    backgroundColor: colors.surfaceAlt,
  },
  viewerFallback: {
    width: "100%",
    height: 220,
    borderRadius: 14,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  viewerFallbackText: {
    color: colors.textDim,
    fontSize: 14,
  },
  viewerCaption: {
    color: colors.text,
    fontSize: 15,
    lineHeight: 21,
    marginTop: spacing.md,
  },
  viewerMeta: {
    color: colors.textDim,
    fontSize: 12,
    marginTop: spacing.sm,
  },
  imports: {
    marginTop: spacing.lg,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 18,
    padding: spacing.lg,
  },
  importsHead: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
  },
  importsKicker: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  importsSub: {
    color: colors.textDim,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 4,
  },
  importsCount: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  importsCountText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "800",
  },
  importsError: {
    marginTop: spacing.md,
    alignItems: "center",
  },
  retrySmall: {
    marginTop: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  retrySmallText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "700",
  },
  importsEmpty: {
    marginTop: spacing.md,
    alignItems: "center",
    padding: spacing.md,
  },
  importsEmptyTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "800",
    textAlign: "center",
  },
  importsEmptySub: {
    color: colors.textDim,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    marginTop: spacing.sm,
  },
  importsAdd: {
    marginTop: spacing.md,
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    alignSelf: "center",
  },
  importsAddText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 14,
  },
  importsFull: {
    color: colors.textDim,
    fontSize: 12,
    textAlign: "center",
    marginTop: spacing.md,
  },
  importRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    padding: spacing.sm,
    marginTop: spacing.md,
  },
  importThumb: {
    width: 52,
    height: 52,
    borderRadius: 10,
    backgroundColor: colors.surfaceAlt,
  },
  importThumbEmpty: {
    alignItems: "center",
    justifyContent: "center",
  },
  importThumbGlyph: {
    fontSize: 22,
  },
  importBody: {
    flex: 1,
    gap: 3,
  },
  importTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  importSpot: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "800",
    flex: 1,
  },
  importPlatform: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: "700",
  },
  importBadges: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
  },
  badgeVerified: {
    borderColor: colors.success,
    backgroundColor: "rgba(61, 220, 151, 0.12)",
  },
  badgeText: {
    fontSize: 11,
    fontWeight: "800",
  },
  badgeTextVerified: {
    color: colors.success,
  },
  badgePending: {
    borderColor: colors.star,
    backgroundColor: "rgba(255, 194, 75, 0.12)",
  },
  badgeTextPending: {
    color: colors.star,
  },
  badgeRejected: {
    borderColor: colors.danger,
    backgroundColor: "rgba(255, 90, 95, 0.12)",
  },
  badgeTextRejected: {
    color: colors.danger,
  },
  recentTag: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: "800",
  },
  importCaption: {
    color: colors.textDim,
    fontSize: 12,
  },
  importDelete: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceAlt,
  },
  importDeleteArmed: {
    backgroundColor: colors.danger,
  },
  importDeleteText: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: "800",
  },
  importDeleteTextArmed: {
    color: "#fff",
  },
});