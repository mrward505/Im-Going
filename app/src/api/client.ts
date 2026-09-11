/**
 * Typed API client for I'm Going — thin fetch wrapper, no runtime deps.
 *
 * Base URL: EXPO_PUBLIC_API_URL (e.g. `http://127.0.0.1:8081` for the local
 * dev API). The server listens on 8081; the Expo dev server defaults to 8081
 * too, so run Expo with `--port 8082` in dev and point EXPO_PUBLIC_API_URL
 * at the API. On a device, replace 127.0.0.1 with the dev machine's LAN IP.
 */
import { getToken, setToken, clearToken } from "./tokenStorage";
import type {
  AnnounceEventResponse,
  ApiErrorBody,
  CancelGoingResponse,
  CheckinResponse,
  CitiesResponse,
  ConfirmGoingResponse,
  CreateImportInput,
  CreateImportResponse,
  CreatePostResponse,
  CreateSpotResponse,
  DeleteImportResponse,
  EventDetailResponse,
  EventGoingResponse,
  ImportsResponse,
  MeResponse,
  ModerationReason,
  MyGoingResponse,
  OtpRequestResponse,
  OtpVerifyResponse,
  PostMediaType,
  PullResponse,
  RegisterResponse,
  ReportPostResponse,
  RequestUploadUrlResponse,
  ShareResponse,
  SpotDetailResponse,
  SpotFeedResponse,
  SpotShareResponse,
  SpotsResponse,
  TrendingResponse,
  VenueSort,
  VenuesResponse,
  VenuesSearchResponse,
} from "./types";

export const API_URL: string = process.env.EXPO_PUBLIC_API_URL ?? "http://127.0.0.1:8081";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface RequestOptions {
  auth?: boolean;
}

