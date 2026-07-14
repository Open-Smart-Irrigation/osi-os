// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { supportRequestsAPI } from '../../services/api';
import { SupportRequests } from '../SupportRequests';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        'title': 'Support & Requests',
        'backToDashboard': 'Back to dashboard',
        'form.stepRequest': '1. Request text',
        'form.stepArea': '2. Area and severity',
        'form.stepDiagnostics': '3. Diagnostics and consent',
        'form.summary': 'Short title',
        'form.contactEmail': 'Contact email (optional)',
        'form.description': 'What should be improved?',
        'form.requestType': 'Request type',
        'form.area': 'Area',
        'form.severity': 'Severity',
        'form.diagnostics': 'Diagnostics preview',
        'form.includeDiagnostics': 'Include safe diagnostics with this request.',
        'form.consentPublic': 'I agree this request may be shared publicly without private farm details.',
        'form.submit': 'Save request',
        'form.submitting': 'Saving...',
        'status.QUEUED': 'Saved, waiting for internet',
        'status.SUBMITTED': 'Submitted',
        'status.TRIAGED': 'Being reviewed',
        'status.AWAITING_PUBLISH': 'Waiting to publish',
        'status.ISSUE_OPEN': 'Issue open',
        'status.NEEDS_INFO': 'Needs more information',
        'status.ISSUE_ONLY': 'Saved as issue',
        'status.REJECTED': 'Rejected',
        'status.RATE_LIMITED': 'Rate limited',
        'status.DUPLICATE_OF': 'Duplicate',
        'status.PUBLISHING': 'Publishing',
        'status.PUBLISH_BLOCKED_CONFIG': 'Publishing blocked',
        'status.PUBLISH_BLOCKED_SECRET': 'Publishing blocked',
        'status.PR_OPEN': 'In progress',
        'status.UNKNOWN': 'Status update received',
        'myRequests.title': 'My Requests',
        'empty': 'No requests yet.',
        'diagnostics.gateway': 'Gateway',
        'diagnostics.sync': 'Sync',
        'diagnostics.errors': 'Recent errors',
        'banners.retryable': 'Could not send right now. The request can be retried.',
      };
      return labels[key] ?? key;
    },
  }),
}));

