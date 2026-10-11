import {copyFile, mkdir, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const guiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inputs = ['invitation.js', 'invitation.css', 'osi-os-preview.png', 'invitation.html', 'preview.html', 'embed.html'];

export async function packageWebsiteAssets(source = path.join(guiRoot, 'demo/website'), output = path.join(guiRoot, 'website-demo-build')) {
  const missing = [];
  for (const name of inputs) {
    try {if (!(await stat(path.join(source, name))).isFile()) missing.push(name);}
    catch {missing.push(name);}
  }
  if (missing.length) throw new Error(`Website packaging inputs are missing: ${missing.join(', ')}`);
  await mkdir(output, {recursive: true});
  for (const name of inputs) await copyFile(path.join(source, name), path.join(output, name));
}

const scriptPath = process.argv[1] && path.resolve(process.argv[1]);
if (scriptPath === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    await packageWebsiteAssets();
    console.log(`Website assets packaged at ${path.join(guiRoot, 'website-demo-build')}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
