/** Supabase's Prometheus metrics for the database host, reduced to the numbers the admin home charts. */

export type ServerSample = {
  mem_total_bytes: number | null;
  mem_available_bytes: number | null;
  swap_total_bytes: number | null;
  swap_free_bytes: number | null;
  swap_in_pages: number | null;
  swap_out_pages: number | null;
  root_read_bytes: number | null;
  data_read_bytes: number | null;
  data_written_bytes: number | null;
  io_stalled_seconds: number | null;
  memory_stalled_seconds: number | null;
  cpu_busy_seconds: number | null;
  cpu_total_seconds: number | null;
  database_bytes: number | null;
  connections: number | null;
};

type Line = { name: string; labels: Record<string, string>; value: number };

function lines(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split("\n")) {
    if (!raw || raw.startsWith("#")) continue;
    const m = raw.match(/^([a-zA-Z_:][\w:]*)(\{([^}]*)\})?\s+(\S+)/);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const pair of (m[3] || "").matchAll(/(\w+)="([^"]*)"/g)) labels[pair[1]] = pair[2];
    const value = Number(m[4]);
    if (Number.isFinite(value)) out.push({ name: m[1], labels, value });
  }
  return out;
}

/** The host's root disk holds the OS and swap; /data holds Postgres. */
export function parseServerMetrics(text: string, dataDevice = "nvme1n1", rootDevice = "nvme0n1"): ServerSample {
  const all = lines(text);
  const one = (name: string, match: (l: Record<string, string>) => boolean = () => true) =>
    all.find((l) => l.name === name && match(l.labels))?.value ?? null;
  const sum = (name: string, match: (l: Record<string, string>) => boolean = () => true) => {
    const found = all.filter((l) => l.name === name && match(l.labels));
    return found.length ? found.reduce((s, l) => s + l.value, 0) : null;
  };
  const cpu = all.filter((l) => l.name === "node_cpu_seconds_total");
  const int = (v: number | null) => (v == null ? null : Math.round(v));
  return {
    mem_total_bytes: int(one("node_memory_MemTotal_bytes")),
    mem_available_bytes: int(one("node_memory_MemAvailable_bytes")),
    swap_total_bytes: int(one("node_memory_SwapTotal_bytes")),
    swap_free_bytes: int(one("node_memory_SwapFree_bytes")),
    swap_in_pages: int(one("node_vmstat_pswpin")),
    swap_out_pages: int(one("node_vmstat_pswpout")),
    root_read_bytes: int(one("node_disk_read_bytes_total", (l) => l.device === rootDevice)),
    data_read_bytes: int(one("node_disk_read_bytes_total", (l) => l.device === dataDevice)),
    data_written_bytes: int(one("node_disk_written_bytes_total", (l) => l.device === dataDevice)),
    io_stalled_seconds: one("node_pressure_io_stalled_seconds_total"),
    memory_stalled_seconds: one("node_pressure_memory_stalled_seconds_total"),
    cpu_busy_seconds: cpu.length ? cpu.filter((l) => l.labels.mode !== "idle" && l.labels.mode !== "iowait").reduce((s, l) => s + l.value, 0) : null,
    cpu_total_seconds: cpu.length ? cpu.reduce((s, l) => s + l.value, 0) : null,
    database_bytes: int(one("pg_database_size_bytes", (l) => l.datname === "postgres")),
    connections: int(sum("connection_stats_connection_count")),
  };
}

type Row = ServerSample & { sampled_at: string };
export type ServerPoint = { day: string; value: number };

/** Hourly totals of a counter's increase (a reboot resets counters: that interval is skipped). */
export function hourlyIncrease(rows: Row[], key: keyof ServerSample, scale = 1): ServerPoint[] {
  const hours = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1][key], b = rows[i][key];
    if (a == null || b == null || b < a) continue;
    const hour = rows[i].sampled_at.slice(0, 13) + ":00:00Z";
    hours.set(hour, (hours.get(hour) ?? 0) + (b - a) * scale);
  }
  return [...hours.entries()].sort().map(([day, value]) => ({ day, value: Math.round(value * 10) / 10 }));
}
