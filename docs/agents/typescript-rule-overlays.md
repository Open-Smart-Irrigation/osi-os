# TypeScript Rule Overlays

This repo uses OSI-owned `architect.yaml` and `RULES.yaml` files as advisory TypeScript overlays for agent work.

## How agents should use them

1. Before editing TypeScript in `web/react-gui`, match the target file against `architect.yaml`.
2. Read the matching `RULES.yaml` section and apply it as a local overlay on `code-quality-principles`.
3. Use Superpowers TDD, debugging, review, and verification as the execution authority.
4. After meaningful edits, review changed files against the matched `must_do`, `should_do`, and `must_not_do` rules.

## Finding severity

- **Must fix** - behavior, safety, security, data integrity, or explicit OSI contract issue.
- **Should fix** - maintainability issue with clear future change-cost impact.
- **Note** - style preference, weak signal, or future cleanup candidate.

## Tooling status

These files are written in the shape used by AgiFlow `architect-mcp`, but `@agiflowai/aicode-toolkit` is not required for normal OSI work. Treat MCP validation as optional until the rule overlays have proven useful in real TypeScript tasks.
