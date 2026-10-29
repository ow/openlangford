-- Portraits for Langford councillors-elect (2026 general local election) that
-- 46-02 left without an image. Provenance for each file:
-- apps/web/public/images/council/sources.json.
--   Wendy Hobbs      - official Sooke School District 62 trustee portrait (former trustee)
--   Brandy Gordon    - campaign photo (candidate-submitted VoteMate profile), not an official City portrait
--   Jennifer Dunnett - campaign photo (jenniferdunnettlangford.ca), not an official City portrait
BEGIN;

UPDATE people SET image_url = '/images/council/wendy-hobbs.webp' WHERE id = 60 AND name = 'Wendy Hobbs';
UPDATE people SET image_url = '/images/council/brandy-gordon.webp' WHERE id = 50 AND name = 'Brandy Gordon';
UPDATE people SET image_url = '/images/council/jennifer-dunnett.webp' WHERE id = 355 AND name = 'Jennifer Dunnett';

COMMIT;
