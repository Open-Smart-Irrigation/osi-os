'use strict';
// Test-only semantic oracle. This is not a production session/token verifier.
const clone = value => structuredClone(value);
function merge(base, patch) {
  const out = clone(base);
  for (const [key, value] of Object.entries(patch || {})) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(out[key] || {}, value) : clone(value);
  }
  return out;
}
const deny = reason => ({ decision: 'deny', reason, effects: 0 });
const allow = (effects = 1, reason = 'authorized') => ({ decision: 'allow', reason, effects });
function sessionDecision(input) {
  const reject = reason => ({ ...deny(reason), http_status: 401 });
  const { session: s, current: c, actor, now_ms: now, clock_high_water_ms: high } = input;
  if (!s.signature_valid) return reject('session_invalid');
  if (s.account_uuid !== c.account_uuid || s.installation !== c.installation || s.link_incarnation !== c.link_incarnation) return reject('session_context_mismatch');
  // CTO R5: generation mismatch denies before any clock treatment.
  if (s.generation !== c.generation) return reject('session_revoked');
  if (!actor.enabled) return reject('account_disabled');
  const clock = Math.max(now, high);
  if (!Number.isFinite(s.exp_ms) || s.exp_ms <= 0 || clock >= s.exp_ms) return reject('session_expired');
  return allow(0);
}
const READS = new Set(['read_history', 'read_analysis', 'read_csv', 'read_catalog', 'policy_decisions_read', 'sensor_download']);
const PRIVILEGED = new Set(['admin_accounts', 'system_settings', 'account_link', 'account_unlink', 'force_sync', 'outbox_recovery', 'rollup_run', 'gateway_location_write']);
function authorize(input) {
  const { actor: a, resource: r, policies: p, action, origin, scoped_access: scoped } = input;
  if (action === 'public_features') return allow(0);
  if (!r.authority_store_available) return { ...deny('authority_unavailable'), http_status: 503, command_result: 'retryable_error' };
  if (origin === 'cloud' && r.edge_backed && a.kind === 'legacy_actorless') return { ...deny('actor_missing_at_upgrade'), command_result: 'REJECTED_PERMANENT', attributed_actor: null };
  if (origin === 'cloud' && r.edge_backed && a.kind === 'user' && a.gateway_owner && (!a.local_actor_mapped || !a.gateway_membership_confirmed)) return { ...deny('paired_mapping_required'), recovery_hint: 'relink' };
  if (origin === 'cloud' && r.edge_backed && !r.binding_contract_supported) return deny('binding_contract_unsupported');
  if (action === 'bootstrap') {
    if (input.bootstrap.users_count !== 0) return { ...deny('bootstrap_closed'), upgrade_required: input.bootstrap.enabled_admins === 0 };
    return { ...allow(), stored_role: 'admin' };
  }
  if (origin === 'cloud' && r.edge_backed && !r.capabilities.includes('authority_actor_v1')) return deny('actor_capability_unavailable');
  if (action === 'service_linked_auth' || action === 'service_force_sync') {
    if (a.kind !== 'system' || a.user_uuid !== null || input.service.system_actor !== 'gateway_transport') return deny('system_actor_required');
    if (input.session.kind !== 'transport' || !input.service.transport_authorized) return deny('transport_unauthorized');
    if (!input.service.binding_matches || !input.current.linked) return deny('service_binding_mismatch');
    if (action === 'service_linked_auth' && !input.service.credential_principal_authorized) return deny('credential_principal_unauthorized');
    const cap = action === 'service_linked_auth' ? 'linked_auth_sync_v1' : 'force_edge_sync_v1';
    if (r.capability_state !== 'current' || !r.capabilities.includes(cap)) return deny('capability_unavailable');
    return allow(action === 'service_force_sync' ? 0 : 1);
  }
  if (origin === 'cloud' && !input.service.transport_authorized) return deny('transport_unauthorized');
  if (origin === 'cloud' && r.edge_backed && !input.service.binding_matches) return deny('service_binding_mismatch');
  if (origin === 'cloud' && r.edge_backed && ['policy_change', 'policy_pause', 'incident_retry'].includes(action) && (r.capability_state !== 'current' || !r.capabilities.includes('conditional_irrigation_v1'))) return deny('capability_unavailable');
  if (a.kind !== 'user') return deny('system_actor_not_allowed');
  const stop = input.continuation;
  if (stop.accepted && stop.trusted && (stop.original_actor_uuid !== stop.command_actor_uuid || a.user_uuid !== stop.command_actor_uuid)) return deny('actor_binding_mismatch');
  if (origin === 'cloud' && ['policy_pause', 'valve_cancel', 'close_override'].includes(action) && ['issue', 'apply'].includes(input.stage)
      && p.stop_authority === 'reduce_only_continuation' && stop.accepted && stop.trusted
      && stop.reduce_only && stop.binding_matches && stop.gateway_matches && stop.policy_matches
      && stop.original_actor_uuid === stop.command_actor_uuid) return { ...allow(1, 'authorized_stop_continuation'), recorded_under_actor: stop.original_actor_uuid, revocation_noted: !a.enabled || a.zone_relation === 'none', opens: 0, reenables: 0, extends: 0 };
  if (origin === 'edge') {
    const session = sessionDecision(input);
    if (session.decision === 'deny') return session;
  }
  if (origin === 'cloud' && !r.edge_backed && action === 'device_rename') return a.enabled && a.device_owner ? allow() : deny('resource_not_found');
  if (origin === 'cloud' && (!a.local_actor_mapped || !a.gateway_membership_confirmed)) return deny('gateway_authority_required');
  if (!a.user_uuid || a.user_uuid !== input.current.account_uuid) return deny('actor_binding_mismatch');
  if (!a.enabled) return deny('account_disabled');
  if (!['admin', 'researcher', 'viewer'].includes(a.gateway_role)) return deny('invalid_role');
  if (origin === 'cloud' && r.edge_backed && (r.scope_mode === 'unknown' || r.capability_state !== 'current')) return deny('capability_unavailable');
  if (action === 'device_rename' && origin === 'cloud' && r.edge_backed && !r.capabilities.includes('entity_name_commands_v1')) return deny('capability_unavailable');
  if (action.startsWith('radio_')) {
    const radioOwner = a.gateway_owner && a.ownership_proven && a.local_actor_mapped;
    return a.gateway_role === 'admin' || radioOwner ? allow(['radio_configuration', 'radio_survey'].includes(action) ? 1 : 0) : deny('insufficient_role');
  }
  if (action === 'system_reboot' || action === 'system_fan') {
    if (a.gateway_role === 'admin') return allow();
    return p.owner_system === 'mapped_owner_or_admin' && a.gateway_owner && a.ownership_proven && a.local_actor_mapped ? allow() : deny('insufficient_role');
  }
  if (PRIVILEGED.has(action)) return a.gateway_role === 'admin' ? allow() : deny('insufficient_role');
  if (READS.has(action)) return allow(0);
  if (action === 'today_liters') return scoped || a.device_owner ? allow(0) : deny('resource_not_found');
  if (a.gateway_role === 'viewer') return deny('insufficient_role');
  if (action === 'zone_create') return allow();
  if (action === 'valve_list') return allow(0);
  if (['device_register', 'device_claim', 'device_assign', 'device_unassign'].includes(action)) {
    return (!r.assigned || r.source_scope || r.weather_shared) && (!r.target_assigned || r.target_scope) && (r.assigned || r.unassigned_free) ? allow() : deny('resource_not_found');
  }
  if (['soil_depth_config', 'sdi12_recipe_apply', 'sdi12_recipe_rollback'].includes(action) && !r.assigned && r.soil_depth_capable) return a.gateway_role === 'admin' || a.device_owner ? allow() : deny('resource_not_found');
  if (!scoped) return a.device_owner || a.zone_relation === 'owned' ? allow() : deny('resource_not_found');
  if (!r.assigned) return deny('resource_not_found');
  return ['owned', 'granted'].includes(a.zone_relation) ? allow() : deny('resource_not_found');
}

