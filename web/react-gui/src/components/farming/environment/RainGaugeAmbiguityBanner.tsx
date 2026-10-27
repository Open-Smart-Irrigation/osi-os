import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { zoneRainSourceAPI } from '../../../services/api';

interface Props {
  zoneId: number;
  canWrite: boolean;
  className?: string;
  /** A change reads the selection again (a saved choice, a refreshed summary). */
  refreshKey?: string | number;
}

/**
 * Two or more rain gauges report for the zone and the operator has not chosen
 * one: the gateway then measures no rain for the zone (it never adds two
 * gauges), so the zone's water card says why and where to choose. Renders
 * nothing while loading, once a gauge is chosen, or when the selection cannot
 * be read.
 */
export const RainGaugeAmbiguityBanner: React.FC<Props> = ({ zoneId, canWrite, className = '', refreshKey }) => {
  const { t } = useTranslation('devices');
  const [ambiguous, setAmbiguous] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAmbiguous(false);
    void (async () => {
      try {
        const source = await zoneRainSourceAPI.get(zoneId);
        if (!cancelled) setAmbiguous(source.state === 'ambiguous');
      } catch {
        // An older gateway without the route, or offline: no banner.
        if (!cancelled) setAmbiguous(false);
      }
    })();
    return () => { cancelled = true; };
  }, [zoneId, refreshKey]);

  if (!ambiguous) return null;
  return (
    <div role="status" className={`rounded-xl border border-[var(--warn-border)] bg-[var(--warn-bg)] px-3 py-2 text-sm text-[var(--warn-text)] ${className}`}>
      {canWrite
        ? t('zoneRainGauge.banner', { defaultValue: 'Two rain gauges report for this zone. Choose one in the zone settings.' })
        : t('zoneRainGauge.bannerReadOnly', {
          defaultValue: 'Ask someone who can edit this zone to choose a rain gauge in zone settings.',
        })}
    </div>
  );
};
