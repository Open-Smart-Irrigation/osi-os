# Plan: Redact ChirpStack API-key CLI failures

Status: in progress for Open-Smart-Irrigation/osi-os #522.

## Verified claim and invariant

`createApiKeyViaCLI()` currently includes malformed command output in its thrown
error and includes `execSync`'s error message when the command fails. The
top-level rejection handler writes that error to stderr. A synthetic-marker
probe reproduced the leak without using a real key or contacting a gateway.

Invariant: no bytes from ChirpStack CLI output or from a thrown process error
may reach bootstrap stdout, stderr, or the error passed to the top-level
handler. Failures may disclose only a fixed category and an integer exit
status in the range 1 through 255. Successful token parsing and provisioning
remain unchanged.

## Exact files

1. `scripts/chirpstack-bootstrap.js`
2. `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js`
3. `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/chirpstack-bootstrap.js`
4. `scripts/test-chirpstack-bootstrap-clover.js`
5. This plan and its adversarial-review record under `docs/superpowers/plans/`.

The three production scripts are byte-identical at `63c7a70f`; apply the same
function body to each. The profile mirror rule requires bcm2709 to match the
bcm2712 copy byte-for-byte.

## Planned production code

Replace the complete `createApiKeyViaCLI()` function in each of the three
production files with:

```js
async function createApiKeyViaCLI() {
  console.log('  + Creating API key via CLI (chirpstack create-api-key) ...');
  let out;
  try {
    out = execSync('chirpstack -c /var/etc/chirpstack create-api-key --name osi-nodered 2>&1').toString();
  } catch (error) {
    const status = error && Number.isInteger(error.status) && error.status >= 1 && error.status <= 255
      ? `, exit status ${error.status}`
      : '';
    throw new Error(`CLI create-api-key failed (command error${status})`);
  }

  const match = out.match(/^token:\s*(.+)$/m);
  if (!match) {
    throw new Error('CLI create-api-key failed (invalid output)');
  }
  console.log('  ✓ API key created via CLI');
  return match[1].trim();
}
```

This keeps process errors and command output outside all diagnostics. Only a
validated bounded exit status is interpolated. Invalid successful output gets
a separate fixed category. The successful token is still returned only to the
existing provisioning path.

## Test-first edits

In `scripts/test-chirpstack-bootstrap-clover.js`:

1. Add these fields to the object returned by `makeWorld(seed = {})`, adjacent
   to `cliApiKeyCalls`:

   ```js
   clientApiKeys: [],
   cliApiKeyOutput: seed.cliApiKeyOutput === undefined ? 'id: x\ntoken: minted-by-cli\n' : seed.cliApiKeyOutput,
   cliApiKeyError: seed.cliApiKeyError || null,
   stdoutLogs: [],
   stderrLogs: [],
   ```

2. In `makeChildProcess(world).execSync(command)`, inside the existing
   `create-api-key` branch, keep the call counter and replace the hard-coded
   return with:

   ```js
   if (world.cliApiKeyError) throw world.cliApiKeyError;
   return Buffer.from(world.cliApiKeyOutput);
   ```

3. In `runBootstrap()`, replace the fake console methods with:

   ```js
   log: (...parts) => {
     const line = parts.join(' ');
     world.logs.push(line);
     world.stdoutLogs.push(line);
   },
   error: (...parts) => {
     const line = parts.join(' ');
     world.logs.push(line);
     world.stderrLogs.push(line);
   },
   warn: (...parts) => {
     const line = parts.join(' ');
     world.logs.push(line);
     world.stderrLogs.push(line);
   },
   ```

4. In `runBootstrap()`, make the shebang removal work with both LF and CRLF
   checkouts by replacing:

   ```js
   const source = fs.readFileSync(SCRIPT, 'utf8').replace(/^#!.*\n/, '');
   ```

   with:

   ```js
   const source = fs.readFileSync(SCRIPT, 'utf8').replace(/^#!.*\r?\n/, '');
   ```

   This was required by the observed Windows checkout: its CRLF shebang was
   left in the dynamic function body and caused a `SyntaxError` before the
   regression assertion ran. It changes only the test harness's source loader.

5. In `makeChirpStack(world)`, replace `createClient: () => client` with:

   ```js
   createClient: (options) => {
     world.clientApiKeys.push(options.apiKey);
     return client;
   },
   ```

