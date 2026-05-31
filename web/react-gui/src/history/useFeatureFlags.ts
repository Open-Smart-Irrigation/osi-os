import useSWR from 'swr';
import { systemAPI, type SystemFeatureFlags } from '../services/api';

export const defaultHistoryFeatureFlags: SystemFeatureFlags = {
  historyUxEnabled: false,
  historyComparisonEnabled: false,
  historyWorkspacesEnabled: false,
  historyAdvancedOverlaysEnabled: false,
  historyCloudAiEnabled: false,
};

export function useFeatureFlags() {
  const { data, error, isLoading, mutate } = useSWR<SystemFeatureFlags>(
    '/api/system/features',
    () => systemAPI.getFeatures(),
    {
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  );

  const flags = data ?? defaultHistoryFeatureFlags;

  return {
    flags,
    historyEnabled: Boolean(data?.historyUxEnabled),
    isLoading,
    isReady: Boolean(data),
    isUnavailable: Boolean(error) || !data?.historyUxEnabled,
    error,
    retry: () => mutate(),
  };
}
