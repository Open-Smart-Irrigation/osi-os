import { useMemo, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnalysisSeries } from '../../analysis/types';
import { computeCorrelation, zonePairs } from '../../analysis/correlation';
import { buildCorrelationOption } from '../../analysis/echartsOptions';
import { axisLabel, type ChannelMeta } from '../../analysis/channelLabels';
import { canonicalize } from '../../channels/registry';
import { EChart, type EChartHandle } from './EChart';

type AnalysisTranslate = (key: string, options?: Record<string, unknown>) => string;

interface CorrelationPanelProps {
  series: AnalysisSeries[];
  channelMeta: ChannelMeta;
  zoneNameById?: Map<number, string>;
  chartRef?: Ref<EChartHandle>;
}

function distinctChannels(series: AnalysisSeries[]): string[] {
  const seen: string[] = [];
  for (const s of series) {
    const channelKey = canonicalize(s.resolved.channelKey);
    if (!seen.includes(channelKey)) seen.push(channelKey);
  }
  return seen;
}

export function CorrelationPanel({ series, channelMeta, zoneNameById, chartRef }: CorrelationPanelProps) {
  const { t: translate } = useTranslation();
  const t = translate as AnalysisTranslate;
  const channels = useMemo(() => distinctChannels(series), [series]);
  const [channelX, setChannelX] = useState(channels[0] ?? '');
  const [channelY, setChannelY] = useState(channels.find((c) => c !== channels[0]) ?? '');
  const [pooled, setPooled] = useState(false);

  const canonicalChannelX = canonicalize(channelX);
  const canonicalChannelY = canonicalize(channelY);
  const x = channels.includes(canonicalChannelX) ? canonicalChannelX : channels[0] ?? '';
  const y = channels.includes(canonicalChannelY) && canonicalChannelY !== x
    ? canonicalChannelY
    : channels.find((c) => c !== x) ?? '';

  const pairs = useMemo(() => (x && y ? zonePairs(series, x, y, zoneNameById) : []), [series, x, y, zoneNameById]);
  const result = useMemo(
    () => (x && y ? computeCorrelation(series, x, y, { pooled, zoneNames: zoneNameById }) : { groups: [], pooled: null }),
    [series, x, y, pooled, zoneNameById],
  );
  const option = useMemo(
    () => buildCorrelationOption({
      zonePairs: pairs,
      channelXLabel: axisLabel(x, channelMeta),
      channelYLabel: axisLabel(y, channelMeta),
    }),
    [pairs, x, y, channelMeta],
  );

  if (channels.length < 2) {
    return (
      <div className="flex min-h-[320px] items-center justify-center rounded-md border border-dashed border-slate-300 bg-white px-4 text-center text-sm text-slate-600">
        {t('analysis.correlation.needTwoChannels')}
      </div>
    );
  }

  const rows = [...result.groups, ...(result.pooled ? [result.pooled] : [])];

  return (
    <div className="analysis-correlation flex h-full min-h-[500px] flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 bg-white p-3">
        <label className="flex min-w-44 flex-col gap-1 text-xs font-medium text-slate-600">
          {t('analysis.correlation.x')}
          <select
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-950"
            value={x}
            onChange={(e) => setChannelX(canonicalize(e.target.value))}
          >
            {channels.map((c) => <option key={c} value={c}>{axisLabel(c, channelMeta)}</option>)}
          </select>
        </label>
        <label className="flex min-w-44 flex-col gap-1 text-xs font-medium text-slate-600">
          {t('analysis.correlation.y')}
          <select
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-950"
            value={y}
            onChange={(e) => setChannelY(canonicalize(e.target.value))}
          >
            {channels.map((c) => (
              <option key={c} value={c} disabled={c === x}>{axisLabel(c, channelMeta)}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={pooled}
            onChange={(e) => setPooled(e.target.checked)}
            title={t('analysis.pooled.tooltip')}
          />
          {t('analysis.correlation.pooled')}
        </label>
      </div>

      <div className="min-h-[320px] flex-1 rounded-md border border-slate-200 bg-white p-2">
        <EChart ref={chartRef} option={option} className="h-full min-h-[320px]" />
      </div>

      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-100 text-xs uppercase text-slate-600">
            <tr>
              <th className="px-3 py-2 font-semibold">{t('analysis.correlation.zone')}</th>
              <th className="px-3 py-2 font-semibold">n</th>
              <th className="px-3 py-2 font-semibold">{t('analysis.correlation.droppedPairs')}</th>
              <th className="px-3 py-2 font-semibold">r</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {rows.map((group) => (
              <tr key={group.zoneId ?? 'pooled'}>
                <td className="px-3 py-2 font-medium text-slate-900">{group.label}</td>
                <td className="px-3 py-2 text-slate-700">{group.n}</td>
                <td className="px-3 py-2 text-slate-700">{group.droppedPairs}</td>
                <td className="px-3 py-2 text-slate-700">
                  {group.suppressed
                    ? t('analysis.correlation.insufficient', { n: group.n })
                    : group.r?.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">{t('analysis.correlation.exploratory')}</p>
    </div>
  );
}
