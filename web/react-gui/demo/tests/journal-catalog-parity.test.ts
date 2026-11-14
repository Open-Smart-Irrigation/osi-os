import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import bundle from '../journal-catalog.json';

test('build-only journal catalogue matches source seed rows and catalogDto ordering',()=>{
  const root=resolve(import.meta.dirname,'../../../..'),db=new DatabaseSync(':memory:');
  db.exec(readFileSync(resolve(root,'database/seed-blank.sql'),'utf8'));
  const rows=(sql:string)=>JSON.parse(JSON.stringify(db.prepare(sql).all())) as Array<Record<string,unknown>>;
  const bundleCatalog=bundle as {catalog_version:number;catalog_hash:string;vocab:Array<Record<string,unknown>>;templates:Array<Record<string,unknown>>;layouts:Array<Record<string,unknown>>;products:Array<Record<string,unknown>>;mappings:Array<Record<string,unknown>>};
  const state=db.prepare('SELECT catalog_version,catalog_hash FROM journal_catalog_state WHERE id=1').get() as Record<string,unknown>;
  assert.equal(bundleCatalog.catalog_version,Number(state.catalog_version));assert.equal(bundleCatalog.catalog_hash,state.catalog_hash);
  const vocab=rows('SELECT * FROM journal_vocab').map(({labels_json,constraints_json,...row})=>({...row,labels:JSON.parse(String(labels_json??'{}')),constraints:constraints_json==null?null:JSON.parse(String(constraints_json)),catalog_errors:[]})).sort((a,b)=>String(a.code).localeCompare(String(b.code)));
  const templates=rows('SELECT * FROM journal_templates').map(({labels_json,definition_json,...row})=>({...row,labels:JSON.parse(String(labels_json??'{}')),definition:JSON.parse(String(definition_json??'{}')),catalog_errors:[]})).sort((a,b)=>String(a.code).localeCompare(String(b.code))||Number(a.version)-Number(b.version));
  const layouts=rows('SELECT * FROM journal_layouts').map(({labels_json,definition_json,...row})=>({...row,labels:JSON.parse(String(labels_json??'{}')),definition:JSON.parse(String(definition_json??'{}')),catalog_errors:[]})).sort((a,b)=>String(a.code).localeCompare(String(b.code))||Number(a.version)-Number(b.version));
  const products=rows('SELECT * FROM journal_products').map(({composition_json,...row})=>({...row,composition:JSON.parse(String(composition_json??'{}')),catalog_errors:[]})).sort((a,b)=>String(a.product_uuid).localeCompare(String(b.product_uuid)));
  const mappings=rows('SELECT term_code,scheme_uri,scheme_version,mapping_role,external_id,external_parent_id,mapping_relation,source_uri,active FROM journal_vocab_mappings ORDER BY term_code,scheme_uri,mapping_role,external_id');
  assert.deepEqual(bundleCatalog.vocab,vocab);assert.deepEqual(bundleCatalog.templates,templates);assert.deepEqual(bundleCatalog.layouts,layouts);
  assert.deepEqual(bundleCatalog.products,products);assert.deepEqual(bundleCatalog.mappings,mappings);
  assert.equal(vocab.length,305);assert.equal(templates.length,14);assert.equal(layouts.length,13);assert.equal(products.length,10);assert.equal(mappings.length,7);
  db.close();
});
