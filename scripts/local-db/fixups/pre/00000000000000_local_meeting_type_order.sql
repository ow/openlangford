-- LOCAL ONLY, runs before sql/bootstrap.sql. bootstrap.sql now lists 'Inauguration' first in meeting_type,
-- but production added it last (20261020150531_47_14 ADD VALUE). Enum order affects sorting, so create the
-- type in production's order; bootstrap's CREATE TYPE then hits duplicate_object and is skipped.
DO $$ BEGIN
  CREATE TYPE public.meeting_type AS ENUM ('Regular Council', 'Special Council', 'Committee of the Whole',
    'Public Hearing', 'Board of Variance', 'Standing Committee', 'Advisory Committee');
EXCEPTION WHEN duplicate_object THEN null;
END $$;
