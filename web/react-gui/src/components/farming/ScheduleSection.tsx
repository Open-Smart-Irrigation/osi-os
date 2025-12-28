import React, { useState } from 'react';
import type { Schedule, ScheduleMetric } from '../../types/farming';

interface ScheduleSectionProps {
  zoneId: number;
  zoneName: string;
}

export const ScheduleSection: React.FC<ScheduleSectionProps> = ({ zoneId, zoneName }) => {
  const [schedule, setSchedule] = useState<Schedule>({
    metric: 'swt_wm1',
    threshold: 30,
  });

  const handleMetricChange = (metric: ScheduleMetric) => {
    setSchedule({ ...schedule, metric });
  };

  const handleThresholdChange = (threshold: number) => {
    setSchedule({ ...schedule, threshold });
  };

  return (
    <div className="bg-slate-800 rounded-lg p-4 mb-4">
      <h4 className="text-white text-lg font-bold mb-3">Irrigation Schedule (Preview)</h4>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Metric Selector */}
        <div>
          <label className="block text-slate-300 text-sm font-semibold mb-2">
            Trigger Metric
          </label>
          <select
            value={schedule.metric}
            onChange={(e) => handleMetricChange(e.target.value as ScheduleMetric)}
            className="w-full px-3 py-2 bg-slate-700 border-2 border-slate-600 rounded-lg text-white focus:outline-none focus:border-farm-green focus:ring-2 focus:ring-farm-green/50"
          >
            <option value="swt_wm1">Soil Water Tension 1</option>
            <option value="swt_wm2">Soil Water Tension 2</option>
            <option value="average">Average (WM1 + WM2)</option>
          </select>
        </div>

        {/* Threshold Input */}
        <div>
          <label className="block text-slate-300 text-sm font-semibold mb-2">
            Threshold (kPa)
          </label>
          <input
            type="number"
            value={schedule.threshold}
            onChange={(e) => handleThresholdChange(Number(e.target.value))}
            min="0"
            max="200"
            className="w-full px-3 py-2 bg-slate-700 border-2 border-slate-600 rounded-lg text-white focus:outline-none focus:border-farm-green focus:ring-2 focus:ring-farm-green/50"
          />
        </div>
      </div>

      <div className="mt-3 text-slate-400 text-xs">
        Note: Scheduling is not yet active. This is a preview of future functionality.
      </div>
    </div>
  );
};
