-- Scale to zero is on by default: existing app services sleep after 15 idle
-- minutes once redeployed. Set to NULL to keep a service always on.
ALTER TABLE services ADD COLUMN scale_to_zero_minutes INTEGER DEFAULT 15;
UPDATE services SET scale_to_zero_minutes = NULL WHERE service_type != 'app';
ALTER TABLE services ADD COLUMN last_activity_at INTEGER;
ALTER TABLE services ADD COLUMN sleeping_since INTEGER;
ALTER TABLE deployments ADD COLUMN scale_to_zero_minutes INTEGER;
