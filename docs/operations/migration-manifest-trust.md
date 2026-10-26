# Migration manifest authority

The authorized deploy operator selects and protects the source checkout or installed payload. Authenticated SSH delivery or trusted provisioning carries that authority to the gateway. Runtime validation requires an exact migration file set and SHA-256 agreement with CHECKSUMS.json before bookkeeping, backup pruning or SQL execution. Complete sparse version sets are valid.

## Required deployment prerequisites

Select the intended checkout/revision and keep it stable through packaging or transfer. Verify the SSH host key and authorized user. Own the loopback HTTP listener and a free forwarding port; use ExitOnForwardFailure=yes and confirm forwarding succeeded. A localhost response alone does not identify its listener. Protect local staging and executable tooling.

For offline delivery, approve the source before packaging and transfer the bundle, sidecar and tooling through the authorized process. The sidecar detects damage relative to that expectation; a co-delivered digest does not independently authenticate its sender. Bundle names and BUNDLE_SHA are labels.

Direct migration and repair callers have the same protected-source obligation. A directory argument is not provenance. Every corpus, including reference prefixes and synthetic fixtures, requires a manifest. One operation retains accepted bytes; a new top-level invocation validates again. During-load descriptor/path checks detect ordinary replacements but do not create an atomic directory snapshot against hostile writers.

## Limits and recovery

A coherently altered manifest and SQL corpus supplied by the authorized operator can pass. These checks do not prove independent publisher authorization, intended revision, freshness, rollback protection or SQL semantics, and do not secure compromised workstations, gateways or replaceable verifier code. Independent publisher authorization would require a separately reviewed trust design.

On a corpus error, restore the complete approved payload before retrying. Never regenerate expected hashes from suspect actual files or restamp the database to cure a missing file or hash mismatch. Fingerprint restamping remains a distinct operator recovery for a confirmed live schema.
