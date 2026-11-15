ALTER TABLE services ADD COLUMN scale_to_zero_minutes INTEGER;
ALTER TABLE services ADD COLUMN last_activity_at INTEGER;
ALTER TABLE services ADD COLUMN sleeping_since INTEGER;
ALTER TABLE deployments ADD COLUMN scale_to_zero_minutes INTEGER;
