-- Rollback eligibility used to be cleared only on running deployments, so
-- every replaced (stopped) deployment kept rollback_eligible = 1 forever and
-- cleanup never deleted its image. Keep the flag on the latest 5 successful
-- deployments per service without volumes; clear it everywhere else.
UPDATE deployments SET rollback_eligible = 0 WHERE rollback_eligible = 1;

UPDATE deployments SET rollback_eligible = 1
WHERE id IN (
  SELECT id FROM (
    SELECT d.id,
      ROW_NUMBER() OVER (PARTITION BY d.service_id ORDER BY d.created_at DESC) AS rn
    FROM deployments d
    JOIN services s ON s.id = d.service_id
    WHERE d.status IN ('running', 'stopped')
      AND d.image_name IS NOT NULL
      AND (s.volumes IS NULL OR s.volumes = '[]')
  )
  WHERE rn <= 5
);
