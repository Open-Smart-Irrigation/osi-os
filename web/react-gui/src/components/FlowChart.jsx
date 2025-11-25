import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  AreaChart
} from 'recharts'

function FlowChart({ data }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id="colorFlow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#10b981" stopOpacity={0.8} />
            <stop offset="95%" stopColor="#10b981" stopOpacity={0.1} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
        <XAxis
          dataKey="time"
          stroke="#9ca3af"
          tick={{ fill: '#9ca3af' }}
        />
        <YAxis
          stroke="#9ca3af"
          tick={{ fill: '#9ca3af' }}
          label={{ value: 'Flow (L/h)', angle: -90, position: 'insideLeft', fill: '#9ca3af' }}
          domain={[0, 'auto']}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: '#1f2937',
            border: '1px solid #374151',
            borderRadius: '8px',
            color: '#f9fafb'
          }}
          formatter={(value) => [`${value.toFixed(2)} L/h`, 'Water Flow']}
        />
        <Area
          type="monotone"
          dataKey="flow"
          stroke="#10b981"
          strokeWidth={2}
          fillOpacity={1}
          fill="url(#colorFlow)"
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

export default FlowChart
