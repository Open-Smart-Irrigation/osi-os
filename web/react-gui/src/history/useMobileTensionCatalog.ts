import { useCallback, useEffect, useRef } from 'react';
import useSWR from 'swr';
import axios from 'axios';
import {
  HistoryAuthError,
  HistoryAbortError,
  MobileHistoryError,
  mobileHistoryFailureError,
  MobileAnalysisValidationError,
} from '@osi/history-uplot';
import type { AnalysisCatalogResponse } from '../analysis/types';
import { analysisAPI } from '../services/api';
import { initialMobileTensionSelection, normalizeMobileTensionCatalog } from './mobileMeasurementCatalog';
import { toMobileFailureInput } from './mobileAnalysisHistoryAdapter';
import type { MobileTensionSource } from '@osi/history-uplot';

export interface MobileTensionCatalogOptions {
  enabled: boolean;
  zoneId: string;
  sessionKey: string;
}

function toCatalogError(error: unknown): MobileHistoryError | HistoryAuthError {
  if (error instanceof MobileHistoryError || error instanceof HistoryAuthError) return error;
  if (error instanceof MobileAnalysisValidationError) return mobileHistoryFailureError(error);
  if (axios.isAxiosError(error)) return mobileHistoryFailureError(toMobileFailureInput(error), error);
  const reason = error instanceof Error && error.message ? error.message : 'unexpected mobile Analysis failure';
  return new MobileHistoryError({ kind: 'protocol', code: 'http-error', reason }, error);
}

function isAxiosCancellation(error: unknown): boolean {
  return axios.isCancel(error) || (axios.isAxiosError(error) && error.code === 'ERR_CANCELED');
}

export function useMobileTensionCatalog(options: MobileTensionCatalogOptions): {
  sources: readonly MobileTensionSource[];
  defaultSelectedIds: readonly string[];
  error: MobileHistoryError | HistoryAuthError | null;
  isLoading: boolean;
  refreshForGeneration(generation: number): Promise<void>;
} {
  const key = options.enabled ? ['mobile-tension-catalog', 'edge', options.sessionKey, options.zoneId] as const : null;
  const generationKey = `${options.sessionKey}|${options.zoneId}`;
  const generations = useRef(new Set<number>());
  const generationKeyRef = useRef(generationKey);
  const { data, error, isLoading, mutate } = useSWR<readonly MobileTensionSource[], unknown>(
    key,
    async () => {
      try {
        const response: AnalysisCatalogResponse = await analysisAPI.getChannels();
        return normalizeMobileTensionCatalog(response, options.zoneId);
      } catch (cause) {
        if (cause instanceof HistoryAbortError || isAxiosCancellation(cause)) throw cause;
        throw toCatalogError(cause);
      }
    },
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  useEffect(() => {
    if (generationKeyRef.current !== generationKey) {
      generationKeyRef.current = generationKey;
      generations.current = new Set();
    }
  }, [generationKey]);

  const refreshForGeneration = useCallback(async (generation: number) => {
    if (!options.enabled) return;
    if (generationKeyRef.current !== generationKey) {
      generationKeyRef.current = generationKey;
      generations.current = new Set();
    }
    if (generations.current.has(generation)) return;
    generations.current.add(generation);
    await mutate();
  }, [generationKey, mutate, options.enabled]);

  const sources = data ?? [];
  const defaultSelectedIds = initialMobileTensionSelection(sources, options.zoneId, undefined).selectedIds;
  return {
    sources,
    defaultSelectedIds,
    error: error && !isAxiosCancellation(error) && !(error instanceof HistoryAbortError) ? toCatalogError(error) : null,
    isLoading,
    refreshForGeneration,
  };
}
