import { Activity, CircleAlert, Cpu, HardDrive, LoaderCircle, Radio, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { builderApi, BuilderApiError, openJobEventStream } from './api.js';
import { BuildForm } from './components/BuildForm.js';
import { JobDetailPanel } from './components/JobDetail.js';
import { QueueTable } from './components/QueueTable.js';
import type {
  AcceptedJob,
  BranchSnapshot,
  BuilderConfig,
  ConnectionState,
  EvidenceDocument,
  HealthSnapshot,
  JobDetail,
  JobEvent,
  JobSummary,
  PreflightResult,
  SourceSelection,
  StageName,
} from './types.js';

type FormBusy = 'refresh' | 'preflight' | 'enqueue' | null;
type DetailBusy = 'cancel' | 'recover' | 'retry' | 'recheck' | null;

function errorCode(error: unknown): string {
  return error instanceof BuilderApiError ? error.code : 'UNEXPECTED_UI_ERROR';
}

function selectionFrom(config: BuilderConfig, branches: BranchSnapshot): SourceSelection | null {
  const branch = branches.branches.find((item) => item.name === 'main') ?? branches.branches[0];
  const target = config.targets.find((item) => item.id === 'rpi-5') ?? config.targets[0];
  const root = config.approvedOutputRoots[0];
  if (branch === undefined || target === undefined || root === undefined) return null;
  return {
    branch: branch.name,
    expectedSha: branch.sha,
    targetId: target.id,
    outputRootId: root.id,
  };
}

function mergeEvent(events: readonly JobEvent[], incoming: JobEvent): readonly JobEvent[] {
  if (events.some((item) => item.seq === incoming.seq)) return events;
  return [...events, incoming].sort((left, right) => left.seq - right.seq);
}

export function App() {
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [config, setConfig] = useState<BuilderConfig | null>(null);
  const [branches, setBranches] = useState<BranchSnapshot | null>(null);
  const [jobs, setJobs] = useState<readonly JobSummary[]>([]);
  const [selection, setSelection] = useState<SourceSelection | null>(null);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [accepted, setAccepted] = useState<AcceptedJob | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobDetail | null>(null);
  const [events, setEvents] = useState<readonly JobEvent[]>([]);
  const [evidence, setEvidence] = useState<EvidenceDocument | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('closed');
  const [formBusy, setFormBusy] = useState<FormBusy>(null);
  const [detailBusy, setDetailBusy] = useState<DetailBusy>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date().toISOString());
  const [loading, setLoading] = useState(true);
  const selectedJobIdRef = useRef<string | null>(null);
  selectedJobIdRef.current = selectedJobId;

  const reloadJobs = useCallback(async (): Promise<void> => {
    const page = await builderApi.jobs();
    setJobs(page.jobs);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date().toISOString()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.all([
      builderApi.health(),
      builderApi.config(),
      builderApi.branches(),
      builderApi.jobs(),
    ]).then(([nextHealth, nextConfig, nextBranches, page]) => {
      if (!active) return;
      setHealth(nextHealth);
      setConfig(nextConfig);
      setBranches(nextBranches);
      setJobs(page.jobs);
      setSelection(selectionFrom(nextConfig, nextBranches));
      setSelectedJobId(nextHealth.activeJobId ?? page.jobs[0]?.id ?? null);
      setPageError(null);
    }).catch((error: unknown) => {
      if (active) setPageError(errorCode(error));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (selectedJobId === null) {
      setJob(null);
      setEvents([]);
      setConnection('closed');
      return;
    }

    setJob(null);
    setEvents([]);
    setEvidence(null);
    setConnection('connecting');
    let active = true;
    let stream: ReturnType<typeof openJobEventStream> | null = null;
    const refresh = async (): Promise<void> => {
      try {
        const [nextJob, eventPage] = await Promise.all([
          builderApi.job(selectedJobId),
          builderApi.events(selectedJobId),
        ]);
        if (!active) return;
        setJob(nextJob);
        setEvents(eventPage.events);
        setEvidence(null);
        stream = openJobEventStream({
          jobId: selectedJobId,
          after: eventPage.next,
          onConnection: (state) => {
            if (active) setConnection(state);
          },
          onEvent: (event) => {
            if (!active) return;
            setEvents((current) => mergeEvent(current, event));
            void builderApi.job(selectedJobId).then((detail) => {
              if (active) setJob(detail);
            }).catch((error: unknown) => setPageError(errorCode(error)));
            void reloadJobs().catch((error: unknown) => setPageError(errorCode(error)));
          },
        });
      } catch (error) {
        if (active) {
          setPageError(errorCode(error));
          setConnection('reconnecting');
        }
      }
    };
    void refresh();
    const poller = window.setInterval(() => {
      void builderApi.job(selectedJobId).then((detail) => {
        if (active) setJob(detail);
      }).catch((error: unknown) => setPageError(errorCode(error)));
      void reloadJobs().catch((error: unknown) => setPageError(errorCode(error)));
      void builderApi.health().then(setHealth).catch((error: unknown) => setPageError(errorCode(error)));
    }, 5_000);
    return () => {
      active = false;
      window.clearInterval(poller);
      stream?.close();
    };
  }, [reloadJobs, selectedJobId]);

  const updateSelection = (next: SourceSelection): void => {
    setSelection(next);
    setPreflight(null);
    setAccepted(null);
    setFormError(null);
  };

  const refreshBranches = async (): Promise<void> => {
    if (selection === null) return;
    setFormBusy('refresh');
    setFormError(null);
    try {
      const snapshot = await builderApi.refreshBranches();
      setBranches(snapshot);
      const selected = snapshot.branches.find((item) => item.name === selection.branch)
        ?? snapshot.branches.find((item) => item.name === 'main')
        ?? snapshot.branches[0];
      if (selected === undefined) throw new BuilderApiError({ code: 'NO_REMOTE_BRANCHES', message: 'No branches were returned.', status: 502 });
      updateSelection({ ...selection, branch: selected.name, expectedSha: selected.sha });
    } catch (error) {
      setFormError(errorCode(error));
    } finally {
      setFormBusy(null);
    }
  };

  const runPreflight = async (): Promise<void> => {
    if (selection === null) return;
    setFormBusy('preflight');
    setFormError(null);
    setPreflight(null);
    try {
      setPreflight(await builderApi.preflight(selection));
    } catch (error) {
      setFormError(errorCode(error));
    } finally {
      setFormBusy(null);
    }
  };

  const startBuild = async (): Promise<void> => {
    if (selection === null || preflight === null) return;
    setFormBusy('enqueue');
    setFormError(null);
    try {
      const next = await builderApi.enqueue(selection, preflight.preflightId);
      setAccepted(next);
      setPreflight(null);
      setSelectedJobId(next.id);
      await reloadJobs();
    } catch (error) {
      setFormError(errorCode(error));
    } finally {
      setFormBusy(null);
    }
  };

  const cancelJob = async (jobId: string): Promise<void> => {
    if (!window.confirm('Cancel this build? The image will not be published.')) return;
    setDetailBusy('cancel');
    setPageError(null);
    try {
      const detail = await builderApi.cancel(jobId);
      if (selectedJobIdRef.current === jobId) setJob(detail);
      await reloadJobs();
    } catch (error) {
      setPageError(errorCode(error));
    } finally {
      setDetailBusy(null);
    }
  };

  const recoverJob = async (jobId: string, retry: boolean): Promise<void> => {
    if (!window.confirm('Start cleanup recovery? This never resumes the build.')) return;
    setDetailBusy(retry ? 'retry' : 'recover');
    setPageError(null);
    try {
      const result = await builderApi.recover(jobId, retry);
      if (selectedJobIdRef.current === jobId) setJob('job' in result ? result.job : result);
      await reloadJobs();
    } catch (error) {
      setPageError(errorCode(error));
    } finally {
      setDetailBusy(null);
    }
  };

  const recheckPublish = async (jobId: string): Promise<void> => {
    setDetailBusy('recheck');
    setPageError(null);
    try {
      const detail = await builderApi.recheckPublishBlocker(jobId);
      if (selectedJobIdRef.current === jobId) setJob(detail);
      await reloadJobs();
    } catch (error) {
      setPageError(errorCode(error));
    } finally {
      setDetailBusy(null);
    }
  };

  const loadEvidence = async (jobId: string, stage: StageName): Promise<void> => {
    try {
      const document = await builderApi.evidence(jobId, stage);
      if (selectedJobIdRef.current === jobId) setEvidence(document);
    } catch (error) {
      setPageError(errorCode(error));
    }
  };

  const buildNewer = async (jobId: string): Promise<void> => {
    if (config === null) return;
    setFormBusy('refresh');
    setFormError(null);
    try {
      const [sourceJob, snapshot] = await Promise.all([
        builderApi.job(jobId),
        builderApi.refreshBranches(),
      ]);
      const branch = snapshot.branches.find((item) => item.name === sourceJob.branch);
      if (branch === undefined) throw new BuilderApiError({ code: 'BRANCH_NOT_FOUND', message: 'The branch no longer exists.', status: 404 });
      setBranches(snapshot);
      updateSelection({
        branch: branch.name,
        expectedSha: branch.sha,
        targetId: sourceJob.targetId,
        outputRootId: sourceJob.outputRootId,
      });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      setFormError(errorCode(error));
    } finally {
      setFormBusy(null);
    }
  };

  const activeCount = useMemo(
    () => jobs.filter((item) => !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(item.state)).length,
    [jobs],
  );

  if (loading) {
    return <main className="app-loading"><LoaderCircle className="spin" size={24} aria-hidden="true" />Connecting to local builder</main>;
  }

  if (config === null || branches === null || selection === null) {
    return (
      <main className="app-fatal">
        <CircleAlert size={24} aria-hidden="true" />
        <h1>Firmware builder unavailable</h1>
        <code>{pageError ?? 'BUILDER_CONFIGURATION_UNAVAILABLE'}</code>
        <button className="button button--secondary" type="button" onClick={() => window.location.reload()}>Retry connection</button>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand__mark" aria-hidden="true"><Cpu size={20} /></div>
          <div>
            <h1>OSI image builder</h1>
            <span>Local firmware operations</span>
          </div>
        </div>
        <div className="system-status">
          <span><Radio size={15} aria-hidden="true" />{health?.status === 'ok' ? 'API online' : 'API unknown'}</span>
          <span><Activity size={15} aria-hidden="true" />{activeCount} active</span>
          <span><ShieldCheck size={15} aria-hidden="true" />v{health?.version ?? 'unknown'}</span>
        </div>
      </header>

      {pageError !== null && (
        <div className="global-error" role="alert">
          <CircleAlert size={17} aria-hidden="true" />
          <strong>{pageError}</strong>
          <button type="button" onClick={() => setPageError(null)}>Dismiss</button>
        </div>
      )}

      {accepted !== null && (
        <div className="accepted-strip" role="status">
          <HardDrive size={17} aria-hidden="true" />
          <span>Queued <strong>{accepted.branch}</strong> at the pinned remote SHA.</span>
          <code>{accepted.id}</code>
        </div>
      )}

      <main className="workspace">
        <BuildForm
          branches={branches.branches}
          targets={config.targets}
          roots={config.approvedOutputRoots}
          selection={selection}
          preflight={preflight}
          branchSnapshotAt={branches.fetchedAt}
          now={now}
          busy={formBusy}
          errorCode={formError}
          onSelectionChange={updateSelection}
          onRefreshBranches={() => void refreshBranches()}
          onRunPreflight={() => void runPreflight()}
          onStartBuild={() => void startBuild()}
        />
        <QueueTable
          jobs={jobs}
          selectedJobId={selectedJobId}
          now={now}
          onSelect={setSelectedJobId}
          onCancel={(jobId) => void cancelJob(jobId)}
          onBuildNewer={(jobId) => void buildNewer(jobId)}
        />
        {job !== null && (
          <JobDetailPanel
            job={job}
            events={events}
            connection={connection}
            runnerActive={health?.activeJobId === job.id}
            loadedEvidence={evidence}
            busyAction={detailBusy}
            onCancel={() => void cancelJob(job.id)}
            onRecover={(retry) => void recoverJob(job.id, retry)}
            onRecheckPublish={() => void recheckPublish(job.id)}
            onLoadEvidence={(stage) => void loadEvidence(job.id, stage)}
          />
        )}
      </main>
    </div>
  );
}
