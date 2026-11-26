import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const guard = fileURLToPath(new URL('../../scripts/verify-no-binary-art.mjs', import.meta.url));
const ascii = (text: string) => Buffer.from(text, 'latin1');
const bytes = (...values: number[]) => Buffer.from(values);

/** Audio files the guard must refuse by their first bytes, saved under a neutral name. */
const AUDIO_SIGNATURES: Record<string, Buffer> = {
  'wav.bin': ascii('RIFF\x24\x00\x00\x00WAVEfmt '),
  'aiff.bin': ascii('FORM\x00\x00\x00\x2eAIFFCOMM'),
  'mp3-tag.bin': ascii('ID3\x04\x00\x00\x00\x00\x00\x00'),
  'mp3-frame.bin': bytes(0xff, 0xfb, 0x90, 0x64, 0x00),
  'aac-adts.bin': bytes(0xff, 0xf1, 0x50, 0x80, 0x00),
  'ogg.bin': ascii('OggS\x00\x02\x00\x00'),
  'flac.bin': ascii('fLaC\x00\x00\x00\x22'),
  'm4a.bin': ascii('\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00'),
  'webm.bin': bytes(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81),
  'midi.bin': ascii('MThd\x00\x00\x00\x06'),
};
const AUDIO_EXTENSIONS = ['aac', 'aif', 'aifc', 'aiff', 'flac', 'm4a', 'm4b', 'mid', 'midi', 'mp3', 'oga', 'ogg',
  'opus', 'wav', 'weba', 'webm'];

test('the binary art guard refuses audio files by extension and by signature', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'farm-sim-binary-art-'));
  try {
    const run = () => spawnSync(process.execPath, [guard, '--files', fixture], {encoding: 'utf8'});
    writeFileSync(join(fixture, 'notes.txt'), 'Plain text about a WAVE of RIFF and OggS.\n');
    writeFileSync(join(fixture, 'sprite.ts'), 'export const tone = 440;\n');
    // UTF-16 text starts ff fe, close to an MP3 frame header.
    writeFileSync(join(fixture, 'utf16.txt'), Buffer.concat([bytes(0xff, 0xfe), Buffer.from('text', 'utf16le')]));
    const clean = run();
    assert.equal(clean.status, 0, clean.stderr + clean.stdout);
    assert.match(clean.stdout, /verify-no-binary-art: OK \(3 tracked files\)/);

    const audio = [...Object.keys(AUDIO_SIGNATURES), ...AUDIO_EXTENSIONS.map(extension => 'clip.' + extension)];
    for (const [file, header] of Object.entries(AUDIO_SIGNATURES)) writeFileSync(join(fixture, file), header);
    for (const extension of AUDIO_EXTENSIONS) writeFileSync(join(fixture, 'clip.' + extension), 'text\n');
    const failed = run();
    assert.equal(failed.status, 1, failed.stderr + failed.stdout);
    assert.deepEqual(failed.stderr.trim().split('\n'),
      audio.sort().map(file => 'verify-no-binary-art: tracked image, audio or font: ' + file));
  } finally {
    rmSync(fixture, {recursive: true, force: true});
  }
});
