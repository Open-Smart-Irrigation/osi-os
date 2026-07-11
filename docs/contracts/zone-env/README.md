# Zone Environment Golden Vectors

These fixtures are owned by `osi-os`.

They pin the behavior of the `Get Zone Environment Summary` request handler
while its pure compute and assembly helpers move into `osi-zone-env`.

- `MANIFEST.json` lists every captured case.
- `cases/*.input.json` describes the fixture request, database rows, fixed clock,
  and stubbed provider responses.
- `cases/*.expected.json` is the response bundle captured from the pre-extraction
  flow node.

These fixtures are behavior-preservation artifacts for the edge extraction only.
They do not define an osi-server mirror or cross-repo contract.
