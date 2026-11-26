import path from 'node:path';

export default async function* fileReporter(source) {
  const counts = new Map();
  for await (const {type, data} of source) {
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    if (data.details?.type !== 'test' || data.skip || data.todo || !data.file) continue;
    const file = path.resolve(data.file);
    if (data.nesting === 0 && path.resolve(data.name) === file) continue;
    const relative = path.relative(process.cwd(), file).split(path.sep).join('/');
    counts.set(relative, (counts.get(relative) ?? 0) + 1);
  }
  yield JSON.stringify(Object.fromEntries([...counts].sort()), null, 2) + '\n';
}
