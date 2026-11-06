-- Five-minute readings of the database host's resources (Supabase's metrics endpoint), for the admin home's
-- "Database server" panel. Counters are cumulative since the host booted; the panel charts their differences.
-- Kept 7 days by the Worker that writes them. Service role only.
CREATE TABLE IF NOT EXISTS public.server_metrics (
  sampled_at timestamptz PRIMARY KEY DEFAULT now(),
  mem_total_bytes bigint,
  mem_available_bytes bigint,
  swap_total_bytes bigint,
  swap_free_bytes bigint,
  swap_in_pages bigint,
  swap_out_pages bigint,
  root_read_bytes bigint,
  data_read_bytes bigint,
  data_written_bytes bigint,
  io_stalled_seconds double precision,
  memory_stalled_seconds double precision,
  cpu_busy_seconds double precision,
  cpu_total_seconds double precision,
  database_bytes bigint,
  connections integer
);
ALTER TABLE public.server_metrics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.server_metrics FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.server_metrics TO service_role;