6. In `tektelicCodec()`, normalize the expected codec fixture's line endings,
   replacing:

   ```js
   return fs.readFileSync(TEKTELIC_CODEC, 'utf8');
   ```

   with:

   ```js
   return fs.readFileSync(TEKTELIC_CODEC, 'utf8').replace(/\r\n/g, '\n');
   ```

   The Windows run showed three existing codec equality cases fail because
   `getOrCreateProfileWithCodec()` normalizes the loaded payload to LF while
   this fixture helper returned the checkout's CRLF bytes. Normalize only the
   expected test value so those pre-existing assertions remain portable.

   Also before the first existing `test(...)` declaration, add these tests.
   The success case pins the existing parse-and-provision path; the synthetic
   markers in failure cases are the only secret-shaped values used. No
   credential or device is accessed:

   ```js
   test('CLI key creation success provisions with the parsed synthetic token', async () => {
     const world = await runBootstrap(makeWorld(), { env: { CHIRPSTACK_API_KEY: '' } });
     assert.equal(world.exitCode, 0, world.logs.join('\n'));
     assert.equal(world.cliApiKeyCalls, 1);
     assert.deepEqual(world.clientApiKeys, ['minted-by-cli']);
     assert.equal(parseEnv(world.files.get(ENV_FILE)).CHIRPSTACK_API_KEY, 'minted-by-cli');
   });

   test('CLI key creation failures do not log output or process errors', async () => {
     const malformedMarker = 'SYNTHETIC_MALFORMED_OUTPUT_SECRET_522';
     const malformed = await runBootstrap(makeWorld({
       cliApiKeyOutput: `warning: ${malformedMarker}\n`,
     }), { env: { CHIRPSTACK_API_KEY: '' } });
     const malformedLogs = [...malformed.stdoutLogs, ...malformed.stderrLogs].join('\n');
     assert.equal(malformed.exitCode, 1);
     assert.match(malformedLogs, /CLI create-api-key failed \(invalid output\)/);
     for (const [streamName, logs] of [['stdout', malformed.stdoutLogs], ['stderr', malformed.stderrLogs]]) {
       assert.ok(!logs.join('\n').includes(malformedMarker), `malformed command output is not logged to ${streamName}`);
     }

     const messageMarker = 'SYNTHETIC_ERROR_MESSAGE_SECRET_522';
     const stdoutMarker = 'SYNTHETIC_API_KEY_FIXTURE_522';
     const stderrMarker = 'SYNTHETIC_ERROR_STDERR_SECRET_522';
     const commandError = Object.assign(new Error(`command failed: ${messageMarker}`), {
       status: 23,
       stdout: Buffer.from(`token: ${stdoutMarker}\n`),
       stderr: Buffer.from(`command output: ${stderrMarker}`),
     });
     const failed = await runBootstrap(makeWorld({ cliApiKeyError: commandError }), {
       env: { CHIRPSTACK_API_KEY: '' },
     });
     const failedLogs = [...failed.stdoutLogs, ...failed.stderrLogs].join('\n');
     assert.equal(failed.exitCode, 1);
     assert.match(failedLogs, /CLI create-api-key failed \(command error, exit status 23\)/);
     for (const [streamName, logs] of [['stdout', failed.stdoutLogs], ['stderr', failed.stderrLogs]]) {
       const output = logs.join('\n');
       for (const marker of [messageMarker, stdoutMarker, stderrMarker]) {
         assert.ok(!output.includes(marker), `${marker} is not logged to ${streamName}`);
       }
     }

     const invalidStatusError = Object.assign(new Error('synthetic process error'), { status: 256 });
     const invalidStatus = await runBootstrap(makeWorld({ cliApiKeyError: invalidStatusError }), {
       env: { CHIRPSTACK_API_KEY: '' },
     });
     const invalidStatusLogs = [...invalidStatus.stdoutLogs, ...invalidStatus.stderrLogs].join('\n');
     assert.equal(invalidStatus.exitCode, 1);
     assert.match(invalidStatusLogs, /CLI create-api-key failed \(command error\)/);
     assert.doesNotMatch(invalidStatusLogs, /exit status/);
   });
   ```

No test inventory file changes are planned: this already tracked test is explicitly run by
`.github/workflows/verify-sync-flow.yml` and the inventory verifier recognizes
it through `scripts/verify-sync-flow.js`.

## Execution order and exact gates

1. Add the test harness injections and the test above, without changing
   production code.
2. Run
   `node --test --test-name-pattern="CLI key creation failures do not log output or process errors" scripts/test-chirpstack-bootstrap-clover.js`.
   Expected before the fix: the new test fails because the synthetic malformed
   output marker reaches stderr (and the thrown process error's message marker
   reaches stderr). If the failure differs, stop and amend/re-review the plan.
3. Replace the function body in all three production copies with the exact
   code above. Run the same focused command; expected: one matching test passes
   and unrelated tests are skipped by the name filter.
4. The first `node scripts/verify-sync-flow.js` attempt exited 1 before its
   database checks because this Windows environment has no `sqlite3.exe` on
   `PATH` (`spawnSync sqlite3 ENOENT`). The repository workflow installs this
   prerequisite on Ubuntu. For local verification, fetch the official SQLite
   3.54.1 Windows x64 CLI into a temporary tools directory, verify the official
   SHA3-256, and add that directory to this PowerShell process's `PATH` using
   exactly these commands from the repository root:

   ```powershell
   $tempRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $env:TEMP).Path).TrimEnd('\') + '\'
   $sqliteDir = Join-Path $tempRoot 'osi-522-sqlite-tools-3540100'
   $sqliteZip = Join-Path $tempRoot 'osi-522-sqlite-tools-win-x64-3540100.zip'
   if (Test-Path -LiteralPath $sqliteDir) { throw "SQLite scratch directory already exists: $sqliteDir" }
   if (Test-Path -LiteralPath $sqliteZip) { throw "SQLite archive path already exists: $sqliteZip" }
   New-Item -ItemType Directory -Path $sqliteDir | Out-Null
   Invoke-WebRequest -Uri 'https://www.sqlite.org/2026/sqlite-tools-win-x64-3540100.zip' -OutFile $sqliteZip
   $sqliteHash = node -e "const fs=require('node:fs');const crypto=require('node:crypto');process.stdout.write(crypto.createHash('sha3-256').update(fs.readFileSync(process.argv[1])).digest('hex'))" $sqliteZip
   if ($LASTEXITCODE -ne 0 -or $sqliteHash -ne 'e171f3993a992edf076746926dd52b5e2ebfabaee38818e74987e1d8112ab987') { throw "SQLite archive SHA3-256 mismatch: $sqliteHash" }
   Expand-Archive -LiteralPath $sqliteZip -DestinationPath $sqliteDir -Force
   if (-not (Test-Path -LiteralPath (Join-Path $sqliteDir 'sqlite3.exe'))) { throw 'sqlite3.exe missing from verified SQLite archive' }
   $env:PATH = "$sqliteDir;$env:PATH"
   $sqliteVersion = & (Join-Path $sqliteDir 'sqlite3.exe') --version
   if ($LASTEXITCODE -ne 0 -or $sqliteVersion -notmatch '^3\.54\.1\b') { throw "Unexpected SQLite CLI version: $sqliteVersion" }
   ```

   The expected product, version, archive size, and digest are published by
   SQLite's official download page. Keep the downloaded archive and extracted
   files until independent verification finishes. Perform all temporary-tool
   cleanup once, under the exact path, content, reparse, and hash checks in
   Step 8; do not remove the tool directory or Windows zip earlier.

