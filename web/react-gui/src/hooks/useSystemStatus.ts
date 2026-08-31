import { useEffect, useState } from 'react';
import { systemAPI, type SystemStats } from '../services/api';

const POLL_INTERVAL_MS = 30_000;

export function useSystemStatus(): SystemStats | null {
  const [stats, setStats] = useState<SystemStats | null>(null);

  useEffect(() => {
    let mounted = true;
    let requestInFlight = false;

    const fetchStats = async () => {
      if (requestInFlight) return;
      requestInFlight = true;

      try {
        const nextStats = await systemAPI.getStats();
        if (mounted) setStats(nextStats);
      } catch {
        // Keep the last successful response while the local API is unavailable.
      } finally {
        requestInFlight = false;
      }
    };

    void fetchStats();
    const interval = window.setInterval(() => void fetchStats(), POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, []);

  return stats;
}
