const W = 208;
const H = 36;

const plural = (n: number) => `${n} ${n === 1 ? "record" : "records"}`;

/** Council records per year at an address or street, as small bars; the busiest year is called out. */
export function RecordsSparkline({ data }: { data: { year: number; count: number }[] }) {
  if (data.length < 2) return null;
  const peak = data.reduce((a, b) => (b.count > a.count ? b : a));
  const step = W / data.length;
  const gap = Math.min(2, step * 0.25);
  const summary = `Council records per year, ${data[0].year} to ${data.at(-1)!.year}. Busiest year ${peak.year} with ${plural(peak.count)}.`;
  return (
    <figure className="w-52">
      <figcaption className="mb-1 flex items-baseline justify-between gap-2 whitespace-nowrap text-xs text-zinc-500">
        <span>Records by year</span>
        <span className="tabular-nums">
          Peak <span className="font-semibold text-zinc-800">{peak.year}</span> ({peak.count})
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block" role="img" aria-label={summary}>
        <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} strokeWidth={1} className="stroke-zinc-200" />
        {data.map((d, i) => {
          const h = d.count ? Math.max(2, (d.count / peak.count) * (H - 2)) : 0;
          return (
            <g key={d.year}>
              <title>{`${d.year}: ${plural(d.count)}`}</title>
              <rect x={i * step} y={0} width={step} height={H} fill="transparent" />
              {h > 0 && (
                <rect
                  x={i * step + gap / 2}
                  y={H - h}
                  width={step - gap}
                  height={h}
                  rx={1}
                  className={d.year === peak.year ? "fill-brand-600" : "fill-brand-300"}
                />
              )}
            </g>
          );
        })}
      </svg>
      <div className="mt-0.5 flex justify-between text-[11px] tabular-nums text-zinc-400">
        <span>{data[0].year}</span>
        <span>{data.at(-1)!.year}</span>
      </div>
    </figure>
  );
}