function runLifecycle(initial, steps, defaults, assertProjection) {
  const s = clone(initial); const sessions = new Map(); const logins = new Map();
  const usedLinks = new Set(s.used_incarnations);
  const scopeLoads = new Map();
  const credentialPayload = e => JSON.stringify({ credential: e.credential, scheme: e.scheme, ...(e.enabled === undefined ? {} : { enabled: e.enabled }), ...(e.role === undefined ? {} : { role: e.role }) });
  let acceptedCredentialPayload = credentialPayload(s.credential_snapshot);
  const input = token => merge(defaults, {
    now_ms: s.now_ms, clock_high_water_ms: s.high_water_ms, policies: s.policies,
    mode: s.connected ? 'linked_online' : 'linked_offline',
    actor: { enabled: s.enabled, gateway_role: s.role },
    current: { account_uuid: s.account_uuid, installation: s.installation, generation: s.generation, link_incarnation: s.link_incarnation, linked: s.linked },
    session: sessions.get(token) || { signature_valid: false },
  });
  const issue = (token, expiry) => {
    const effectiveNow = Math.max(s.now_ms, s.high_water_ms);
    s.high_water_ms = effectiveNow;
    sessions.set(token, { kind: 'local', signature_valid: true, account_uuid: s.account_uuid, installation: s.installation, generation: s.generation, issued_at_ms: effectiveNow, exp_ms: expiry === undefined ? effectiveNow + 1000 : expiry, link_incarnation: s.link_incarnation });
  };
  const loginValid = step => s.enabled && step.credential === s.credential
    && step.subject === (s.scheme === 'v1' ? s.gateway : s.installation)
    && step.installation === s.installation && step.link_incarnation === s.link_incarnation;
  let result = null;
  for (const step of steps) {
    switch (step.op) {
      case 'issue_session': issue(step.token, step.exp_ms); result = allow(0); break;
      case 'assert_session': case 'release_export': case 'apply_effect':
        result = sessionDecision(input(step.token));
        if (step.op === 'apply_effect' && result.decision === 'allow') result.effects = 1;
        break;
      case 'assert_action': result = authorize(merge(input(step.token), step.input)); break;
      case 'operator_recovery':
        if (s.upgrade_outcome !== 'recovery_required') { result = deny('recorded_upgrade_required'); break; }
        if (!step.trusted_operator || step.target_uuid !== s.account_uuid) { result = deny('operator_proof_required'); break; }
        s.role = 'admin'; s.enabled = true; s.enabled_admins++; s.generation++; result = { decision: 'committed', generation: s.generation, effects: 0 }; break;
      case 'begin_export': case 'queue_effect': result = sessionDecision(input(step.token)); break;
      case 'commit_account':
        if (!step.commit) { result = deny('mutation_rollback'); break; }
        if ((step.change === 'disable' || step.change === 'role_change' && step.role !== 'admin') && s.role === 'admin' && s.enabled && s.enabled_admins === 1) { result = deny('last_admin_conflict'); break; }
        if (step.change === 'role_change' && step.role === s.role || step.change === 'disable' && !s.enabled) { result = { decision: 'noop', effects: 0 }; break; }
        if (step.change === 'disable') { if (s.enabled && s.role === 'admin') s.enabled_admins--; s.enabled = false; }
        if (step.change === 'password_reset') s.credential = step.credential;
        if (step.change === 'role_change') { if (s.enabled && s.role === 'admin') s.enabled_admins--; s.role = step.role; if (s.enabled && s.role === 'admin') s.enabled_admins++; }
        s.generation++; result = { decision: 'committed', effects: 0, generation: s.generation }; break;
      case 'enable': if (!s.enabled && s.role === 'admin') s.enabled_admins++; s.enabled = true; result = allow(0); break;
      case 'restart': s.high_water_ms = Math.max(s.now_ms, s.high_water_ms); result = allow(0); break;
      case 'clock': s.now_ms = step.now_ms; s.high_water_ms = Math.max(s.high_water_ms, s.now_ms); result = allow(0); break;
      case 'disconnect': s.connected = false; result = allow(0); break;
      case 'reconnect': s.connected = true; result = allow(0); break;
      case 'begin_scope_load': scopeLoads.set(step.ticket, s.generation); result = allow(0); break;
      case 'complete_scope_load': result = { cache_auth_valid: scopeLoads.get(step.ticket) === s.generation, effects: 0 }; break;
      case 'prepare_login': logins.set(step.ticket, { valid: loginValid(step), generation: s.generation, link: s.link_incarnation }); result = allow(0); break;
      case 'finish_login': {
        const ticket = logins.get(step.ticket);
        result = ticket && ticket.valid && ticket.generation === s.generation && ticket.link === s.link_incarnation ? { ...allow(0), generation: s.generation } : deny('login_superseded');
        if (result.decision === 'allow') issue(step.token);
        break;
      }
      case 'login': result = loginValid(step) ? { ...allow(0), generation: s.generation } : deny('invalid_credential_context'); if (result.decision === 'allow') issue(step.token); break;
      case 'link_transition':
        if (!step.commit) { result = deny('mutation_rollback'); break; }
        if (usedLinks.has(step.incarnation)) { result = deny('incarnation_reuse'); break; }
        usedLinks.add(step.incarnation);
        s.used_incarnations.push(step.incarnation);
        Object.assign(s, { linked: step.linked, link_incarnation: step.incarnation, credential: step.credential, credential_revision: step.revision, cloud_account: step.cloud_account, installation: step.installation, gateway: step.gateway, scheme: step.scheme, transport_token: step.transport_token, transport_revision: step.transport_revision });
        s.credential_snapshot = { credential: s.credential, scheme: s.scheme };
        acceptedCredentialPayload = credentialPayload(s.credential_snapshot);
        s.generation++; result = { decision: 'committed', effects: 0, generation: s.generation }; break;
      case 'credential_delivery': {
        const e = step.envelope;
        if (!s.connected) { result = { decision: 'pending_offline', effects: 0 }; break; }
        if (!s.transport_authorized) { result = { decision: 'pending_stranded', effects: 0 }; break; }
        if (!s.linked || e.incarnation !== s.link_incarnation || e.account_uuid !== s.account_uuid || e.cloud_account !== s.cloud_account || e.installation !== s.installation || e.gateway !== s.gateway) { result = deny('stale_link_context'); break; }
        if (e.revision < s.credential_revision) { result = deny('stale_credential_revision'); break; }
        if (e.revision === s.credential_revision) { result = credentialPayload(e) === acceptedCredentialPayload ? { decision: 'duplicate', effects: 0 } : deny('credential_revision_conflict'); break; }
        if ((e.enabled !== undefined || e.role !== undefined) && !step.account_mutation_authorized) { result = deny('privileged_account_mutation_required'); break; }
        const nextRole = e.role === undefined ? s.role : e.role;
        const nextEnabled = e.enabled === undefined ? s.enabled : e.enabled;
        if (s.role === 'admin' && s.enabled && (nextRole !== 'admin' || !nextEnabled) && s.enabled_admins === 1) { result = deny('last_admin_conflict'); break; }
        if (!step.commit) { result = deny('mutation_rollback'); break; }
        if (s.enabled && s.role === 'admin' && (!nextEnabled || nextRole !== 'admin')) s.enabled_admins--;
        if (nextEnabled && nextRole === 'admin' && (!s.enabled || s.role !== 'admin')) s.enabled_admins++;
        Object.assign(s, { credential: e.credential, credential_revision: e.revision, scheme: e.scheme });
        if (e.enabled !== undefined) s.enabled = e.enabled;
        if (e.role !== undefined) s.role = e.role;
        acceptedCredentialPayload = credentialPayload(e);
        s.credential_snapshot = JSON.parse(acceptedCredentialPayload);
        if (s.cloud_revocation_status === 'pending') s.cloud_revocation_status = 'applied';
        s.generation++; result = { decision: 'committed', effects: 0, generation: s.generation }; break;
      }
      case 'cloud_revoke': s.cloud_sessions_valid = false; s.cloud_revocation_status = 'pending'; if (step.change === 'disable') s.human_account_enabled = false; result = { decision: 'cloud_fenced', effects: 0 }; break;
      case 'assert_cloud_session': result = s.cloud_sessions_valid ? allow(0) : deny('cloud_session_revoked'); break;
      case 'transport_principal': s.transport_authorized = step.authorized; result = allow(0); break;
      case 'transport_refresh':
        if (!s.transport_authorized) result = deny('transport_unauthorized');
        else if (step.incarnation !== s.link_incarnation) result = deny('stale_link_context');
        else if (step.transport_revision < s.transport_revision) result = deny('stale_transport_revision');
        else if (step.transport_revision === s.transport_revision) result = step.transport_token === s.transport_token ? { decision: 'duplicate', effects: 0 } : deny('transport_revision_conflict');
        else { s.transport_token = step.transport_token; s.transport_revision = step.transport_revision; result = { decision: 'transport_refreshed', effects: 0 }; }
        break;
      case 'assert_state': result = clone(s); break;
      default: throw new Error(`unknown lifecycle operation ${step.op}`);
    }
    if (step.expected) assertProjection(result, step.expected, step.op);
  }
  return s;
}

