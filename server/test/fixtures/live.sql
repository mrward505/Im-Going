-- Persistent test fixture for live-API smoke tests (test/live.smoke.test.ts).
TRUNCATE phone_otp_requests, reputation_ledger, going, checkins, posts, moderation_reports, events, spots, users RESTART IDENTITY CASCADE;

INSERT INTO users (id, phone, dob, display_name, username, reputation_points, star_rating)
VALUES
  ('11111111-1111-4111-8111-111111111111', '+15550000001', '2001-03-10', 'Ana',   'ana',   800, 4.2),
  ('22222222-2222-4222-8222-222222222222', '+15550000002', '1999-07-22', 'Bas',   'bas',   500, 3.0),
  ('33333333-3333-4333-8333-333333333333', '+15550000003', '1998-11-02', 'Cara',  'cara',  250, 2.0),
  ('44444444-4444-4444-8444-444444444444', '+15550000004', '2003-12-31', 'Dev',   'dev',   500, 3.0);

INSERT INTO spots (id, name, address, lat, lon, geofence_radius_m, category, is_verified, is_large_venue, city)
VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'The 44',      '44 E University Dr, Tempe, AZ', 33.4219,  -111.9380, 150, 'bar',        true,  false, 'Tempe'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'ASU Gammage', '1200 S Forest Ave, Tempe, AZ', 33.4055,  -111.9360, 400, 'concert',    true,  true,  'Tempe'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Mill Ave Loft Party', '829 S Mill Ave',      33.4190,  -111.9410, 100, 'house',      false, false, 'Tempe'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Slices Pizza', '123 W Broadway Rd, Tempe',    33.4100,  -111.9450, 150, 'restaurant', true,  false, 'Tempe');

INSERT INTO events (id, spot_id, start_at, note, created_by)
VALUES
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now() + interval '3 hours',   'Same lineup as last week', '11111111-1111-4111-8111-111111111111'),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', now() + interval '26 hours', 'house party 🎉',             '22222222-2222-4222-8222-222222222222');

INSERT INTO going (event_id, user_id, status) VALUES
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '11111111-1111-4111-8111-111111111111', 'active'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '22222222-2222-4222-8222-222222222222', 'active'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '33333333-3333-4333-8333-333333333333', 'active'),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', '22222222-2222-4222-8222-222222222222', 'active');

INSERT INTO checkins (id, event_id, user_id, spot_id, verified_at, method, lat, lon, accuracy_m)
VALUES
  ('99999999-9999-4999-8999-999999999999', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '11111111-1111-4111-8111-111111111111',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now() - interval '10 days', 'manual_gps', 33.42195, -111.93805, 12);

UPDATE users SET verified_checkin_count = 1 WHERE id = '11111111-1111-4111-8111-111111111111';

INSERT INTO reputation_ledger (user_id, kind, points_delta, event_id) VALUES
  ('11111111-1111-4111-8111-111111111111', 'showup', 100, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  ('11111111-1111-4111-8111-111111111111', 'first_checkin', 0, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');

INSERT INTO posts (id, event_id, check_in_id, user_id, spot_id, type, caption, object_key, width, height)
VALUES
  ('77777777-7777-4777-8777-777777777777', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', '99999999-9999-4999-8999-999999999999',
   '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'image', 'best night', 'test/live-post-1.jpg', 1080, 1920);