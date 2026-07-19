// @ts-expect-error The authoritative catalog source is a CommonJS generator input.
import coreCatalog from '../../../../../scripts/journal-catalog-core.js';
// @ts-expect-error The authoritative generator is CommonJS and has no TypeScript declaration.
import catalogGenerator from '../../../../../scripts/generate-journal-catalog.js';
import agroscopeSource from '../../../../../docs/superpowers/specs/agroscope-open-field/catalog.json';
import type { JournalDefinitionRow } from '../../types/journal';

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

export function compiledSlaCatalog(): {
  templates: JournalDefinitionRow[];
  layouts: JournalDefinitionRow[];
} {
  return {
    templates: definitionRows('journal_templates'),
    layouts: definitionRows('journal_layouts'),
  };
}