5. The first sync-flow attempt also skipped its durable upgrade-path leg:
   this worktree was shallow, while `.github/workflows/verify-sync-flow.yml`
   explicitly fetches full history so `scripts/test-sync-history-schema.js`
   can read pinned baseline commit `0d925c6f16a3a8145bf464737783e4baff41eeea`.
   Verify `origin` is upstream, then unshallow only its `main` history while
   filtering blobs; confirm the clone is no longer shallow and the pinned
   baseline commit exists:

   ```powershell
   $originUrl = git remote get-url origin
   if ($LASTEXITCODE -ne 0 -or $originUrl -ne 'https://github.com/Open-Smart-Irrigation/osi-os.git') { throw "Unexpected origin URL: $originUrl" }
   git fetch --unshallow --filter=blob:none origin main
   if ($LASTEXITCODE -ne 0) { throw 'Failed to fetch full upstream main history' }
   $shallow = git rev-parse --is-shallow-repository
   if ($LASTEXITCODE -ne 0 -or $shallow -ne 'false') { throw "Repository remains shallow: $shallow" }
   git cat-file -e '0d925c6f16a3a8145bf464737783e4baff41eeea^{commit}'
   if ($LASTEXITCODE -ne 0) { throw 'Pinned durable upgrade-path baseline commit is unavailable' }
   ```

   Expected: the upstream URL matches, `git fetch` exits 0, the shallow check
   prints `false`, and the pinned commit lookup exits 0. The first gate attempt
   was interrupted after its documented skip and is not counted as passing.