function runPause(initial, steps, defaults, assertProjection) {
  const s = clone(initial); let result;
  const decision = stage => {
    if (s.command_gateway !== s.accepted_gateway || s.command_zone_uuid !== s.accepted_zone_uuid || s.command_policy_uuid !== s.accepted_policy_uuid) return deny('binding_mismatch');
    if (!s.binding_matches || !s.gateway_matches || !s.policy_matches || s.original_actor !== s.command_actor || s.record_owner !== s.original_actor) return deny('binding_mismatch');
    return authorize(merge(defaults, {
    action: 'policy_pause', origin: 'cloud', stage,
    current: { account_uuid: s.actor },
    actor: { user_uuid: s.actor, zone_relation: s.has_grant ? 'granted' : 'none', enabled: !s.disabled },
    policies: { stop_authority: s.stop_policy },
    continuation: { accepted: s.accepted_pause, trusted: true, reduce_only: true, binding_matches: s.binding_matches,
      original_actor_uuid: s.original_actor, command_actor_uuid: s.command_actor, gateway_matches: s.gateway_matches, policy_matches: s.policy_matches },
  }));
  };
  for (const step of steps) {
    switch (step.op) {
      case 'accept_create': s.create_pending = true; s.create_delivered = step.delivered; s.original_actor = s.actor; result = { state: 'create_pending', effects: 0 }; break;
      case 'accept_pause':
        if (!s.has_grant || s.disabled) { result = deny('resource_not_found'); break; }
        s.accepted_pause = true; s.command_actor = s.actor; s.record_owner = s.original_actor;
        if (s.create_pending && s.create_delivered === false) { s.create_pending = false; s.ui = 'create_withdrawn'; result = { state: 'create_withdrawn', effects: 0 }; }
        else { s.ui = 'pause_intent_pending'; result = { state: s.ui, actor: s.original_actor, effects: 0 }; }
        break;
      case 'answer_create': s.create_pending = false; s.policy_enabled = step.applied; if (step.create_mirror_confirmed) s.confirmed_policy_enabled = step.applied; result = { state: step.applied ? 'policy_enabled' : 'policy_missing', effects: 0 }; break;
      case 'revoke_grant': s.has_grant = false; s.revocation_noted = true; result = allow(0); break;
      case 'disable_actor': case 'delete_actor': s.disabled = true; s.revocation_noted = true; result = allow(0); break;
      case 'change_binding': Object.assign(s, step.patch); result = allow(0); break;
      case 'issue_pause':
        result = decision('issue');
        s.issued = result.decision === 'allow';
        s.ui = s.issued ? 'pause_pending' : 'pause_refused_policy_may_remain_enabled';
        if (!s.issued) {
          s.ack = 'REJECTED_PERMANENT';
          s.refused_record = { actor: s.command_actor, recorded_under_actor: s.record_owner, ack: s.ack };
        }
        result = { ...result, actor: s.command_actor, recorded_under_actor: s.record_owner, revocation_noted: s.revocation_noted, extends: 0, reenables: 0, ui: s.ui, expected_policy_version: null };
        break;
      case 'apply_pause':
        result = s.issued ? decision('apply') : deny('not_issued');
        if (result.decision === 'allow') { s.policy_enabled = false; s.ack = 'APPLIED'; s.ui = 'pause_pending_mirror'; }
        else { s.ack = 'REJECTED_PERMANENT'; s.ui = 'pause_refused_policy_may_remain_enabled'; }
        result = { ...result, ack: s.ack, recorded_under_actor: s.record_owner, revocation_noted: s.revocation_noted, extends: 0, reenables: 0, ui: s.ui, policy_enabled: s.policy_enabled, confirmed_policy_enabled: s.confirmed_policy_enabled, physical_closed: false, opens: 0, applied_policy_version: result.decision === 'allow' ? s.current_policy_version : null }; break;
      case 'mirror': if (s.ack === 'APPLIED') s.confirmed_policy_enabled = s.policy_enabled; s.ui = s.ack === 'APPLIED' && !s.policy_enabled ? 'paused' : s.ui; result = { ui: s.ui, confirmed_policy_enabled: s.confirmed_policy_enabled, opens: 0 }; break;
      case 'reissue_pause': {
        if (!step.authorized) { result = deny('current_authority_required'); break; }
        if (!step.new_request || s.ack !== 'REJECTED_PERMANENT') { result = deny('new_request_after_terminal_refusal_required'); break; }
        const previousAck = s.ack;
        s.actor = step.actor; s.original_actor = step.actor; s.command_actor = step.actor;
        s.record_owner = step.actor; s.has_grant = true; s.disabled = false; s.accepted_pause = true;
        s.revocation_noted = false; s.issued = false; s.ack = null; s.ui = 'pause_intent_pending';
        result = { decision: 'accepted_new_request', actor: step.actor, previous_ack: previousAck, previous_record: clone(s.refused_record), effects: 0 }; break;
      }
      default: throw new Error(`unknown pause operation ${step.op}`);
    }
    if (step.expected) assertProjection(result, step.expected, step.op);
  }
  return s;
}
function runAdminUpgrade(initial, steps, assertProjection) {
  const state = clone(initial);
  for (const step of steps) {
    let result;
    if (step.op === 'upgrade') {
      if (state.receipt !== null) result = { decision: 'noop', reason: 'already_recorded', promotions: 0 };
      else if (!step.commit) result = { decision: 'rollback', promotions: 0 };
      else {
        const existingAdmin = state.accounts.some(a => a.enabled && a.role === 'admin');
        // AUTOINCREMENT id 1 proves first-ever insertion, not lowest surviving id.
        // sqlite_sequence(users).seq is the durable insertion marker; no bootstrap flag exists.
        const insertionEvidence = Number.isInteger(state.users_sequence) && state.users_sequence >= 1
          && state.accounts.every(a => a.id <= state.users_sequence);
        const original = insertionEvidence ? state.accounts.find(a => a.id === 1) : null;
        // Addendum 22 Nov: row 1 that still has the shipped default password is never
        // promoted (username irrelevant, enabled or not); the next enabled account by
        // users.id (lowest id above 1, not created_at) is promoted instead.
        const shippedDefault = Boolean(original && original.default_password_unchanged);
        const target = shippedDefault
          ? state.accounts.filter(a => a.id > 1 && a.enabled).sort((a, b) => a.id - b.id)[0] || null
          : (original && original.enabled ? original : null);
        const promote = !existingAdmin && Boolean(target);
        const outcome = existingAdmin ? 'admin_exists'
          : !promote ? 'operator_recovery_required'
          : shippedDefault ? 'promoted_first_account_after_shipped_default' : 'promoted_original_bootstrap';
        if (promote) {
          target.role = 'admin';
          target.generation++;
          state.audit.push({ event: 'bootstrap_admin_upgrade', user_uuid: target.user_uuid, ruling_date: shippedDefault ? '2026-11-22' : '2026-11-20' });
          state.release_notes.push(state.release_note_line);
        }
        state.receipt = { step: 'bootstrap_admin_upgrade_v1', outcome, target_uuid: promote ? target.user_uuid : null };
        result = { decision: outcome, promotions: promote ? 1 : 0 };
      }
    } else if (step.op === 'disable_original') {
      const account = state.accounts.find(a => a.id === 1);
      if (account) account.enabled = false;
      result = { decision: 'disabled', promotions: 0 };
    } else if (step.op === 'restart') result = { decision: 'restarted', promotions: 0 };
    else if (step.op === 'assert_state') result = clone(state);
    else throw new Error(`unknown admin-upgrade operation ${step.op}`);
    if (step.expected) assertProjection(result, step.expected, step.op);
  }
  return state;
}
module.exports = { merge, authorize, sessionDecision, runLifecycle, runPause, runAdminUpgrade };
