# Mapbox Token Env Var Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded Mapbox public token in `terra-intelligence/src/App.tsx` with a `VITE_MAPBOX_TOKEN` environment variable so the token can be rotated without a code change.

**Architecture:** The token is read from `import.meta.env.VITE_MAPBOX_TOKEN` inside the map-creation `useEffect`, not stored in a module-level constant. This keeps `vi.stubEnv()` tests valid because the env read happens after each test sets the env value. TypeScript types are declared in the existing `vite-env.d.ts`, an empty-token guard surfaces a human-readable warning through `tokenError`, and the backend Gradle packaging task tracks `VITE_MAPBOX_TOKEN` as an input so token rotation invalidates the Terra frontend build.

**Tech Stack:** React 18, TypeScript, Vite 8, Vitest 3, Testing Library — all within `terra-intelligence/`.

**Working directory for all commands:** `terra-intelligence/` inside the worktree at `/home/phil/Repos/osi-server/.worktrees/terra-mobile-fixes/terra-intelligence/`

---

## Code Quality Guidelines

- **TypeScript strict** — no `any`; `noUnusedLocals` must be clean after every commit
- **Env reads inside effects** — `import.meta.env.VITE_MAPBOX_TOKEN` must be read inside the `useEffect` that creates the map, never at module level, so `vi.stubEnv()` calls take effect before the read
- **One commit per task** — use the commit messages shown in each step; they follow Conventional Commits (`fix(terra):`, `refactor(terra):`, `test(terra):`)
- **TDD** — write the failing test, confirm it fails, implement, confirm it passes; never commit a failing test without the paired implementation commit

## Design Principles

- **YAGNI** — the empty-token guard emits one `tokenError` string; no retry logic, async env loading, or fallback tokens
- **DRY** — the token is read in exactly one place: `import.meta.env.VITE_MAPBOX_TOKEN?.trim() ?? ''` inside the map creation `useEffect`; no copies at module level or in other effects
- **Fail visibly** — a missing token renders an immediate, readable UI warning; silent map-initialization failures are much harder to debug than an early exit through `tokenError`

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/vite-env.d.ts` | Modify | Add `ImportMetaEnv` interface declaring `VITE_MAPBOX_TOKEN` |
| `.env.example` | Create | Document the required env var for developers |
| `vitest.config.ts` | Modify | Provide `VITE_MAPBOX_TOKEN` test value so existing tests keep passing |
| `src/__tests__/mapboxToken.test.tsx` | Create | TDD: verify token is read from env, verify empty-token warning |
| `src/App.tsx` | Modify | Remove hardcoded token constant; read `import.meta.env.VITE_MAPBOX_TOKEN` inside the map `useEffect`; add empty-token guard |
| `../backend/build.gradle.kts` | Modify | Track `VITE_MAPBOX_TOKEN` as an input of `buildTerraIntelligenceFrontend` so backend packaging rebuilds Terra when the token changes |

---

## Phase 1: TypeScript Infrastructure
*Tasks 1–2 — declare the type, document the env var, and give tests a dummy token value*

---

## Task 1: TypeScript type + `.env.example`

**Files:**
- Modify: `terra-intelligence/src/vite-env.d.ts`
- Create: `terra-intelligence/.env.example`

- [ ] **Step 1: Add `ImportMetaEnv` interface to `vite-env.d.ts`**

The file currently contains only a single reference directive. Replace the entire file with:

```typescript
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAPBOX_TOKEN: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
```

- [ ] **Step 2: Create `.env.example`**

Create `terra-intelligence/.env.example` with:

```
# Mapbox public token (pk.*) — required for satellite imagery.
# Get the token from the Mapbox dashboard at https://account.mapbox.com/
# Copy this file to .env and fill in the value:
VITE_MAPBOX_TOKEN=
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd terra-intelligence && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add terra-intelligence/src/vite-env.d.ts terra-intelligence/.env.example
git commit -m "chore(terra): declare VITE_MAPBOX_TOKEN type and add .env.example"
```

---

## Task 2: Vitest config — provide test token

**Files:**
- Modify: `terra-intelligence/vitest.config.ts`

The existing tests render `<App />` which triggers the Mapbox map `useEffect`. After the token moves to `import.meta.env`, tests need a value there or they'll hit the empty-token warning path. Add a dummy token via the vitest `env` option.

- [ ] **Step 1: Add `env` to vitest config**

Current `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
```

Replace with:

```typescript
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    env: {
      VITE_MAPBOX_TOKEN: 'pk.test-token-vitest',
    },
  },
});
```

- [ ] **Step 2: Run the full test suite to confirm no regressions**

```bash
cd terra-intelligence && npm test
```

Expected: all existing tests pass (the App.tsx change hasn't happened yet, so the hardcoded token is still in effect — all tests should still pass).

- [ ] **Step 3: Commit**

```bash
git add terra-intelligence/vitest.config.ts
git commit -m "test(terra): provide VITE_MAPBOX_TOKEN dummy value for vitest"
```

### Phase 1 Review Checkpoint

Run the full test suite before writing new tests:

```bash
cd terra-intelligence && npm test
```

All existing tests must pass and TypeScript must compile (`npx tsc --noEmit`). Only then proceed to Phase 2.

---

## Phase 2: TDD Cycle
*Tasks 3–4 — write failing tests, then implement the env var read and empty-token guard*

---

## Task 3: TDD — write failing tests

**Files:**
- Create: `terra-intelligence/src/__tests__/mapboxToken.test.tsx`

Write the two tests before touching `App.tsx`. They will both fail until Task 4.

- [ ] **Step 1: Create the test file**

Create `terra-intelligence/src/__tests__/mapboxToken.test.tsx`:

```typescript
import mapboxgl from 'mapbox-gl';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { mockMapInstance } from './setup';