6. With full history, the sync-flow rerun reached an unrelated raw-byte
   assertion in `scripts/test-terra-selection-edge-acceptance.js:347`. After
   normalizing that JSON fixture and its test file, the next run passed the
   fixture-byte assertion and failed on line 350 because the paired `.sha256`
   sidecar still had a CRLF worktree newline while the test expects LF.
   `git ls-files --eol` showed `i/lf w/crlf` for the JSON fixture, its `.sha256`
   sidecar, and its test file even though the temporary clone has
   `core.autocrlf=false`. A previous
   `git checkout-index --force --all` and then a path-scoped
   `git checkout-index --force` both returned success but left the known files
   unchanged. `core.autocrlf=false` is set in the temporary clone, no matching
   filters or attributes were found, and the cause is unresolved. Normalize
   only those three known files by writing exact index blobs for files that
   still differ, after proving that index equals HEAD and any difference is
   solely CRLF conversion. The JSON fixture and test file already match the
   index after the prior selective write; this step should normalize only the
   sidecar. Keep the four planned source/test edits and both plan records
   untouched:

   ```powershell
   $eolPaths = @('scripts/fixtures/terra-edge-selection/edge-selection-v1.json','scripts/fixtures/terra-edge-selection/edge-selection-v1.sha256','scripts/test-terra-selection-edge-acceptance.js')
   $assertEolPaths = @'
   const fs=require('node:fs');
   const path=require('node:path');
   const cp=require('node:child_process');
   const root=fs.realpathSync('.');
   for(const p of process.argv.slice(1)){
     const absolute=path.resolve(p);
     const real=fs.realpathSync(p);
     const relative=path.relative(root,real);
     const stat=fs.lstatSync(p);
     if(real.toLowerCase()!==absolute.toLowerCase()||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('target path resolves outside or through a link: '+p);
     if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error('target is not a single-link regular file: '+p);
     const work=fs.readFileSync(p);
     const index=cp.execFileSync('git',['show',':'+p]);
     const head=cp.execFileSync('git',['show','HEAD:'+p]);
     if(!index.equals(head))throw new Error('index differs from HEAD: '+p);
     if(!work.equals(index)&&(!work.includes(Buffer.from('\r\n'))||!Buffer.from(work.toString('utf8').replace(/\r\n/g,'\n'),'utf8').equals(index)))throw new Error('worktree is not only CRLF-normalized from index: '+p);
   }
   console.log('All three known files are regular single-link files and are either index-identical or differ only by CRLF line endings');
   '@
   node -e $assertEolPaths $eolPaths
   if ($LASTEXITCODE -ne 0) { throw 'Refusing to overwrite a file whose only difference is not CRLF conversion' }
   $writeIndexBytes = @'
   const fs=require('node:fs');
   const path=require('node:path');
   const cp=require('node:child_process');
   const root=fs.realpathSync('.');
   for(const p of process.argv.slice(1)){
     const absolute=path.resolve(p);
     const real=fs.realpathSync(p);
     const relative=path.relative(root,real);
     const stat=fs.lstatSync(p);
     if(real.toLowerCase()!==absolute.toLowerCase()||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('target path resolves outside or through a link: '+p);
     if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error('target is not a single-link regular file: '+p);
     const index=cp.execFileSync('git',['show',':'+p]);
     const head=cp.execFileSync('git',['show','HEAD:'+p]);
     if(!index.equals(head))throw new Error('index differs from HEAD: '+p);
     const existing=fs.readFileSync(p);
     if(!existing.equals(index)){
       if(!existing.includes(Buffer.from('\r\n'))||!Buffer.from(existing.toString('utf8').replace(/\r\n/g,'\n'),'utf8').equals(index))throw new Error('worktree changed beyond CRLF conversion: '+p);
       fs.writeFileSync(p,index);
     }
     const work=fs.readFileSync(p);
     if(!work.equals(index)||!work.equals(head))throw new Error('file did not restore byte-identically to HEAD/index: '+p);
   }
   console.log('All three files now match HEAD and index byte-for-byte');
   '@
   node -e $writeIndexBytes $eolPaths
   if ($LASTEXITCODE -ne 0) { throw 'Writing exact index bytes did not restore all known files' }
   git ls-files --eol -- $eolPaths
   git diff --quiet -- $eolPaths
   if ($LASTEXITCODE -ne 0) { throw 'Normalized paths still differ from the index' }
   git add -- $eolPaths
   if ($LASTEXITCODE -ne 0) { throw 'Could not refresh the three normalized paths from their verified index-identical bytes' }
   git diff --cached --quiet -- $eolPaths
   if ($LASTEXITCODE -ne 0) { throw 'Index content changed while refreshing stat data' }
   git diff --quiet -- $eolPaths
   if ($LASTEXITCODE -ne 0) { throw 'Normalized paths still differ from the index after refresh' }
   git status --short --untracked-files=all
   ```

   Expected: all three files show `i/lf w/lf`, both scoped diffs exit 0, the
   `git add` exits 0, the cached and unstaged scoped diffs both exit 0, and
   status lists exactly the four planned modifications and two plan records.
   A trial `git update-index --refresh -- $eolPaths` returned nonzero while
   reporting the already-planned modified source files as needing update, so
   use `git add` on the three exact paths only after proving all three worktree
   files equal index/HEAD. The cached diff assertions ensure no content is
   staged. This changes only the
   dedicated temporary clone's worktree bytes; exact index blob bytes were
   written only after confirming the old worktree bytes contained no change
   beyond CRLF conversion. The files now remain identical to HEAD and the
   index, so no EOL changes enter the commit. Stop if either precondition or
   postcondition fails.

   **Recovery for the interrupted first attempt in this worktree:** the stash
   was created as `stash@{0}` with commit
   `b9b4df6972935ef78611ebc8716b2f11d6bec8d0`. The first
   `git checkout-index --force --all` attempt did not normalize the two known
   unrelated fixture/test files; `git ls-files --eol` still reported
   `i/lf w/crlf`. It did restore the four tracked planned files byte-identically
   to HEAD, but the index still held their prior CRLF stat sizes; `git status`
   therefore reported four stale `M` entries even though `git diff --quiet`
   returned 0. A first
   `git stash apply` stopped on those stale entries and restored the two plan
   files from the stash's untracked parent. This plan has since been amended,
   so do not restore its older stash copy. Resume from that exact state with
   these commands; they verify current tracked files are still exactly HEAD,
   then apply only the four tracked-file changes from the stash while keeping
   the current plan and review records in place:

   ```powershell
   $stashRef = 'stash@{0}'
   $stashSha = git rev-parse $stashRef
   if ($LASTEXITCODE -ne 0 -or $stashSha -ne 'b9b4df6972935ef78611ebc8716b2f11d6bec8d0') { throw "Unexpected recovery stash: $stashSha" }
   $trackedPaths = @('conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/chirpstack-bootstrap.js','conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js','scripts/chirpstack-bootstrap.js','scripts/test-chirpstack-bootstrap-clover.js')
   node -e "const fs=require('node:fs');const cp=require('node:child_process');for(const p of process.argv.slice(1)){const work=fs.readFileSync(p);const head=cp.execFileSync('git',['show','HEAD:'+p]);const index=cp.execFileSync('git',['show',':'+p]);if(!work.equals(head)||!work.equals(index)){console.error('tracked file not at HEAD: '+p);process.exitCode=1}}" $trackedPaths
   if ($LASTEXITCODE -ne 0) { throw 'Tracked recovery files are not byte-identical to HEAD and the index' }
   node -e "const cp=require('node:child_process');const ref='stash@{0}';const paths=process.argv.slice(1);const changed=cp.execFileSync('git',['diff','--name-only','HEAD',ref],{encoding:'utf8'}).trim().split(/\r?\n/).filter(Boolean).sort();if(JSON.stringify(changed)!==JSON.stringify([...paths].sort()))throw new Error('Stash tracked path set differs: '+changed.join(','));const patch=cp.execFileSync('git',['diff','--binary','--no-ext-diff','HEAD',ref,'--',...paths]);if(!patch.length)throw new Error('Stash tracked patch is empty');cp.execFileSync('git',['apply','--'],{input:patch});console.log('Applied only '+changed.length+' tracked paths from the verified stash')" $trackedPaths
   if ($LASTEXITCODE -ne 0) { throw 'Failed to apply the verified tracked patch from the stash' }
   git status --short --untracked-files=all
   ```

   Expected: the stash SHA matches, current tracked files match HEAD/index
   before patch application, the stash contains exactly those four tracked
   paths, patch application exits 0, and status lists exactly four tracked
   modifications and the two current plan records. Keep the stash as a
   recovery backup until the change is committed; do not continue if any
   assertion fails.