async function request<T>(path: string, init: RequestInit & RequestOptions = {}): Promise<T> {
  const { auth = true, ...rest } = init;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(rest.headers as Record<string, string> | undefined),
  };
  if (auth) {
    const token = await getToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${API_URL}${path}`, { ...rest, headers });
  if (!res.ok) {
    let body: ApiErrorBody | undefined;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      // non-JSON error
    }
    throw new ApiError(
      res.status,
      body?.error?.code ?? "http_error",
      body?.error?.message ?? `HTTP ${res.status} ${res.statusText}`,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// --- auth (no token required) ------------------------------------------------

export const authApi = {
  requestOtp(phone: string): Promise<OtpRequestResponse> {
    return request("/api/v1/auth/otp/request", {
      method: "POST",
      body: JSON.stringify({ phone }),
      auth: false,
    });
  },
  async verifyOtp(phone: string, code: string): Promise<OtpVerifyResponse> {
    const res = await request<OtpVerifyResponse>("/api/v1/auth/otp/verify", {
      method: "POST",
      body: JSON.stringify({ phone, code }),
      auth: false,
    });
    if (res.type === "login") await setToken(res.token);
    // signup: caller keeps the token for register()
    return res;
  },
  async register(input: {
    signup_token: string;
    display_name: string;
    username: string;
    dob: string; // YYYY-MM-DD
    invite_code: string; // Tempe launch gate: required for new users
  }): Promise<RegisterResponse> {
    const res = await request<RegisterResponse>("/api/v1/auth/register", {
      method: "POST",
      body: JSON.stringify(input),
      auth: false,
    });
    await setToken(res.token);
    return res;
  },
};

// --- authenticated -----------------------------------------------------------

export const api = {
  me(): Promise<MeResponse> {
    return request("/api/v1/me");
  },
  trending(): Promise<TrendingResponse> {
    return request("/api/v1/trending");
  },
  venues(params: {
    q?: string;
    category?: string;
    page?: number;
    limit?: number;
    lat?: number;
    lon?: number;
    radius_m?: number;
  }): Promise<VenuesResponse> {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.category) qs.set("category", params.category);
    if (params.page !== undefined) qs.set("page", String(params.page));
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.lat !== undefined) qs.set("lat", String(params.lat));
    if (params.lon !== undefined) qs.set("lon", String(params.lon));
    if (params.radius_m !== undefined) qs.set("radius_m", String(params.radius_m));
    const suffix = qs.toString();
    return request(`/api/v1/venues${suffix ? `?${suffix}` : ""}`);
  },
  /**
   * REVAMP 1/2 — universal metro search (public route; no auth needed).
   * Params mirror the server schema exactly; empty q is omitted (server
   * requires q min length 1 when present).
   */
  venuesSearch(params: {
    q?: string;
    city?: string;
    category?: string;
    sort?: VenueSort;
    page?: number;
    limit?: number;
    lat?: number;
    lon?: number;
    radius_km?: number;
  }): Promise<VenuesSearchResponse> {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.city) qs.set("city", params.city);
    if (params.category) qs.set("category", params.category);
    if (params.sort) qs.set("sort", params.sort);
    if (params.page !== undefined) qs.set("page", String(params.page));
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.lat !== undefined) qs.set("lat", String(params.lat));
    if (params.lon !== undefined) qs.set("lon", String(params.lon));
    if (params.radius_km !== undefined) qs.set("radius_km", String(params.radius_km));
    const suffix = qs.toString();
    return request(`/api/v1/venues/search${suffix ? `?${suffix}` : ""}`, { auth: false });
  },
  /** REVAMP 1 — real metro cities with venue counts (public route). */
  cities(): Promise<CitiesResponse> {
    return request("/api/v1/cities", { auth: false });
  },
  myGoing(): Promise<MyGoingResponse> {
    return request("/api/v1/me/going");
  },
  spots(params: { q?: string; category?: string; limit?: number }): Promise<SpotsResponse> {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.category) qs.set("category", params.category);
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    const suffix = qs.toString();
    return request(`/api/v1/spots${suffix ? `?${suffix}` : ""}`, { auth: false });
  },
  createSpot(input: {
    name: string;
    address?: string;
    lat: number;
    lon: number;
    category: string;
    description?: string;
  }): Promise<CreateSpotResponse> {
    return request("/api/v1/spots", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  spot(id: string): Promise<SpotDetailResponse> {
    return request(`/api/v1/spots/${id}`, { auth: false });
  },
  spotShare(id: string): Promise<SpotShareResponse> {
    return request(`/api/v1/spots/${id}/share`);
  },
  /** My own influencer pull (Slice 4d-3a: "watch the room fill"). */
  myPull(): Promise<PullResponse> {
    return request("/api/v1/me/pull");
  },
  /** Another user's influencer pull (Slice 4d-3a). */
  userPull(userId: string): Promise<PullResponse> {
    return request(`/api/v1/users/${userId}/pull`, { auth: false });
  },
  announceEvent(input: {
    spot_id: string;
    start_at: string; // ISO
    note?: string;
  }): Promise<AnnounceEventResponse> {
    return request("/api/v1/events", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  event(id: string): Promise<EventDetailResponse> {
    return request(`/api/v1/events/${id}`);
  },
  confirmGoing(eventId: string): Promise<ConfirmGoingResponse> {
    return request(`/api/v1/events/${eventId}/going`, { method: "POST" });
  },
  eventGoing(eventId: string): Promise<EventGoingResponse> {
    return request(`/api/v1/events/${eventId}/going`);
  },
  cancelGoing(eventId: string): Promise<CancelGoingResponse> {
    return request(`/api/v1/events/${eventId}/going`, { method: "DELETE" });
  },
  checkin(eventId: string, input: { lat: number; lon: number; accuracy_m?: number; method?: "manual_gps" | "passive" }): Promise<CheckinResponse> {
    return request(`/api/v1/events/${eventId}/checkin`, {
      method: "POST",
      body: JSON.stringify({ ...input, location_permission_granted: true }),
    });
  },
  shareBudget(): Promise<ShareResponse> {
    return request("/api/v1/shares/budget");
  },
  recordShare(input: { channel?: string; event_id?: string } = {}): Promise<ShareResponse> {
    return request("/api/v1/shares", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  // --- Slice 4d-1: posts / media / moderation ---------------------------------
  spotFeed(spotId: string, params: { limit?: number; offset?: number } = {}): Promise<SpotFeedResponse> {
    const qs = new URLSearchParams();
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.offset !== undefined) qs.set("offset", String(params.offset));
    const suffix = qs.toString();
    return request(`/api/v1/spots/${spotId}/feed${suffix ? `?${suffix}` : ""}`, { auth: false });
  },
  createPost(eventId: string, input: {
    type: PostMediaType;
    caption?: string;
    object_key: string;
    width?: number;
    height?: number;
    duration_s?: number;
  }): Promise<CreatePostResponse> {
    return request(`/api/v1/events/${eventId}/posts`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  requestUploadUrl(input: {
    content_type: "image/jpeg" | "image/png" | "image/heic" | "video/mp4" | "video/quicktime";
    ext?: string;
    kind?: "post" | "avatar";
  }): Promise<RequestUploadUrlResponse> {
    return request("/api/v1/media/upload-url", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  reportPost(postId: string, reason: ModerationReason): Promise<ReportPostResponse> {
    return request(`/api/v1/posts/${postId}/report`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
  },
  // --- REVAMP 3: social import ("Bring your nights") --------------------------
  myImports(): Promise<ImportsResponse> {
    return request("/api/v1/me/imports");
  },
  createImport(input: CreateImportInput): Promise<CreateImportResponse> {
    return request("/api/v1/me/imports", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  deleteImport(id: string): Promise<DeleteImportResponse> {
    return request(`/api/v1/me/imports/${id}`, { method: "DELETE" });
  },
  async logout(): Promise<void> {
    await clearToken();
  },
};

export { API_URL as defaultBaseUrl };