function mockMapReady() {
  mockMapInstance.on.mockImplementation((event: string, handler: () => void) => {
    if (event === 'load') window.setTimeout(handler, 0);
    return mockMapInstance;
  });
}

describe('Mapbox token configuration', () => {
  beforeEach(() => {
    mockMapReady();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('sets mapboxgl.accessToken from VITE_MAPBOX_TOKEN', async () => {
    vi.stubEnv('VITE_MAPBOX_TOKEN', 'pk.from-env-var');

    render(<App />);

    await waitFor(() => expect(mockMapInstance.on).toHaveBeenCalled());
    expect(mapboxgl.accessToken).toBe('pk.from-env-var');
  });

  it('shows a token warning immediately when VITE_MAPBOX_TOKEN is empty', async () => {
    vi.stubEnv('VITE_MAPBOX_TOKEN', '');

    render(<App />);

    await waitFor(() =>
      expect(screen.getByText(/Mapbox token is not configured/i)).toBeInTheDocument(),
    );
    expect(mockMapInstance.on).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the new tests to confirm they fail**

```bash
cd terra-intelligence && npm test -- --reporter=verbose src/__tests__/mapboxToken.test.tsx
```

Expected output (both tests fail):
```
FAIL  src/__tests__/mapboxToken.test.tsx
  × sets mapboxgl.accessToken from VITE_MAPBOX_TOKEN
  × shows a token warning immediately when VITE_MAPBOX_TOKEN is empty
```

The first test fails because `mapboxgl.accessToken` is set to the hardcoded token string, not `'pk.from-env-var'`. The second test fails because the warning text "Mapbox token is not configured" does not appear.

- [ ] **Step 3: Commit the failing tests**

```bash
git add terra-intelligence/src/__tests__/mapboxToken.test.tsx
git commit -m "test(terra): failing tests for VITE_MAPBOX_TOKEN env var"
```

---

## Task 4: Implementation — read token inside map effect

**Files:**
- Modify: `terra-intelligence/src/App.tsx` (module constants section and the map-creation `useEffect`)

- [ ] **Step 1: Remove the module-level token constant**

Find the module-level constant near the other storage/key constants:
```typescript
const MAPBOX_PUBLIC_TOKEN = '<existing pk.* token>';
```

Delete the entire line. Do not replace it with `const MAPBOX_PUBLIC_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN`; a module-level env const would be evaluated before per-test `vi.stubEnv()` calls.

- [ ] **Step 2: Read the token and add the empty-token guard inside the map `useEffect`**

Find the block that initialises Mapbox (around line 1490–1495, inside the `useEffect` that creates the map). The existing sequence is:

```typescript
    setMapReady(false);
    setTokenError(null);
    didFitField.current = null;
    mapboxgl.accessToken = MAPBOX_PUBLIC_TOKEN;
```

Replace with:

```typescript
    setMapReady(false);
    setTokenError(null);
    didFitField.current = null;

    const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN?.trim() ?? '';
    if (!mapboxToken) {
      setTokenError('Mapbox token is not configured. Set VITE_MAPBOX_TOKEN and rebuild.');
      return;
    }

    mapboxgl.accessToken = mapboxToken;
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd terra-intelligence && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run the new tests — they should now pass**

```bash
cd terra-intelligence && npm test -- --reporter=verbose src/__tests__/mapboxToken.test.tsx
```

Expected:
```
PASS  src/__tests__/mapboxToken.test.tsx
  ✓ sets mapboxgl.accessToken from VITE_MAPBOX_TOKEN
  ✓ shows a token warning immediately when VITE_MAPBOX_TOKEN is empty
```

- [ ] **Step 5: Run the full test suite — confirm no regressions**

```bash
cd terra-intelligence && npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add terra-intelligence/src/App.tsx
git commit -m "refactor(terra): read Mapbox token from VITE_MAPBOX_TOKEN env var

Removes the hardcoded pk.* token from source. The token now comes from
VITE_MAPBOX_TOKEN, inlined at build time by Vite. An empty token renders
a human-readable warning via the existing tokenError state rather than
silently failing at map load time.

Closes #26"
```

### Phase 2 Review Checkpoint

Run the full test suite:

```bash
cd terra-intelligence && npm test
```

Both `mapboxToken.test.tsx` tests must pass. All pre-existing tests must pass. TypeScript must compile (`npx tsc --noEmit`). Only then move to build-system integration.

---

## Phase 3: Build System Integration
*Task 5 — track `VITE_MAPBOX_TOKEN` in Gradle so token rotation invalidates the cached frontend build*

---

## Task 5: Backend packaging tracks token changes

**Files:**
- Modify: `backend/build.gradle.kts`

`bootJar` packages `terra-intelligence/dist` through the `buildTerraIntelligenceFrontend` Exec task. Because Vite inlines env vars at build time, Gradle must treat `VITE_MAPBOX_TOKEN` as an input or a token rotation can reuse stale frontend output.

- [ ] **Step 1: Add `VITE_MAPBOX_TOKEN` as an input property**

In `backend/build.gradle.kts`, find the `buildTerraIntelligenceFrontend` task:

```kotlin
val buildTerraIntelligenceFrontend = tasks.register<Exec>("buildTerraIntelligenceFrontend") {
    workingDir(project.file("../terra-intelligence"))
    commandLine("npm", "run", "build")
    inputs.dir("../terra-intelligence/src")
    inputs.files(
        "../terra-intelligence/index.html",
        "../terra-intelligence/package.json",
        "../terra-intelligence/package-lock.json",
        "../terra-intelligence/vite.config.ts",
        "../terra-intelligence/tsconfig.json",
        "../terra-intelligence/tsconfig.node.json",
    )
    outputs.dir("../terra-intelligence/dist")
}
```

Add the input property before `outputs.dir(...)`:

```kotlin
    inputs.property("viteMapboxToken", providers.environmentVariable("VITE_MAPBOX_TOKEN").orElse(""))
```

The final task block should include:

```kotlin
val buildTerraIntelligenceFrontend = tasks.register<Exec>("buildTerraIntelligenceFrontend") {
    workingDir(project.file("../terra-intelligence"))
    commandLine("npm", "run", "build")
    inputs.dir("../terra-intelligence/src")
    inputs.files(
        "../terra-intelligence/index.html",
        "../terra-intelligence/package.json",
        "../terra-intelligence/package-lock.json",
        "../terra-intelligence/vite.config.ts",
        "../terra-intelligence/tsconfig.json",
        "../terra-intelligence/tsconfig.node.json",
    )
    inputs.property("viteMapboxToken", providers.environmentVariable("VITE_MAPBOX_TOKEN").orElse(""))
    outputs.dir("../terra-intelligence/dist")
}
```

- [ ] **Step 2: Verify backend packaging succeeds with an explicit token**

```bash
cd /home/phil/Repos/osi-server/.worktrees/terra-mobile-fixes/backend
VITE_MAPBOX_TOKEN=pk.test-build-token ./gradlew bootJar --no-daemon
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit**

```bash
git add backend/build.gradle.kts
git commit -m "build(terra): track VITE_MAPBOX_TOKEN for packaged frontend"
```

---

## Appendix: Local Dev and Deployment Setup

This is not a code task — it is a reminder for the person running the plan.

- [ ] **Step 1: Create your local `.env` from the example**

```bash
cp terra-intelligence/.env.example terra-intelligence/.env
```

Then edit `terra-intelligence/.env` and set:

```
VITE_MAPBOX_TOKEN=<Mapbox public token from the deployment secret store>
```

The token value must come from the Mapbox dashboard or the deployment secret store. Do not copy a literal token from source history into this plan or into committed files. This `.env` file is gitignored and must never be committed.

- [ ] **Step 2: Verify the dev server starts correctly**

```bash
cd terra-intelligence && npm run dev
```

Open the printed URL in a browser. The satellite map should load without a token warning. If you see "Mapbox token is not configured", the `.env` file is missing or malformed.

- [ ] **Step 3: Set `VITE_MAPBOX_TOKEN` in the CI/CD environment**

In the deployment pipeline (GitHub Actions, Jenkins, etc.) add `VITE_MAPBOX_TOKEN` as a secret environment variable with the same token value. The `npm run build` step will then inline it. If it is absent, the build will succeed but the deployed app will show the token warning.

---

## Self-Review

**Spec coverage:**
- ✅ Token removed from source → Task 4 Step 1
- ✅ Reads from `VITE_MAPBOX_TOKEN` at effect runtime → Task 4 Step 2
- ✅ `.env.example` documents the variable → Task 1 Step 2
- ✅ Rotation without code change and without stale Gradle packaging → Task 5
- ✅ Missing token → human-readable warning (not silent failure) → Task 4 Step 2
- ✅ URL restriction note → documented in the GitHub issue; not a code task

**Placeholder scan:** None found.

**Type consistency:** No `MAPBOX_PUBLIC_TOKEN` symbol should remain after Task 4. The only runtime token read should be `const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN?.trim() ?? '';` inside the map-creation `useEffect`.