7. Run the complete relevant checks from the repository root, each as an
   independent command and preserving its exit code:
   - node --test scripts/test-chirpstack-bootstrap-clover.js — all tests pass.
   - node scripts/verify-profile-parity.js — prints All parity checks passed.
   - node scripts/verify-test-inventory.js — prints its success summary.
   - The native Windows run of node scripts/verify-sync-flow.js reached
     scripts/installation-recovery-adapter.test.js and failed two unrelated
     platform-assumption cases: the CLI rejected the generated C:\... temp
     root where the adapter tests expect POSIX absolute-path semantics, and
     the test could not lstat /data/db/farming.db on Windows. The test runner
     is written for a POSIX host. An Ubuntu WSL distro is available with Linux
     Node v22.22.1 and working node:sqlite. The repository is mounted at
     /mnt/c/Users/djwar/AppData/Local/Temp/osi-os-wt-522. The first WSL attempt
     used the digest-verified Windows SQLite 3.54.1 executable through WSL
     interop and failed at database integrity: that Windows executable could
     not open the Linux-style /mnt/c/.../farming.db path. Do not retry that
     wrapper.

     Use the official SQLite 3.54.1 Linux x64 archive. Its published download
     URL is https://www.sqlite.org/2026/sqlite-tools-linux-x64-3540100.zip and
     its published SHA3-256 is
     555635de98534d87a67ee2e6e1b0d79f494b1b33b223477d3e7a8ea0c66e416f.
     Download to the existing temporary tools folder, verify its SHA3-256
     before WSL reads it, and use native Linux Node and SQLite. The WSL run
     against the mounted Windows worktree progressed through database checks
     but then failed because Git symlinks appear as regular placeholder text
     under /mnt/c: for example, Node tried to parse the content
     ../osi-history-helper as JavaScript, and the osi-db-helper module was not
     available. The Git index records these entries as symlinks. Do not rerun
     the suite against the mounted worktree.

     Build and reuse a native checkout at
     /root/osi-os-522-linux-native-20261025. The runner first checks out the
     current index there with core.symlinks=true, then overlays only the four
     changed tracked files and two untracked plan records from the mounted
     checkout. It verifies that every indexed symlink is materialized and
     checks the six overlays against the source copy. Keep this native copy
     until the independent verifier and PR creation finish; remove it afterward
     using the guarded cleanup in Step 11. The first native run showed that
     umask 077 made indexed executable files mode 700 instead of the expected
     755. Keep the checkout root at mode 700, but use umask 022 during
     checkout-index so Git materializes each tracked file with its indexed
     executable mode.

     The WSL worktree .git file contains a Windows absolute path, so set GIT_DIR
     and GIT_WORK_TREE explicitly for Git subprocesses. Create one guarded
     LF-only WSL runner script in Windows TEMP. It extracts only the single
     regular sqlite3 member from the verified zip to a unique Linux /tmp
     directory created with mode 0700. It installs SQLite cleanup only after
     mkdir succeeds and sets its ownership flag, verifies the extracted binary
     version and hash, runs all five gates from the native checkout, and
     removes only that unchanged binary and its empty unique directory.

     Download and hash verification in PowerShell:

     ~~~~powershell
     $sqliteToolsDir = Join-Path $env:TEMP 'osi-522-sqlite-tools-3540100'
     $sqliteLinuxZip = Join-Path $sqliteToolsDir 'sqlite-tools-linux-x64-3540100.zip'
     $expectedLinuxZipSha3 = '555635de98534d87a67ee2e6e1b0d79f494b1b33b223477d3e7a8ea0c66e416f'
     $tempRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $env:TEMP).Path).TrimEnd('\') + '\'
     $zipFullPath = [IO.Path]::GetFullPath($sqliteLinuxZip)
     if (-not $zipFullPath.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "SQLite archive escaped TEMP: $zipFullPath" }
     if ((Get-Item -LiteralPath $sqliteToolsDir).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'SQLite tools directory is a reparse point' }
     if (Test-Path -LiteralPath $sqliteLinuxZip) { throw "SQLite Linux archive already exists: $sqliteLinuxZip" }
     Invoke-WebRequest -Uri 'https://www.sqlite.org/2026/sqlite-tools-linux-x64-3540100.zip' -OutFile $sqliteLinuxZip
     $actualLinuxZipSha3 = node -e "const fs=require('node:fs');const c=require('node:crypto');process.stdout.write(c.createHash('sha3-256').update(fs.readFileSync(process.argv[1])).digest('hex'))" $sqliteLinuxZip
     if ($actualLinuxZipSha3 -ne $expectedLinuxZipSha3) { throw "SQLite Linux archive SHA3 mismatch: $actualLinuxZipSha3" }
     ~~~~

     Create and run a single-use LF-only WSL runner. The Linux script validates
     the zip member as one regular file named sqlite3, installs an exit trap
     before extraction. PowerShell verifies the published archive SHA3 before
     WSL reads it. WSL first reads the zip into memory, verifies the published
     SHA3 and computes the expected sqlite3 member hash; immediately before
     extraction it reads the archive again, verifies SHA3 over those same
     in-memory bytes, and extracts the member from that verified buffer. The
     runner removes the extracted file only when the unique
     directory contains exactly that regular non-symlink file with the same
     SHA-256 as the verified archive member. PowerShell checks the runner path,
     exact text, and non-reparse status before execution:

     ~~~~powershell
     $wslScriptPath = Join-Path $env:TEMP 'osi-522-wsl-verify-sync-flow-linux-sqlite-20261025.sh'
     $wslTempRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $env:TEMP).Path).TrimEnd('\') + '\'
     $wslScriptFullPath = [IO.Path]::GetFullPath($wslScriptPath)
     if (-not $wslScriptFullPath.StartsWith($wslTempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "WSL script escaped TEMP: $wslScriptFullPath" }
     if (Test-Path -LiteralPath $wslScriptPath) { throw "WSL script path already exists: $wslScriptPath" }
     $wslScript = @'
     #!/usr/bin/env bash
     set -euo pipefail
     tool=/tmp/osi-522-sqlite-cli-linux-20261025
     archive=/mnt/c/Users/djwar/AppData/Local/Temp/osi-522-sqlite-tools-3540100/sqlite-tools-linux-x64-3540100.zip
     mounted=/mnt/c/Users/djwar/AppData/Local/Temp/osi-os-wt-522
     repo=/root/osi-os-522-linux-native-20261025
     gitdir=/mnt/c/Users/djwar/AppData/Local/Temp/codex-osi-os-522-20261025/.git/worktrees/osi-os-wt-522
     [[ -r "$archive" ]]
     [[ $(node --version) == v22.22.1 ]]
     export GIT_DIR="$gitdir"
     export GIT_WORK_TREE="$mounted"
     [[ $(git rev-parse HEAD) == 63c7a70f8f3b373f162b33b0669b0df89b3763fa ]]
     git diff --cached --quiet
     if [[ ! -e "$repo" && ! -L "$repo" ]]; then
       umask 022
       mkdir -m 700 "$repo"
     else
       [[ -d "$repo" && ! -L "$repo" ]]
       [[ $(stat -c '%a' "$repo") == 700 ]]
     fi
     umask 022
     export GIT_WORK_TREE="$repo"
     git -c core.symlinks=true checkout-index --force --all --prefix="$repo/"
     [[ $(stat -c '%a' "$repo") == 700 ]]
     copy_mode=copy
     expected_links=$(git ls-files -s | awk '$1 == "120000" { count += 1 } END { print count + 0 }')
     [[ "$expected_links" == 53 ]]
     actual_links=$(find "$repo" -type l | wc -l | tr -d '[:space:]')
     [[ "$expected_links" == "$actual_links" ]]
     for path in \
       scripts/chirpstack-bootstrap.js \
       conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js \
       conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/chirpstack-bootstrap.js \
       scripts/test-chirpstack-bootstrap-clover.js \
       docs/superpowers/plans/2026-10-25-chirpstack-cli-api-key-output-redaction.md \
       docs/superpowers/plans/2026-10-25-chirpstack-cli-api-key-output-redaction-review.md
     do
       [[ -f "$mounted/$path" && ! -L "$mounted/$path" ]]
       mkdir -p "$(dirname "$repo/$path")"
       [[ ! -L "$repo/$path" ]]
       if [[ "$copy_mode" == copy ]]; then
         cp -- "$mounted/$path" "$repo/$path"
       else
         cmp -s "$mounted/$path" "$repo/$path"
       fi
       [[ -f "$repo/$path" && ! -L "$repo/$path" ]]
     done
     git diff --cached --quiet
     actual_tracked=$(git diff --name-only | LC_ALL=C sort)
     expected_tracked=$(printf '%s\n' \
       conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/chirpstack-bootstrap.js \
       conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js \
       scripts/chirpstack-bootstrap.js \
       scripts/test-chirpstack-bootstrap-clover.js | LC_ALL=C sort)
     [[ "$actual_tracked" == "$expected_tracked" ]]
     actual_untracked=$(git ls-files --others --exclude-standard | LC_ALL=C sort)
     expected_untracked=$(printf '%s\n' \
       docs/superpowers/plans/2026-10-25-chirpstack-cli-api-key-output-redaction-review.md \
       docs/superpowers/plans/2026-10-25-chirpstack-cli-api-key-output-redaction.md | LC_ALL=C sort)
     [[ "$actual_untracked" == "$expected_untracked" ]]
     [[ ! -e "$tool" && ! -L "$tool" ]]
     expected_hash=$(python3 -c 'import hashlib,io,stat,sys,zipfile; raw=open(sys.argv[1],"rb").read(); assert hashlib.sha3_256(raw).hexdigest()=="555635de98534d87a67ee2e6e1b0d79f494b1b33b223477d3e7a8ea0c66e416f"; z=zipfile.ZipFile(io.BytesIO(raw)); m=[i for i in z.infolist() if not i.is_dir() and i.filename.rstrip("/").split("/")[-1]=="sqlite3"]; assert len(m)==1; assert not stat.S_ISLNK(m[0].external_attr >> 16); print(hashlib.sha256(z.read(m[0])).hexdigest())' "$archive")
     [[ "$expected_hash" =~ ^[0-9a-f]{64}$ ]]
     umask 077
     mkdir -m 700 "$tool"
     created=1
     cleanup() {
       result=$?
       trap - EXIT
       if [[ "$created" != 1 ]]; then echo "SQLite temp directory ownership not established" >&2; exit 1; fi
       if [[ -e "$tool" || -L "$tool" ]]; then
         if [[ ! -d "$tool" || -L "$tool" ]]; then echo "Unsafe SQLite temp path retained: $tool" >&2; exit 1; fi
         entries=$(find "$tool" -mindepth 1 -maxdepth 1 -printf '%f')
         if [[ -z "$entries" ]]; then
           rmdir -- "$tool"
         elif [[ "$entries" == sqlite3 && -f "$tool/sqlite3" && ! -L "$tool/sqlite3" && $(sha256sum "$tool/sqlite3" | cut -d' ' -f1) == "$expected_hash" ]]; then
           rm -- "$tool/sqlite3"
           rmdir -- "$tool"
         else
           echo "Unexpected SQLite temp contents retained: $tool" >&2
           exit 1
         fi
       fi
       exit "$result"
     }
     trap cleanup EXIT
     python3 -c 'import hashlib,io,stat,sys,zipfile; raw=open(sys.argv[1],"rb").read(); assert hashlib.sha3_256(raw).hexdigest()=="555635de98534d87a67ee2e6e1b0d79f494b1b33b223477d3e7a8ea0c66e416f"; z=zipfile.ZipFile(io.BytesIO(raw)); m=[i for i in z.infolist() if not i.is_dir() and i.filename.rstrip("/").split("/")[-1]=="sqlite3"]; assert len(m)==1; assert not stat.S_ISLNK(m[0].external_attr >> 16); open(sys.argv[2],"wb").write(z.read(m[0]))' "$archive" "$tool/sqlite3"
     chmod 0755 "$tool/sqlite3"
     actual_hash=$(sha256sum "$tool/sqlite3" | cut -d' ' -f1)
     [[ "$actual_hash" == "$expected_hash" ]]
     version=$("$tool/sqlite3" --version)
     [[ "$version" == 3.54.1* ]]
     node -e 'const {DatabaseSync}=require("node:sqlite"); new DatabaseSync(":memory:").prepare("select 1").get()'
     cd "$repo"
     export GIT_DIR="$gitdir"
     export GIT_WORK_TREE="$repo"
     PATH="$tool:$PATH" node --test scripts/test-chirpstack-bootstrap-clover.js
     node scripts/verify-profile-parity.js
     node scripts/verify-test-inventory.js
     PATH="$tool:$PATH" node scripts/verify-sync-flow.js
     git diff --check
     '@
     $crlf = [string][char]13 + [string][char]10
     $lf = [string][char]10
     $wslScriptLf = $wslScript.Replace($crlf, $lf)
     [IO.File]::WriteAllText($wslScriptPath, $wslScriptLf, [Text.UTF8Encoding]::new($false))
     if ([IO.File]::ReadAllText($wslScriptPath) -ne $wslScriptLf) { throw 'WSL script text differs from the prepared LF script' }
     if ((Get-Item -LiteralPath $wslScriptPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'WSL runner script is a reparse point; refusing execution' }
     wsl -d Ubuntu -- bash /mnt/c/Users/djwar/AppData/Local/Temp/osi-522-wsl-verify-sync-flow-linux-sqlite-20261025.sh
     if ($LASTEXITCODE -ne 0) { throw "WSL verify-sync-flow failed with exit $LASTEXITCODE" }
     ~~~~

     Expected: native Linux SQLite reports 3.54.1; Ubuntu Node runs all five
     checks successfully from the symlink-preserving native checkout. The two
     WSL failures above are checkout-representation issues, not product-code
     failures. Do not change unrelated tests to accommodate Windows or WSL
     mount behavior.
   - git diff --check — exits 0 with no output.
8. Compare the three production copies with Get-FileHash; all three SHA-256
   values must match. Review the final diff against this plan and the issue
   requirements. The independent verifier must freshly rerun all five checks
   above, confirm the final diff and mirror hashes, and independently probe
   malformed output, command-error message/stdout/stderr, bounded status, and
   success behavior using synthetic values only.
   Keep the PowerShell variables from the setup block in the same session until
   cleanup. After independent verification, run these guarded commands. They
   validate TEMP containment, reject reparse points, verify the runner text,
   require the exact expected tools-folder children, and recheck both published
   ZIP hashes. Then remove only those verified files and the now-empty tools
   directory. Do not remove the stash recovery backup until the change is
   committed and its integrity is verified:

   ~~~~powershell
   $cleanupTempRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $env:TEMP).Path).TrimEnd('\') + '\'
   $cleanupScriptFullPath = [IO.Path]::GetFullPath($wslScriptPath)
   $cleanupToolDir = Join-Path $cleanupTempRoot 'osi-522-sqlite-tools-3540100'
   $cleanupWindowsZip = Join-Path $cleanupTempRoot 'osi-522-sqlite-tools-win-x64-3540100.zip'
   $cleanupLinuxZip = Join-Path $cleanupToolDir 'sqlite-tools-linux-x64-3540100.zip'
   $cleanupToolDirFullPath = [IO.Path]::GetFullPath($cleanupToolDir)
   $cleanupWindowsZipFullPath = [IO.Path]::GetFullPath($cleanupWindowsZip)
   $cleanupLinuxZipFullPath = [IO.Path]::GetFullPath($cleanupLinuxZip)
   foreach ($path in @($cleanupScriptFullPath, $cleanupToolDirFullPath, $cleanupWindowsZipFullPath, $cleanupLinuxZipFullPath)) {
     if (-not $path.StartsWith($cleanupTempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Cleanup target escaped TEMP: $path" }
     $item = Get-Item -LiteralPath $path
     if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Cleanup target is a reparse point: $path" }
   }
   if ((Get-Item -LiteralPath $cleanupScriptFullPath).Attributes -band [IO.FileAttributes]::Directory) { throw 'WSL runner is a directory' }
   if (((Get-Item -LiteralPath $cleanupToolDirFullPath).Attributes -band [IO.FileAttributes]::Directory) -eq 0) { throw 'SQLite tools path is not a directory' }
   if ((Get-Item -LiteralPath $cleanupWindowsZipFullPath).Attributes -band [IO.FileAttributes]::Directory) { throw 'Windows SQLite archive is a directory' }
   if ((Get-Item -LiteralPath $cleanupLinuxZipFullPath).Attributes -band [IO.FileAttributes]::Directory) { throw 'Linux SQLite archive is a directory' }
   if ([IO.File]::ReadAllText($cleanupScriptFullPath) -ne $wslScriptLf) { throw 'WSL runner text changed; refusing cleanup' }
   $reparseChildren = Get-ChildItem -LiteralPath $cleanupToolDirFullPath -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
   if ($reparseChildren) { throw 'SQLite tools directory contains a reparse point; refusing cleanup' }
   $expectedChildren = @('sqlite-tools-linux-x64-3540100.zip','sqlite3.exe','sqlite3_analyzer.exe','sqlite3_rsync.exe','sqldiff.exe') | Sort-Object
   $actualChildren = @(Get-ChildItem -LiteralPath $cleanupToolDirFullPath -Force | ForEach-Object { $_.Name } | Sort-Object)
   if (Compare-Object -ReferenceObject $expectedChildren -DifferenceObject $actualChildren) { throw "Unexpected SQLite tools directory contents: $($actualChildren -join ', ')" }
   $cleanupLinuxSha3 = node -e "const fs=require('node:fs');const c=require('node:crypto');process.stdout.write(c.createHash('sha3-256').update(fs.readFileSync(process.argv[1])).digest('hex'))" $cleanupLinuxZipFullPath
   if ($cleanupLinuxSha3 -ne $expectedLinuxZipSha3) { throw 'SQLite Linux archive hash changed; refusing cleanup' }
   $cleanupWindowsSha3 = node -e "const fs=require('node:fs');const c=require('node:crypto');process.stdout.write(c.createHash('sha3-256').update(fs.readFileSync(process.argv[1])).digest('hex'))" $cleanupWindowsZipFullPath
   if ($cleanupWindowsSha3 -ne 'e171f3993a992edf076746926dd52b5e2ebfabaee38818e74987e1d8112ab987') { throw 'SQLite Windows archive hash changed; refusing cleanup' }
   Remove-Item -LiteralPath $cleanupScriptFullPath -Force
   Remove-Item -LiteralPath $cleanupWindowsZipFullPath -Force
   Remove-Item -LiteralPath $cleanupLinuxZipFullPath -Force
   Remove-Item -LiteralPath (Join-Path $cleanupToolDirFullPath 'sqlite3.exe') -Force
   Remove-Item -LiteralPath (Join-Path $cleanupToolDirFullPath 'sqlite3_analyzer.exe') -Force
   Remove-Item -LiteralPath (Join-Path $cleanupToolDirFullPath 'sqlite3_rsync.exe') -Force
   Remove-Item -LiteralPath (Join-Path $cleanupToolDirFullPath 'sqldiff.exe') -Force
   Remove-Item -LiteralPath $cleanupToolDirFullPath -Force
   ~~~~
9. Commit the plan, its review record, the three production copies, and the
   test as one commit:
   `fix: redact ChirpStack API key CLI failures`
10. The connected GitHub identity has been verified as `dannyward630`; the
   repository `dannyward630/osi-os` currently returns 404 and no fork remote
   exists. Create the fork of `Open-Smart-Irrigation/osi-os` under that account
   through GitHub's fork UI. Before pushing, retrieve its repository metadata
   and require `full_name == dannyward630/osi-os` and
   `parent.full_name == Open-Smart-Irrigation/osi-os`. Then add and verify this
   exact remote:

   ```powershell
   git remote add user-fork https://github.com/dannyward630/osi-os.git
   $pushUrl = git remote get-url --push user-fork
   if ($pushUrl -ne 'https://github.com/dannyward630/osi-os.git') { throw "Unexpected fork push URL: $pushUrl" }
   ```

   Push only `fix/522-redact-api-key-cli-errors` to `user-fork`:
   `git push -u user-fork fix/522-redact-api-key-cli-errors`. Never push this
   branch to `origin`, which points to upstream. Confirm the pushed branch
   commit with `git ls-remote user-fork refs/heads/fix/522-redact-api-key-cli-errors`
   and compare it to local `git rev-parse HEAD`. Open a PR against
   `Open-Smart-Irrigation/osi-os:main` for #522 with a body that documents the
   root cause, the fixed categories and metadata bound, the three profile
   copies, and the exact passing check outputs. Stop before pushing if the
   fork parent/owner or configured push URL does not match the verified target.

11. After the PR is created and the independent verifier has finished, remove
    the native WSL checkout created solely for this gate. The path was checked
    absent before creation and its root directory is mode 0700. Validate the
    exact root, owner, mode, non-symlink status, and a known source file before
    deleting only that tree with find; find will unlink symlinks without
    following their targets:

    ~~~~bash
    repo=/root/osi-os-522-linux-native-20261025
    [[ "$repo" == /root/osi-os-522-linux-native-20261025 ]]
    [[ -d "$repo" && ! -L "$repo" ]]
    [[ "$(stat -c '%u:%a' "$repo")" == 0:700 ]]
    [[ -f "$repo/scripts/chirpstack-bootstrap.js" && ! -L "$repo/scripts/chirpstack-bootstrap.js" ]]
    [[ ! -e "$repo/.git" && ! -L "$repo/.git" ]]
    find "$repo" -xdev -depth -delete
    [[ ! -e "$repo" && ! -L "$repo" ]]
    ~~~~

## Required review record

Commit `docs/superpowers/plans/2026-10-25-chirpstack-cli-api-key-output-redaction-review.md`
with the change. It must record the reviewer context, date, plan path, each
REQUIRED and OPTIONAL finding verbatim or faithfully summarized, the concrete
plan disposition for each finding, and the reviewer’s final re-review result.

Do not access any live gateway, invoke `chirpstack`, use a real token, or
change deployment state. Stop and report if any command output differs from
its expected result or the repository requires a procedure not captured here.
