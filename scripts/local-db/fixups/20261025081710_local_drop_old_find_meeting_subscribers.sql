-- LOCAL ONLY. 20261025081711_47_21 replaces find_meeting_subscribers with a different return type, which
-- CREATE OR REPLACE can't do. Production no longer had the old version by then; drop it here.
DROP FUNCTION IF EXISTS public.find_meeting_subscribers(bigint);
