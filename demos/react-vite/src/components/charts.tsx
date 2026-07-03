import { useId, useMemo } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type ChartPoint = {
  x: number;
  y: number;
};

type LineChartProps = {
  title: string;
  points: ChartPoint[];
  xLabel: string;
  yLabel: string;
  color?: string;
  formatX?: (value: number) => string;
  formatY?: (value: number) => string;
  emptyMessage?: string;
  embedded?: boolean;
};

type BarChartProps = {
  title: string;
  values: number[];
  color?: string;
  formatValue?: (value: number) => string;
  emptyMessage?: string;
  embedded?: boolean;
};

const CHART_AXIS = {
  stroke: 'rgba(159, 176, 208, 0.35)',
  tick: { fill: '#9fb0d0', fontSize: 11, fontFamily: 'IBM Plex Mono, ui-monospace, monospace' },
};

function defaultFormat(value: number): string {
  return value.toFixed(1);
}

function ChartTooltip({
  active,
  payload,
  label,
  formatX,
  formatY,
  xLabel,
  yLabel,
}: {
  active?: boolean;
  payload?: Array<{ value?: number }>;
  label?: string | number;
  formatX: (value: number) => string;
  formatY: (value: number) => string;
  xLabel: string;
  yLabel: string;
}) {
  if (!active || !payload?.length || payload[0].value == null) return null;

  const xValue = typeof label === 'number' ? label : Number(label);

  return (
    <div className="chart-tooltip">
      <div>
        {xLabel}: {Number.isFinite(xValue) ? formatX(xValue) : label}
      </div>
      <div>
        {yLabel}: {formatY(payload[0].value)}
      </div>
    </div>
  );
}

export function LineChart({
  title,
  points,
  xLabel,
  yLabel,
  color = '#8fa1ff',
  formatX = defaultFormat,
  formatY = defaultFormat,
  emptyMessage = 'No samples yet.',
  embedded = false,
}: LineChartProps) {
  const gradientId = `line-chart-gradient-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const data = useMemo(
    () => points.map((point) => ({ x: point.x, y: point.y })),
    [points]
  );

  return (
    <figure className={`chart ${embedded ? 'chart-embedded' : ''}`}>
      <figcaption className="chart-title">{title}</figcaption>
      {data.length > 0 ? (
        <div className="chart-container">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(159, 176, 208, 0.14)" />
              <XAxis
                dataKey="x"
                axisLine={CHART_AXIS}
                tickLine={false}
                tick={CHART_AXIS.tick}
                tickFormatter={formatX}
                label={{ value: xLabel, position: 'insideBottom', offset: -2, fill: '#9fb0d0', fontSize: 11 }}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={CHART_AXIS.tick}
                tickFormatter={formatY}
                width={56}
                label={{
                  value: yLabel,
                  angle: -90,
                  position: 'insideLeft',
                  fill: '#9fb0d0',
                  fontSize: 11,
                }}
              />
              <Tooltip
                content={
                  <ChartTooltip formatX={formatX} formatY={formatY} xLabel={xLabel} yLabel={yLabel} />
                }
              />
              <Area
                type="monotone"
                dataKey="y"
                stroke={color}
                fill={`url(#${gradientId})`}
                strokeWidth={2.5}
                dot={{ r: 2.5, fill: color, stroke: '#0b1220', strokeWidth: 1.5 }}
                activeDot={{ r: 4, fill: color, stroke: '#0b1220', strokeWidth: 1.5 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="muted chart-empty">{emptyMessage}</p>
      )}
    </figure>
  );
}

export function BarChart({
  title,
  values,
  color = '#57d39a',
  formatValue = defaultFormat,
  emptyMessage = 'No samples yet.',
  embedded = false,
}: BarChartProps) {
  const data = useMemo(
    () => values.map((value, index) => ({ sample: index + 1, value })),
    [values]
  );

  return (
    <figure className={`chart ${embedded ? 'chart-embedded' : ''}`}>
      <figcaption className="chart-title">{title}</figcaption>
      {data.length > 0 ? (
        <div className="chart-container">
          <ResponsiveContainer width="100%" height={220}>
            <RechartsBarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(159, 176, 208, 0.14)" />
              <XAxis
                dataKey="sample"
                axisLine={CHART_AXIS}
                tickLine={false}
                tick={CHART_AXIS.tick}
                label={{ value: 'Sample #', position: 'insideBottom', offset: -2, fill: '#9fb0d0', fontSize: 11 }}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={CHART_AXIS.tick}
                tickFormatter={formatValue}
                width={56}
              />
              <Tooltip
                content={
                  <ChartTooltip
                    formatX={(value) => `#${Math.round(value)}`}
                    formatY={formatValue}
                    xLabel="Sample"
                    yLabel="Value"
                  />
                }
              />
              <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} maxBarSize={28} />
            </RechartsBarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="muted chart-empty">{emptyMessage}</p>
      )}
    </figure>
  );
}
