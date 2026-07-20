// @ts-expect-error The authoritative catalog source is a CommonJS generator input.
import coreCatalog from '../../../../../scripts/journal-catalog-core.js';
// @ts-expect-error The authoritative generator is CommonJS and has no TypeScript declaration.
import catalogGenerator from '../../../../../scripts/generate-journal-catalog.js';
import agroscopeSource from '../../../../../docs/superpowers/specs/agroscope-open-field/catalog.json';
import type { JournalDefinitionRow, JournalVocabRow } from '../../types/journal';

interface CompiledCatalogRow {
  table: string;
  columns: string[];
  values: unknown[];
}

function rowObject(row: CompiledCatalogRow): Record<string, unknown> {
  return Object.fromEntries(row.columns.map((column, index) => [column, row.values[index]]));
}

function compiledRows(): CompiledCatalogRow[] {
  const compiled = (catalogGenerator as {
    compileCatalog: (core: unknown, source: unknown) => { rows: CompiledCatalogRow[] };
  }).compileCatalog(coreCatalog, agroscopeSource);
  return compiled.rows;
}

function definitionRows(table: 'journal_templates' | 'journal_layouts'): JournalDefinitionRow[] {
  return compiledRows()
    .filter((row) => row.table === table)
    .map((row) => {
      const value = rowObject(row);
      return {
        code: String(value.code),
        version: Number(value.version),
        active: Number(value.active),
        catalog_errors: [],
        labels: JSON.parse(String(value.labels_json)) as Record<string, string>,
        definition: JSON.parse(String(value.definition_json)) as JournalDefinitionRow['definition'],
      };
    });
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'string' ? (JSON.parse(value) as Record<string, unknown>) : null;
}

// Full, real journal_vocab rows (every activity/attribute/unit/choice the
// current catalog defines) — a superset a curated per-test vocab fixture can
// safely merge overrides onto, so fixtures that pick "whatever farmer_quick's
// latest version is" (see JournalPage.test.tsx) stay valid as quick_fields
// grows to reference more attributes, without hand-authoring every one.
function vocabRows(): JournalVocabRow[] {
  return compiledRows()
    .filter((row) => row.table === 'journal_vocab')
    .map((row) => {
      const value = rowObject(row);
      return {
        code: String(value.code),
        kind: value.kind as JournalVocabRow['kind'],
        parent_code: value.parent_code == null ? null : String(value.parent_code),
        value_type: value.value_type as JournalVocabRow['value_type'],
        quantity_kind: value.quantity_kind == null ? null : String(value.quantity_kind),
        basis: value.basis == null ? null : String(value.basis),
        default_unit_code: value.default_unit_code == null ? null : String(value.default_unit_code),
        icon_key: value.icon_key == null ? null : String(value.icon_key),
        scope: value.scope as JournalVocabRow['scope'],
        owner_user_uuid: null,
        gateway_device_eui: null,
        custom_field_uuid: null,
        active: Number(value.active),
        sort_order: Number(value.sort_order),
        sync_version: Number(value.sync_version),
        created_at: String(value.created_at),
        deleted_at: null,
        catalog_errors: [],
        labels: parseJsonObject(value.labels_json) as Record<string, string>,
        constraints: parseJsonObject(value.constraints_json),
      };
    });
}

export function compiledSlaCatalog(): {
  templates: JournalDefinitionRow[];
  layouts: JournalDefinitionRow[];
  vocab: JournalVocabRow[];
} {
  return {
    templates: definitionRows('journal_templates'),
    layouts: definitionRows('journal_layouts'),
    vocab: vocabRows(),
  };
}
