import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';

const repo = resolve(import.meta.dirname, '../../../..');
const seedPath = resolve(repo, 'database/seed-blank.sql');
const seed = readFileSync(seedPath, 'utf8');
const db = new DatabaseSync(':memory:');
db.exec(seed);
const row = sql => db.prepare(sql).all().map(item => ({...item}));
const parsed = (value, fallback) => {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};
const state = db.prepare('SELECT catalog_version,catalog_hash FROM journal_catalog_state WHERE id=1').get();
const catalog = {
  catalog_version: Number(state.catalog_version),
  catalog_hash: state.catalog_hash,
  vocab: row('SELECT * FROM journal_vocab').map(item => {
    const {labels_json, constraints_json, ...output} = item;
    return {...output, labels: parsed(labels_json, {}), constraints: parsed(constraints_json, null), catalog_errors: []};
  }),
  templates: row('SELECT * FROM journal_templates').map(item => {
    const {labels_json, definition_json, ...output} = item;
    return {...output, labels: parsed(labels_json, {}), definition: parsed(definition_json, {}), catalog_errors: []};
  }),
  layouts: row('SELECT * FROM journal_layouts').map(item => {
    const {labels_json, definition_json, ...output} = item;
    return {...output, labels: parsed(labels_json, {}), definition: parsed(definition_json, {}), catalog_errors: []};
  }),
  products: row('SELECT * FROM journal_products').map(item => {
    const {composition_json, ...output} = item;
    return {...output, composition: parsed(composition_json, {}), catalog_errors: []};
  }),
  mappings: row('SELECT term_code,scheme_uri,scheme_version,mapping_role,external_id,external_parent_id,mapping_relation,source_uri,active FROM journal_vocab_mappings ORDER BY term_code,scheme_uri,mapping_role,external_id'),
};
catalog.vocab.sort((a,b)=>a.code.localeCompare(b.code));
catalog.templates.sort((a,b)=>a.code.localeCompare(b.code)||a.version-b.version);
catalog.layouts.sort((a,b)=>a.code.localeCompare(b.code)||a.version-b.version);
catalog.products.sort((a,b)=>a.product_uuid.localeCompare(b.product_uuid));
const provenance={
  templates:row('SELECT code,version,definition_json FROM journal_templates').map(item=>({code:item.code,version:Number(item.version),definition_sha256:item.definition_json==null?null:createHash('sha256').update(item.definition_json,'utf8').digest('hex')})),
  layouts:row('SELECT code,version,definition_json FROM journal_layouts').map(item=>({code:item.code,version:Number(item.version),definition_sha256:item.definition_json==null?null:createHash('sha256').update(item.definition_json,'utf8').digest('hex')})),
  units:row("SELECT code,quantity_kind,basis,constraints_json FROM journal_vocab WHERE kind='unit'").map(item=>({code:item.code,quantity_kind:item.quantity_kind,basis:item.basis,constraints_json:item.constraints_json,constraints_sha256:item.constraints_json==null?null:createHash('sha256').update(item.constraints_json,'utf8').digest('hex')})),
};
const output = resolve(import.meta.dirname, '../journal-catalog.json');
writeFileSync(output, `${JSON.stringify(catalog)}\n`);
writeFileSync(`${output}.sha256`, `${createHash('sha256').update(seed).digest('hex')}  database/seed-blank.sql\n`);
writeFileSync(resolve(import.meta.dirname,'../journal-catalog-provenance.json'),`${JSON.stringify(provenance)}\n`);
console.log(`journal catalog v${catalog.catalog_version}: ${catalog.vocab.length} vocab, ${catalog.templates.length} templates, ${catalog.layouts.length} layouts`);
db.close();
