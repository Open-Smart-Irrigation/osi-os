#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_FILE="$REPO_ROOT/AGENTS.md"
CLAUDE_FILE="$REPO_ROOT/CLAUDE.md"
# Opt-in: the memory index of the harness running the closeout, if it has one.
MEMORY_FILE="${OSI_OS_MEMORY_FILE:-}"

section() {
  printf '\n== %s ==\n' "$1"
}

print_list() {
  local content="${1:-}"

  if [ -n "$content" ]; then
    printf '%s\n' "$content"
  else
    printf '(none)\n'
  fi
}

check_contains() {
  local file="$1"
  local pattern="$2"
  local description="$3"

  if grep -Eq "$pattern" "$file"; then
    printf 'OK: %s\n' "$description"
  else
    printf 'WARN: %s\n' "$description"
  fi
}

cd "$REPO_ROOT"

current_branch="$(git rev-parse --abbrev-ref HEAD)"
status_line="$(git status --short --branch | sed -n '1p')"
staged_files="$(git diff --cached --name-only)"
unstaged_files="$(git diff --name-only)"
untracked_files="$(git ls-files --others --exclude-standard)"
cleanup_candidates="$(git clean -nd 2>/dev/null | sed 's/^Would remove //')"

section "Repository"
printf 'Root: %s\n' "$REPO_ROOT"
printf 'Branch: %s\n' "$status_line"

section "Uncommitted changes"
printf 'Staged files:\n'
print_list "$staged_files"

printf '\nUnstaged files:\n'
print_list "$unstaged_files"

printf '\nUntracked files:\n'
print_list "$untracked_files"

section "Cleanup candidates"
printf 'Dry-run candidates from `git clean -nd`:\n'
print_list "$cleanup_candidates"

section "Documentation consistency"
behind="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo '?')"
printf 'INFO: %s is %s commits behind origin/main (as of the last fetch)\n' "$current_branch" "$behind"

if [ -f "$AGENTS_FILE" ]; then
  check_contains "$AGENTS_FILE" 'source of truth|canonical' 'AGENTS.md records the edge-first source-of-truth model'
  check_contains "$AGENTS_FILE" 'REST polling' 'AGENTS.md records cloud-to-edge commands via REST polling'
  check_contains "$AGENTS_FILE" 'telemetry only' 'AGENTS.md records MQTT as telemetry only'
else
  printf 'WARN: AGENTS.md not found at %s\n' "$AGENTS_FILE"
fi

if [ -f "$CLAUDE_FILE" ]; then
  check_contains "$CLAUDE_FILE" 'Session Closeout' 'CLAUDE.md includes the session closeout convention'
  check_contains "$CLAUDE_FILE" 'scripts/session-closeout\.sh' 'CLAUDE.md points to the closeout helper script'
else
  printf 'WARN: CLAUDE.md not found at %s\n' "$CLAUDE_FILE"
fi

if [ -z "$MEMORY_FILE" ]; then
  printf 'INFO: OSI_OS_MEMORY_FILE unset; no harness memory index checked\n'
elif [ -f "$MEMORY_FILE" ]; then
  printf 'INFO: memory index %s last modified %s\n' "$MEMORY_FILE" "$(date -r "$MEMORY_FILE" '+%Y-%m-%d %H:%M')"
else
  printf 'WARN: OSI_OS_MEMORY_FILE points to a missing file: %s\n' "$MEMORY_FILE"
fi

section "Closeout reminder"
printf '%s\n' '- Update AGENTS.md only for durable repo-level context changes.'
printf '%s\n' "- Record operational and historical context in your own harness memory (or the run HANDOVER.md); never edit another harness's memory."
printf '%s\n' '- Delete only clearly temporary session artifacts; otherwise report candidates.'
printf '%s\n' '- Summarize remaining risks, skipped checks, and the next recommended step.'
