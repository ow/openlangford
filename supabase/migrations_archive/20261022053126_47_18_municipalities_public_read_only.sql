-- Preserve public municipality reads; restrict mutations to trusted server roles.
-- Target: zxcvifwkaxtdfpanlwtl / public.municipalities
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Preserve intended public reads and reserve writes for trusted server roles.
REVOKE ALL PRIVILEGES ON TABLE public.municipalities FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.municipalities TO anon, authenticated;
REVOKE ALL PRIVILEGES ON SEQUENCE public.municipalities_id_seq FROM PUBLIC, anon, authenticated;

ALTER TABLE public.municipalities ENABLE ROW LEVEL SECURITY;
-- Safe to replay on the already-corrected production database.
DROP POLICY IF EXISTS municipalities_public_read ON public.municipalities;
CREATE POLICY municipalities_public_read ON public.municipalities
    FOR SELECT TO anon, authenticated USING (true);
COMMIT;
