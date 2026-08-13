# Cloud C8 test sweep

Command: `./gradlew --stop && ./gradlew test` from the cloud backend worktree.

The copied Gradle artifacts contain 1,610 tests across 284 XML result files:

- 1,609 passed
- 1 failed: `ArchitectureTest.noNewPackageCycles`, the existing frozen ArchUnit store reports `StoreUpdateFailedException`
- 1 skipped
- 0 errors

The three required Testcontainers suites ran without skips:

- `DeviceMutationServiceTransactionIT`: 2 tests, 0 skipped
- `ScopedAccessMigrationIT`: 2 tests, 0 skipped
- `IrrigationConfigMigrationIT`: 1 test, 0 skipped

The full HTML report is under `reports/tests/test/` and raw XML results are under
`test-results/test/`. The one ArchUnit failure matches the pre-existing baseline
failure reproduced before C7; no new omitted-dependency `+4552` counter was found.
