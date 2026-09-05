/**
 * Shared API types for I'm Going — mirrored 1:1 from the server's response
 * shapes (server/src/db.ts serializers + routes). Keep in sync when the
 * backend contract changes.
 */

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** /api/v1/auth/otp/request (201) — dev_code present when OTP_PROVIDER=console */
export interface OtpRequestResponse {
  request_id: string;
  expires_at: string;
  provider: string;
  dev_code?: string;
}

/** /api/v1/auth/otp/verify — existing user → login; new user → signup token */
export type OtpVerifyResponse =
  | { type: "login"; token: string; user: User }
  | { type: "signup"; signup_token: string };

/** /api/v1/auth/register (201) */
export interface RegisterResponse {
  token: string;
  user: User;
}

/** GET /api/v1/me */
export interface MeResponse {
  user: User;
}

export interface User {
  id: string;
  phone: string;
  display_name: string;
  username: string;
  dob: string; // YYYY-MM-DD
  city: string;
  reputation_points: number;
  star_rating: number; // 1.0–5.0
  verified_checkin_count: number;
  created_at: string;
}

export type SpotCategory =
  | "bar"
  | "club"
  | "restaurant"
  | "coffee"
  | "concert_venue"
  | "campus"
  | "house"
  | "other";

/** A spot as returned by serializers. Custom spots are masked (confirmed flag). */
export interface Spot {
  id: string;
  name: string;
  address: string | null;
  lat: number | null;
  lon: number | null;
  geofence_radius_m: number | null;
  category: SpotCategory;
  is_large_venue: boolean;
  city: string;
  is_verified: boolean; // true for POI venues, false for custom spots
  is_custom: boolean;
  created_by: string | null;
  // Custom-spot masking: exact address/lat/lon are null for the viewer until
  // they confirm going to an event on this spot (spec §2b).
  confirmed: boolean;
}

export interface EventView {
  id: string;
  spot: Spot;
  start_at: string;
  end_at: string | null;
  note: string | null;
  status: "active" | "cancelled";
  created_by: string;
  going_count: number;
  i_am_going: boolean;
  going: Array<{ user_id: string; display_name: string; username: string; star_rating: number }>;
  can_check_in: boolean; // true inside [start-30m, start+150m]
  checked_in: boolean;
  posts: Array<{
    id: string;
    user_id: string;
    display_name: string;
    type: "photo" | "video";
    caption: string | null;
    object_key: string;
    created_at: string;
  }>;
}

/** GET /api/v1/trending */
export interface TrendingResponse {
  trending: Array<{
    spot: Spot;
    next_start_at: string;
    going_count: number;
    trending_score: number;
  }>;
}

/** GET /api/v1/venues?q=&category=&page=&limit=&lat=&lon=&radius_m= */
export interface VenuesResponse {
  venues: Array<{
    id: string;
    name: string;
    address: string | null;
    lat: number;
    lon: number;
    geofence_radius_m: number;
    category: SpotCategory;
    is_large_venue: boolean;
    city: string;
  }>;
  page: number;
  limit: number;
  total: number;
  total_pages: number;
}

/** POST /api/v1/events (201) — announce */
export interface AnnounceEventResponse {
  event: EventView;
  snapped_to_existing: boolean;
  shares_remaining: number;
}

/** POST /api/v1/events/:id/going (201) — confirm */
export interface ConfirmGoingResponse {
  event: EventView;
}

/** GET /api/v1/events/:id */
export interface EventDetailResponse {
  event: EventView;
}

/** POST /api/v1/events/:id/checkin (201) — manual GPS check-in */
export interface CheckinResponse {
  checkin: {
    id: string;
    event_id: string;
    verified: boolean;
    method: "manual_gps" | "passive";
    verified_at: string;
  };
  reputation: {
    points: number;
    star_rating: number;
  };
}

/** DELETE /api/v1/events/:id/going */
export interface CancelGoingResponse {
  event: EventView;
  settlement: {
    kind: "free_cancel" | "soft_no_show" | "no_show" | null;
    points_delta: number;
  };
}

/** POST /api/v1/shares (201) / GET /api/v1/shares/budget */
export interface ShareResponse {
  limit: number;
  remaining: number;
}