import { describe, expect, it } from 'vitest';

import { normalizeJournalDetailPreference, resolveTemplateCode } from '../templatePreference';

describe('journal template preference', () => {
  it('uses the stored Quick preference when the layout supports it', () => {
    expect(resolveTemplateCode(['research_observation', 'full_record', 'farmer_quick'], 'farmer_quick'))
      .toBe('farmer_quick');
  });

  it('falls back to the least verbose supported template', () => {
    expect(resolveTemplateCode(['research_observation', 'full_record'], 'farmer_quick'))
      .toBe('full_record');
  });

  it('maps legacy research preference to Full before resolution', () => {
    expect(normalizeJournalDetailPreference('research_observation')).toBe('full_record');
  });
});
