import {execFileSync} from 'node:child_process';
import {closeSync, openSync, readdirSync, readSync} from 'node:fs';
import {extname, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--files' || !args[1])) {
  console.error('usage: verify-no-binary-art.mjs [--files <directory>]');
  process.exit(2);
}
// --files checks every file under a fixture directory instead of the package's tracked files.
const root = args.length ? resolve(args[1]) : fileURLToPath(new URL('../', import.meta.url));
const artExtensions = new Set([
  '.apng', '.avif', '.bmp', '.cur', '.dds', '.eot', '.gif', '.heic', '.heif', '.ico', '.icns',
  '.jfif', '.jp2', '.jpeg', '.jpg', '.jxl', '.otf', '.pbm', '.pgm', '.png', '.pnm', '.ppm',
  '.psd', '.qoi', '.svgz', '.tga', '.tif', '.tiff', '.ttc', '.ttf', '.webp', '.woff', '.woff2',
  // Audio (plan section 2: no binary image, audio or font files).
  '.aac', '.aif', '.aifc', '.aiff', '.flac', '.m4a', '.m4b', '.mid', '.midi', '.mp3', '.oga', '.ogg', '.opus',
  '.wav', '.weba', '.webm',
]);
// MP3 frames start ff fb, ff f3 or ff f2; AAC ADTS frames ff f1 or ff f9. A UTF-16 text file starts ff fe.
const signatures = ['89504e47' + '0d0a1a0a', 'ffd8ff', '00000100', '00000200', '49492a00', '4d4d002a', '00010000',
  'fffb', 'fff3', 'fff2', 'fff1', 'fff9', '1a45dfa3'];
const asciiSignatures = ['GIF87a', 'GIF89a', 'OTTO', 'ttcf', 'wOFF', 'wOF2', '8BPS', 'qoif', 'icns', 'DDS ',
  'ID3', 'OggS', 'fLaC', 'MThd'];
const brand = /^(?:avif|avis|heic|heix|hevc|hevx|mif1|msf1|M4A |M4B |M4P |F4A |F4B )$/;

function binaryArt(path) {
  if (artExtensions.has(extname(path).toLowerCase())) return true;
  const file = openSync(resolve(root, path), 'r');
  const header = Buffer.alloc(16);
  let size;
  try {
    size = readSync(file, header, 0, header.length, 0);
  } finally {
    closeSync(file);
  }
  const hex = header.subarray(0, size).toString('hex');
  const ascii = header.subarray(0, size).toString('latin1');
  return signatures.some(signature => hex.startsWith(signature))
    || asciiSignatures.some(signature => ascii.startsWith(signature))
    || ascii.startsWith('RIFF') && (ascii.slice(8, 12) === 'WEBP' || ascii.slice(8, 12) === 'WAVE')
    || ascii.startsWith('FORM') && (ascii.slice(8, 12) === 'AIFF' || ascii.slice(8, 12) === 'AIFC')
    || ascii.slice(4, 8) === 'ftyp' && brand.test(ascii.slice(8, 12))
    || /^BM[\s\S]{4}\x00{4}/.test(ascii);
}

const files = args.length
  ? readdirSync(root, {recursive: true, withFileTypes: true}).filter(entry => entry.isFile())
    .map(entry => relative(root, resolve(entry.parentPath, entry.name))).sort()
  : execFileSync('git', ['ls-files', '-z', '--', '.'], {cwd: root, encoding: 'utf8'}).split('\0').filter(Boolean);
const forbidden = files.filter(binaryArt);
if (forbidden.length) {
  for (const file of forbidden) console.error('verify-no-binary-art: tracked image, audio or font: ' + file);
  process.exitCode = 1;
} else {
  console.log(`verify-no-binary-art: OK (${files.length} tracked files)`);
}