vi.mock('../../services/api', () => ({
  supportRequestsAPI: {
    list: vi.fn(),
    diagnosticsPreview: vi.fn(),
    create: vi.fn(),
  },
  getApiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

const diagnosticsPreview = {
  generated_at: '2026-07-08T10:00:00Z',
  diagnostics: {
    gateway_identity: {
      gateway_device_eui: '0016C001F11715E2',
      gateway_device_eui_redacted: '0016...15E2',
      source: 'uci',
    },
    build: {
      firmware_version: '2026.07-stage0',
    },
    gui: {
      current_route: '/support-requests',
    },
    credentials: {
      contact_email: 'farmer@example.com',
      authorization: 'Bearer edge-access-token-secret',
      app_key: '00112233445566778899AABBCCDDEEFF',
      note: 'password: super-secret',
    },
    sync: {
      linked: true,
      pending_events: 2,
      last_success_at: '2026-07-08T09:54:00Z',
    },
    recent_errors: [
      { source: 'sync', message: 'Last sync was interrupted', occurred_at: '2026-07-08T09:58:00Z' },
    ],
  },
};

function request(overrides: Record<string, unknown> = {}) {
  return {
    request_id: 'local-1',
    title: 'Valve schedule request',
    description_preview: 'Make it easier to tune valve schedules.',
    type: 'improvement',
    area: 'watering',
    severity: 'workaround',
    local_status: 'QUEUED',
    cloud_status: null,
    cloud_reason: null,
    cloud_human_message: null,
    released_version: null,
    submitted_at: '2026-07-08T10:00:00Z',
    last_status_at: null,
    updated_at: '2026-07-08T10:00:00Z',
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <SupportRequests />
    </MemoryRouter>,
  );
}

function fillValidRequest() {
  fireEvent.change(screen.getByLabelText('Short title'), {
    target: { value: 'Valve schedule request' },
  });
  fireEvent.change(screen.getByLabelText('What should be improved?'), {
    target: { value: 'Make it easier to tune valve schedules.' },
  });
}

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(supportRequestsAPI.list).mockResolvedValue([]);
  vi.mocked(supportRequestsAPI.diagnosticsPreview).mockResolvedValue(diagnosticsPreview as any);
  vi.mocked(supportRequestsAPI.create).mockResolvedValue({
    request_id: 'local-1',
    local_status: 'QUEUED',
  } as any);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SupportRequests', () => {
  it('renders three request steps', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Support & Requests' })).toBeInTheDocument();
    expect(screen.getByText('1. Request text')).toBeInTheDocument();
    expect(screen.getByText('2. Area and severity')).toBeInTheDocument();
    expect(screen.getByText('3. Diagnostics and consent')).toBeInTheDocument();
  });

  it('keeps submit disabled until public consent is checked', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Support & Requests' });

    fillValidRequest();
    const submit = screen.getByRole('button', { name: 'Save request' });
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByLabelText('I agree this request may be shared publicly without private farm details.'));
    expect(submit).toBeEnabled();
  });

  it('renders diagnostics preview without raw secrets', async () => {
    renderPage();

    expect(await screen.findByText('Diagnostics preview')).toBeInTheDocument();
    expect(screen.getByText('0016...15E2')).toBeInTheDocument();
    expect(screen.queryByText('0016C001F11715E2')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('0016C001F11715E2');
    expect(document.body).not.toHaveTextContent('farmer@example.com');
    expect(document.body).not.toHaveTextContent('Bearer edge-access-token-secret');
    expect(document.body).not.toHaveTextContent('00112233445566778899AABBCCDDEEFF');
    expect(document.body).not.toHaveTextContent('super-secret');
    expect(document.body).toHaveTextContent('[REDACTED_EMAIL]');
    expect(document.body).toHaveTextContent('[REDACTED_BEARER_TOKEN]');
    expect(document.body).toHaveTextContent('[REDACTED_APPKEY]');
    expect(document.body).toHaveTextContent('password=[REDACTED_SECRET]');
  });

  it('sends diagnostics consent as false when the checkbox is unchecked', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Support & Requests' });

    fillValidRequest();
    fireEvent.click(screen.getByLabelText('Include safe diagnostics with this request.'));
    fireEvent.click(screen.getByLabelText('I agree this request may be shared publicly without private farm details.'));
    fireEvent.click(screen.getByRole('button', { name: 'Save request' }));

    await waitFor(() => {
      expect(supportRequestsAPI.create).toHaveBeenCalledWith(expect.objectContaining({
        consent_diagnostics: false,
      }));
    });
  });

  it('sends trimmed optional contact email when provided', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Support & Requests' });

    fillValidRequest();
    fireEvent.change(screen.getByLabelText('Contact email (optional)'), {
      target: { value: '  grower@example.com  ' },
    });
    fireEvent.click(screen.getByLabelText('I agree this request may be shared publicly without private farm details.'));
    fireEvent.click(screen.getByRole('button', { name: 'Save request' }));

    await waitFor(() => {
      expect(supportRequestsAPI.create).toHaveBeenCalledWith(expect.objectContaining({
        contact_email: 'grower@example.com',
      }));
    });
  });

  it('stores the returned status secret by request id after submit', async () => {
    vi.mocked(supportRequestsAPI.create).mockResolvedValue({
      request_id: 'local-secret-1',
      local_status: 'QUEUED',
      status_secret: 'edge-status-secret',
    } as any);

    renderPage();
    await screen.findByRole('heading', { name: 'Support & Requests' });

    fillValidRequest();
    fireEvent.click(screen.getByLabelText('I agree this request may be shared publicly without private farm details.'));
    fireEvent.click(screen.getByRole('button', { name: 'Save request' }));

    await waitFor(() => {
      expect(window.localStorage.getItem('osi.support.statusSecret.local-secret-1')).toBe('edge-status-secret');
    });
  });

  it('shows queued and triaged statuses in My Requests after submit', async () => {
    vi.mocked(supportRequestsAPI.list)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        request({ id: 'local-queued', local_status: 'QUEUED', cloud_status: null }),
        request({
          request_id: 'server-triaged',
          local_status: 'SYNCED',
          cloud_status: 'TRIAGED',
          title: 'Improve diagnostics',
        }),
      ] as any);

    renderPage();
    await screen.findByRole('heading', { name: 'Support & Requests' });
    fillValidRequest();
    fireEvent.click(screen.getByLabelText('I agree this request may be shared publicly without private farm details.'));
    fireEvent.click(screen.getByRole('button', { name: 'Save request' }));

    expect(await screen.findByText('Saved, waiting for internet')).toBeInTheDocument();
    expect(screen.getByText('Being reviewed')).toBeInTheDocument();
  });

  it('shows NEEDS_INFO human message without a reply box in Stage 0', async () => {
    vi.mocked(supportRequestsAPI.list).mockResolvedValue([
      request({
        id: 'needs-info',
        request_id: 'needs-info',
        local_status: 'SYNCED',
        cloud_status: 'NEEDS_INFO',
        cloud_human_message: 'Please add the valve label when you next contact support.',
      }),
    ] as any);

    renderPage();

    expect(await screen.findByText('Needs more information')).toBeInTheDocument();
    expect(screen.getByText('Please add the valve label when you next contact support.')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: /reply/i })).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /send reply/i })).not.toBeInTheDocument();
  });

  it('falls back gracefully for unknown cloud statuses', async () => {
    vi.mocked(supportRequestsAPI.list).mockResolvedValue([
      request({
        request_id: 'unknown-status',
        local_status: 'SYNCED',
        cloud_status: 'SURPRISE_STATUS',
      }),
    ] as any);

    renderPage();

    expect(await screen.findByText('Status update received')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Status unavailable');
    expect(document.body).not.toHaveTextContent('status.SURPRISE_STATUS');
  });

  it('renders normal server cloud states with intentional labels', async () => {
    const serverStatusCases = [
      ['submitted', 'SUBMITTED', 'Submitted'],
      ['awaiting-publish', 'AWAITING_PUBLISH', 'Waiting to publish'],
      ['issue-only', 'ISSUE_ONLY', 'Saved as issue'],
      ['issue-open', 'ISSUE_OPEN', 'Issue open'],
      ['needs-info', 'NEEDS_INFO', 'Needs more information'],
      ['rejected', 'REJECTED', 'Rejected'],
      ['rate-limited', 'RATE_LIMITED', 'Rate limited'],
      ['duplicate-of', 'DUPLICATE_OF', 'Duplicate'],
      ['publishing', 'PUBLISHING', 'Publishing'],
      ['publish-blocked-config', 'PUBLISH_BLOCKED_CONFIG', 'Publishing blocked'],
      ['publish-blocked-secret', 'PUBLISH_BLOCKED_SECRET', 'Publishing blocked'],
    ] as const;

    vi.mocked(supportRequestsAPI.list).mockResolvedValue(
      serverStatusCases.map(([requestId, cloudStatus]) =>
        request({
          request_id: requestId,
          local_status: 'SYNCED',
          cloud_status: cloudStatus,
        }),
      ) as any,
    );

    renderPage();

    const expectedLabelCounts = new Map<string, number>();
    for (const [, , label] of serverStatusCases) {
      expectedLabelCounts.set(label, (expectedLabelCounts.get(label) ?? 0) + 1);
    }
    for (const [label, count] of expectedLabelCounts) {
      expect(await screen.findAllByText(label)).toHaveLength(count);
    }
    expect(document.body).not.toHaveTextContent('Status update received');
  });

  it('renders valid workflow cloud statuses with their labels', async () => {
    vi.mocked(supportRequestsAPI.list).mockResolvedValue([
      request({
        request_id: 'pr-open',
        local_status: 'SYNCED',
        cloud_status: 'PR_OPEN',
      }),
    ] as any);

    renderPage();

    expect(await screen.findByText('In progress')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('Status unavailable');
  });
});
