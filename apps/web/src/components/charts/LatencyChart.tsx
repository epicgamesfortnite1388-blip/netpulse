import { Area, AreaChart, ResponsiveContainer, Tooltip as RTooltip, YAxis } from 'recharts';

/** Live latency sparkline fed by polled /network/status samples. */
export function LatencyChart({ data, height = 120 }: { data: { t: number; ms: number | null }[]; height?: number }) {
  const points = data.map((d, i) => ({ ...d, idx: i }));
  const hasData = points.some((p) => p.ms != null);

  return (
    <div style={{ height }}>
      {!hasData ? (
        <div className="flex h-full items-center justify-center text-xs text-faint">
          Collecting latency samples…
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
            <defs>
              <linearGradient id="latencyFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#22d3ee" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <YAxis domain={[0, 'auto']} hide />
            <RTooltip
              contentStyle={{
                background: '#121b29',
                border: '1px solid rgba(148,163,184,0.22)',
                borderRadius: 10,
                fontSize: 12,
                color: '#e8eef6',
              }}
              labelFormatter={() => ''}
              formatter={(value) => [`${Number(value).toFixed(1)} ms`, 'Latency']}
            />
            <Area
              type="monotone"
              dataKey="ms"
              stroke="#22d3ee"
              strokeWidth={1.8}
              fill="url(#latencyFill)"
              isAnimationActive={false}
              connectNulls
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
