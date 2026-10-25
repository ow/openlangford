-- Properties geocode themselves when no agenda item at the lot was geocoded;
-- remember failed attempts so each run doesn't re-ask Nominatim.
-- Streets are rows with civic_number = '' (slug "leigh-road").
ALTER TABLE properties ADD COLUMN IF NOT EXISTS geocode_attempted_at timestamptz;
