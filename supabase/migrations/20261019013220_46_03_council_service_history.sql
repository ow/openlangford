-- Completed historical tenure summaries, retaining source year precision.
-- These are presentation metadata, not fabricated dated statistical memberships.
-- Stew Young's own biography explicitly identifies his mayoral service as 1993–2022.
BEGIN;
UPDATE people p
SET meta = coalesce(p.meta, '{}'::jsonb) || jsonb_build_object(
  'council_service_history', jsonb_build_array(jsonb_build_object(
    'organization_id', o.id, 'role', 'Mayor', 'start_year', 1993, 'end_year', 2022,
    'source_url', 'https://stewyoung.com/about', 'verified_on', '2026-10-18'
  ))
)
FROM organizations o
WHERE p.name IN ('Stew Young', 'S. Young')
  AND o.classification = 'Council' AND o.municipality_id = 1
  AND EXISTS (SELECT 1 FROM memberships m WHERE m.person_id = p.id AND m.organization_id = o.id)
  AND NOT (coalesce(p.meta, '{}'::jsonb) ? 'council_service_history');
COMMIT;
