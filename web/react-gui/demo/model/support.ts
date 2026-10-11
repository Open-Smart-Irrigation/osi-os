import type {SupportRequest, SupportRequestCreateRequest, SupportRequestCreateResponse, SupportDiagnosticsPreview} from '../../src/types/farming';
import type {PublicSystemState} from './system';
import {iso} from '../fixtures';

export interface SupportInboxEntry extends SupportRequestCreateRequest {
  request_id: string;
  local_status: 'QUEUED';
  cloud_status: null;
  submitted_at: string;
  status_secret: string;
}

export function submitSupportRequest(state: PublicSystemState, input: Record<string, unknown>, now: number): SupportRequestCreateResponse {
  const validTypes = ['bug', 'improvement', 'feedback'];
  const validAreas = ['dashboard', 'history', 'analysis', 'copy', 'watering', 'sync', 'devices', 'system', 'other'];
  const validSeverities = ['cant_work', 'workaround', 'annoying', 'idea'];
  const reject = (message: string, detail?: unknown): never => {
    throw Object.assign(new Error(message), {status: 400, code: message, ...(detail === undefined ? {} : {detail})});
  };
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength >= 65_536) {
    throw Object.assign(new Error('Request body must be less than 65536 bytes'), {status: 413, code: 'Request body must be less than 65536 bytes'});
  }
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (title.length < 3 || title.length > 80) reject('Title must be 3-80 characters');
  if (description.length < 10 || description.length > 4000) reject('Description must be 10-4000 characters');
  if (input.consent_public !== true) reject('consent_public must be true');
  for (const [field, values] of [['type', validTypes], ['severity', validSeverities], ['area', validAreas]] as const) {
    if (!values.includes(String(input[field]))) reject(`Invalid ${field}`, {allowed: values});
  }
  const consentDiagnostics = typeof input.consent_diagnostics === 'boolean' ? input.consent_diagnostics : true;
  const email = input.contact_email == null ? '' : String(input.contact_email).trim();
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) reject('Invalid contact_email');
  const id = `demo-support-${String(state.nextSupportRequestId++).padStart(4, '0')}`;
  const entry = {
    ...input,
    type: input.type, title, description,
    area: input.area, severity: input.severity, consent_public: true,
    consent_diagnostics: consentDiagnostics,
    contact_email: email || null,
    request_id: id, local_status: 'QUEUED' as const, cloud_status: null,
    submitted_at: iso(now), status_secret: `demo-only-${id}`,
  } as SupportInboxEntry;
  state.supportInbox.push(entry);
  return {request_id: id, local_status: 'QUEUED', status_secret: entry.status_secret};
}

export function listSupportRequests(state: PublicSystemState): SupportRequest[] {
  return state.supportInbox.map(entry => ({
    request_id: entry.request_id, type: entry.type, title: entry.title,
    contact_email: entry.contact_email ?? null, description_preview: entry.description,
    area: entry.area, severity: entry.severity, local_status: entry.local_status,
    cloud_status: entry.cloud_status, submitted_at: entry.submitted_at,
    last_status_at: entry.submitted_at, updated_at: entry.submitted_at,
  }));
}

export function diagnosticsPreview(route: string | null, now: number, gatewayTimezone: string, zones: number, devices: number): SupportDiagnosticsPreview {
  return {generated_at: iso(now), diagnostics: {
    demo_mode: true, route: route?.startsWith('/') ? route : '/', gateway_timezone: gatewayTimezone,
    zone_count: zones, device_count: devices, simulated_at: iso(now),
  }};
}
