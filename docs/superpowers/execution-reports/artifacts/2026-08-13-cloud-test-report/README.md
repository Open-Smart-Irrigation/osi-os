# Cloud Round 2 test sweep

Command: `./gradlew cleanTest test --no-daemon` from the cloud backend worktree.

The copied Gradle artifacts contain 1,610 tests across the current XML result files:

- 1,609 passed
- 1 skipped
- 0 errors

The skip is the anonymous ClamAV EICAR integration test, `JournalScannerBridgeIT`; the local scanner dependency is unavailable.

The ArchUnit suite is green after the Round 2 delete-and-recreate refreeze. The frozen store contains the identical 1,402-cycle set, with zero added and zero removed cycles; the changed text is constructor-signature churn.

The three required Testcontainers suites ran without skips:

- `DeviceMutationServiceTransactionIT`: 2 tests, 0 skipped
- `ScopedAccessMigrationIT`: 2 tests, 0 skipped
- `IrrigationConfigMigrationIT`: 1 test, 0 skipped

The full HTML report is under `reports/tests/test/` and raw XML results are under
`test-results/test/`.
