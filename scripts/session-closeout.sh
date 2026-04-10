#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_FILE="$REPO_ROOT/AGENTS.md"
CLAUDE_FILE="$REPO_ROOT/CLAUDE.md"
MEMORY_FILE="${OSI_OS_MEMORY_FILE:-/home/phil/.claude/projects/-home-phil-Repos-osi-os/memory/MEMORY.md}"

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
if [ -f "$AGENTS_FILE" ]; then
  agents_branch="$(awk -F'`' '/^- `osi-os`: `/ { print $4; exit }' "$AGENTS_FILE")"

  if [ -n "$agents_branch" ] && [ "$agents_branch" = "$current_branch" ]; then
    printf 'OK: AGENTS.md documents osi-os branch as `%s`\n' "$current_branch"
  else
    printf 'WARN: AGENTS.md branch entry is `%s`, repo branch is `%s`\n' "${agents_branch:-missing}" "$current_branch"
  fi

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

if [ -f "$MEMORY_FILE" ]; then
  memory_branch="$(awk -F'`' '/^\| \*\*Current Branch\*\* \| `/ { print $2; exit }' "$MEMORY_FILE")"

  if [ -n "$memory_branch" ] && [ "$memory_branch" = "$current_branch" ]; then
    printf 'OK: MEMORY.md documents current branch as `%s`\n' "$current_branch"
  else
    printf 'WARN: MEMORY.md branch entry is `%s`, repo branch is `%s`\n' "${memory_branch:-missing}" "$current_branch"
  fi

  check_contains "$MEMORY_FILE" 'source of truth|canonical' 'MEMORY.md records the edge-first source-of-truth model'
  check_contains "$MEMORY_FILE" 'REST polling' 'MEMORY.md records cloud-to-edge commands via REST polling'
  check_contains "$MEMORY_FILE" 'telemetry only' 'MEMORY.md records MQTT as telemetry only'
else
  printf 'WARN: MEMORY.md not found at %s\n' "$MEMORY_FILE"
fi

section "Closeout reminder"
printf '%s\n' '- Update AGENTS.md only for durable repo-level context changes.'
printf '%s\n' '- Update MEMORY.md for operational notes, historical context, and device-level details.'
printf '%s\n' '- Delete only clearly temporary session artifacts; otherwise report candidates.'
printf '%s\n' '- Summarize remaining risks, skipped checks, and the next recommended step.'
