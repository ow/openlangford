-- One shared quota for public AI search. Reserve before calling any model;
-- failed/disconnected generations still count, so retries cannot evade the cap.
CREATE TABLE IF NOT EXISTS public.search_daily_usage (
  day date PRIMARY KEY,
  requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0)
);
ALTER TABLE public.search_daily_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.search_daily_usage FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.search_daily_budget(p_limit integer, p_reserve boolean DEFAULT false)
RETURNS TABLE(allowed boolean, remaining integer, resets_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  today date := (now() AT TIME ZONE 'America/Vancouver')::date;
  used integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 0 THEN
    RAISE EXCEPTION 'Invalid search daily limit';
  END IF;
  IF p_reserve AND p_limit > 0 THEN
    INSERT INTO public.search_daily_usage AS usage (day, requests)
      VALUES (today, 1)
      ON CONFLICT (day) DO UPDATE SET requests = usage.requests + 1
        WHERE usage.requests < p_limit
      RETURNING requests INTO used;
    IF NOT FOUND THEN
      RETURN QUERY SELECT false, 0, ((today + 1)::timestamp AT TIME ZONE 'America/Vancouver');
      RETURN;
    END IF;
    -- The last available reservation is allowed even though remaining becomes 0.
    RETURN QUERY SELECT true, greatest(0, p_limit - used), ((today + 1)::timestamp AT TIME ZONE 'America/Vancouver');
  ELSE
    SELECT requests INTO used FROM public.search_daily_usage WHERE day = today;
    RETURN QUERY SELECT coalesce(used, 0) < p_limit,
      greatest(0, p_limit - coalesce(used, 0)),
      ((today + 1)::timestamp AT TIME ZONE 'America/Vancouver');
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.search_daily_budget(integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_daily_budget(integer, boolean) TO service_role;
