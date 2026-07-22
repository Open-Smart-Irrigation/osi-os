# OSI Firmware Image Builder

This package will provide the local API, durable queue, deterministic runner,
verification pipeline, and React console for building one OSI Raspberry Pi
image per job.

The package requires Node.js `>=22.5.0`. It is intentionally independent from
the active OSI checkout: later tasks will run builds from pinned detached
worktrees and publish only verified artifacts beneath configured output roots.

## Development

Run the initial unit harness with:

```bash
npm run test:unit
```

Integration and browser commands are scaffolded now and will gain their test
fixtures as the corresponding implementation tasks land.
