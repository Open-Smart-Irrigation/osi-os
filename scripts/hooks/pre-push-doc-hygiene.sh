#!/bin/sh
# Pre-push guard for the public osi-os repository.
#
# Install once per clone (the command also works in a worktree):
#   cp scripts/hooks/pre-push-doc-hygiene.sh "$(git rev-parse --git-path hooks/pre-push)" && chmod +x "$(git rev-parse --git-path hooks/pre-push)"
#   git config osi.docHygieneTermsFile <absolute path of the name list>
# Reinstall the copy when the script changes.
#
# Git runs it as `pre-push <remote name> <remote url>` and writes one line per
# pushed ref to standard input: <local ref> <local sha> <remote ref> <remote sha>.
#
# The hook acts only when the URL names the public repository. For such a push
# it refuses any commit new to the remote whose tree contains a private
# document folder. Then, with scripts/verify-doc-hygiene.js, it scans the
# documents of each pushed commit (not the checkout), the lines that the new
# commits add to them, and the new commits' messages together with the pushed
# ref name. Any unexpected failure refuses the push. The name list is passed
# to the scanner in the environment and is never printed.
#
# Not covered: a commit without a scanner while the public main has none (only
# the private-folder check runs), documents stored as UTF-16 (no content scan),
# and pushes to forks under other owners.

remote_name=$1
remote_url=$2

# A local replace ref would make the scans read the replacement while the
# push sends the real objects.
GIT_NO_REPLACE_OBJECTS=1
export GIT_NO_REPLACE_OBJECTS

# The path lists below are expanded unquoted on purpose; no globbing.
set -f

SCANNER_PATH=scripts/verify-doc-hygiene.js
ALLOWLIST_PATH=scripts/verify-doc-hygiene-allowlist.json
# Must equal SCOPE in scripts/verify-doc-hygiene.js (a test checks this).
SCOPE_PATHS='README.md AGENTS.md CLAUDE.md CHANGELOG.md docs .claude/skills .github analysis'
PRIVATE_PATHS='docs/policy docs/customers docs/gateways docs/customer-operations docs/releases docs/reviews docs/records docs/archive'

# Refs are named in messages by the short id of the pushed commit, never by
# their name: a branch or tag name may carry a listed term.
short_label() {
  printf '%s (ref name withheld)' "${1%"${1#???????}"}"
}

die() {
  printf 'pre-push: %s\n' "$*" >&2
  exit 1
}

# True when the URL names the public repository: after trailing "/" and
# ".git" are stripped it ends in Open-Smart-Irrigation/osi-os preceded by "/"
# or ":". Compared without case, as the hosting service does.
is_public_url() {
  url=$(printf '%s\n' "$1" | tr '[:upper:]' '[:lower:]') || die "cannot read the remote URL; refusing to push"
  while :; do
    case $url in
      */) url=${url%/} ;;
      *.git) url=${url%.git} ;;
      *) break ;;
    esac
  done
  case $url in
    */open-smart-irrigation/osi-os | *:open-smart-irrigation/osi-os) return 0 ;;
  esac
  return 1
}

is_sha() {
  case $1 in
    '' | *[!0-9a-f]*) return 1 ;;
  esac
  [ "${#1}" -eq 40 ] || [ "${#1}" -eq 64 ]
}

is_zero() {
  case $1 in
    *[!0]*) return 1 ;;
  esac
  return 0
}

# Private folders in the tree of $1; prints the matching paths.
private_in_tree() {
  # shellcheck disable=SC2086
  git ls-tree --full-tree --name-only "$1" -- $PRIVATE_PATHS </dev/null
}

# Prints the first commit new to the remote whose own tree still contains a
# private folder (a commit that only removes one is fine). Candidates are the
# new commits that touch a private folder: a new commit that holds one without
# touching it inherits it from a parent that is either such a candidate or
# already on the remote. $1 = commit, $2 = remote sha to exclude (may be empty).
private_in_history() {
  # shellcheck disable=SC2086
  git rev-list --full-history "$1" --not --remotes="$remote_name" ${2:+"$2"} -- $PRIVATE_PATHS \
    >"$tmp/candidates" </dev/null || return 1
  while IFS= read -r candidate; do
    private_in_tree "$candidate" >"$tmp/hits" || return 1
    if [ -s "$tmp/hits" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done <"$tmp/candidates"
  return 0
}

# The remote's current sha for the ref, when it is a commit we have: commits
# reachable from it are already on the remote. Prints nothing otherwise.
known_remote_sha() {
  if ! is_zero "$1" && git cat-file -e "$1^{commit}" </dev/null 2>/dev/null; then
    printf '%s\n' "$1"
  fi
}

# Removes the git variables that would point a git command at the pushing
# repository instead of the temporary export. Called inside subshells only.
unset_git_location() {
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
    GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE GIT_PREFIX
}

# Runs the scanner with the name list in its environment. $1 = scanner,
# remaining arguments are passed on. The list never reaches the output.
run_scanner() {
  (
    unset_git_location
    OSI_DOC_HYGIENE_TERMS=$terms
    export OSI_DOC_HYGIENE_TERMS
    exec node "$@"
  )
}

is_public_url "$remote_url" || exit 0

# ---- From here on every unexpected failure refuses the push. ----

# An empty name would make --remotes= match every remote, the private one too.
[ -n "$remote_name" ] || die "git passed no remote name; refusing to push"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/osi-pre-push.XXXXXX") || die "cannot create a temporary directory; refusing to push"
[ -n "$tmp" ] && [ -d "$tmp" ] || die "cannot create a temporary directory; refusing to push"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' HUP INT TERM
resolved=$(cd "$tmp" && pwd) || die "cannot resolve the temporary directory; refusing to push"
tmp=$resolved

cat >"$tmp/refs" || die "cannot read the pushed refs; refusing to push"

# Pass 1: check every ref line and run the private-folder tripwire. It needs
# neither the scanner nor the name list.
pushes=0
while IFS=' ' read -r local_ref local_sha remote_ref remote_sha extra <&3 || [ -n "$local_ref" ]; do
  if [ -z "$local_ref" ] || [ -z "$remote_ref" ] || [ -n "$extra" ] ||
    ! is_sha "$local_sha" || ! is_sha "$remote_sha"; then
    die "unexpected ref line from git; refusing to push"
  fi
  is_zero "$local_sha" && continue
  pushes=$((pushes + 1))
  commit=$(git rev-parse --verify --quiet "$local_sha^{commit}" </dev/null) ||
    die "refusing to push $(short_label "$local_sha"): the pushed object is not a commit"
  label=$(short_label "$commit")

  private_in_tree "$commit" >"$tmp/hits" || die "cannot list the tree of $label; refusing to push"
  if [ -s "$tmp/hits" ]; then
    IFS= read -r first <"$tmp/hits"
    die "refusing to push $label: the commit contains private document folders ($first)"
  fi

  exclude=$(known_remote_sha "$remote_sha")
  first=$(private_in_history "$commit" "$exclude") ||
    die "cannot list the new history of $label; refusing to push"
  if [ -n "$first" ]; then
    die "refusing to push $label: its history contains private document folders (commit $first); if that history is already public, fetch the remote and push by remote name"
  fi
done 3<"$tmp/refs"

[ "$pushes" -gt 0 ] || exit 0

# The name list.
terms_file=$(git config --type=path --get osi.docHygieneTermsFile </dev/null) || terms_file=
if [ -z "$terms_file" ] || [ ! -f "$terms_file" ] || [ ! -r "$terms_file" ]; then
  die "osi.docHygieneTermsFile is not set or not readable; refusing to push to the public repository"
fi
terms=$(cat -- "$terms_file" </dev/null) ||
  die "osi.docHygieneTermsFile is not set or not readable; refusing to push to the public repository"

# Pass 2: per ref, the documents of the pushed commit, the lines the new
# commits add, and the new messages with the ref name.
blocked=0
n=0
while IFS=' ' read -r local_ref local_sha remote_ref remote_sha extra <&3 || [ -n "$local_ref" ]; do
  is_zero "$local_sha" && continue
  n=$((n + 1))
  work="$tmp/ref$n"
  mkdir "$work" "$work/tree" || die "cannot create a temporary directory; refusing to push"
  commit=$(git rev-parse --verify --quiet "$local_sha^{commit}" </dev/null) ||
    die "refusing to push $(short_label "$local_sha"): the pushed object is not a commit"
  label=$(short_label "$commit")

  # Scanner and allowlist come from one source: the pushed commit, or else
  # the remote's main (fallback). Only a remote main that is known and has no
  # scanner itself lets the scans be skipped.
  fallback=0
  found=$(git ls-tree --full-tree "$commit" -- "$SCANNER_PATH" </dev/null) ||
    die "cannot list the tree of $label; refusing to push"
  if [ -n "$found" ]; then
    scanner_from=$commit
  else
    scanner_from=$(git rev-parse --verify --quiet "refs/remotes/$remote_name/main^{commit}" </dev/null 2>/dev/null) ||
      die "cannot find a hygiene scanner for $label; fetch the public remote first"
    found=$(git ls-tree --full-tree "$scanner_from" -- "$SCANNER_PATH" </dev/null) ||
      die "cannot list the tree of the public remote's main; refusing to push"
    if [ -z "$found" ]; then
      printf "pre-push: no hygiene scanner in %s or on the public remote's main; file and message scan skipped\n" "$label" >&2
      continue
    fi
    fallback=1
  fi
  command -v node >/dev/null 2>&1 || die "node is not installed; refusing to push to the public repository"
  git cat-file blob "$scanner_from:$SCANNER_PATH" >"$work/scanner.js" </dev/null ||
    die "cannot read the hygiene scanner for $label; refusing to push"
  grep -q 'stdin-diff' "$work/scanner.js"
  case $? in
    0) ;;
    1) die "the hygiene scanner for $label has no --stdin-diff mode; refusing to push (the scanner in the pushed commit, or on the public remote's main without one, must have it)" ;;
    *) die "cannot read the hygiene scanner for $label; refusing to push" ;;
  esac

  # Export the scanner's scope from the pushed commit; the allowlist comes
  # from the scanner's source.
  set --
  for p in $SCOPE_PATHS $ALLOWLIST_PATH; do
    if [ "$p" = "$ALLOWLIST_PATH" ] && [ "$fallback" -eq 1 ]; then continue; fi
    found=$(git ls-tree --full-tree --name-only "$commit" -- "$p" </dev/null) ||
      die "cannot list the tree of $label; refusing to push"
    if [ -n "$found" ]; then set -- "$@" "$p"; fi
  done
  : >"$work/expected" || die "cannot write a temporary file; refusing to push"
  if [ "$#" -gt 0 ]; then
    git archive --format=tar "$commit" "$@" >"$work/export.tar" </dev/null ||
      die "git archive failed for $label; refusing to push"
    tar -x -f "$work/export.tar" -C "$work/tree" </dev/null ||
      die "cannot unpack the export of $label; refusing to push"
    git ls-tree -r --full-tree "$commit" -- "$@" >"$work/expected" </dev/null ||
      die "cannot list the tree of $label; refusing to push"
  fi
  extra_files=0
  if [ "$fallback" -eq 1 ]; then
    found=$(git ls-tree --full-tree --name-only "$scanner_from" -- "$ALLOWLIST_PATH" </dev/null) ||
      die "cannot list the tree of the public remote's main; refusing to push"
    if [ -n "$found" ]; then
      mkdir -p "$work/tree/${ALLOWLIST_PATH%/*}" ||
        die "cannot create a temporary directory; refusing to push"
      git cat-file blob "$scanner_from:$ALLOWLIST_PATH" >"$work/tree/$ALLOWLIST_PATH" </dev/null ||
        die "cannot read the allowlist of the public remote's main; refusing to push"
      extra_files=1
    fi
  fi
  # The scanner lists files with git ls-files, so the export becomes a
  # repository of its own.
  (
    unset_git_location
    cd "$work/tree" &&
      git -c init.defaultBranch=main init -q &&
      git add -A -f &&
      git ls-files >"$work/listed"
  ) </dev/null || die "cannot prepare the scan of $label; refusing to push"

  # Every file of the commit must be in the export (export-ignore attributes
  # would otherwise hide files from the scan).
  expected=$(grep -c '^[0-7]* blob ' "$work/expected")
  [ "$?" -le 1 ] || die "cannot count the files of $label; refusing to push"
  expected=$((expected + extra_files))
  actual=$(wc -l <"$work/listed") || die "cannot count the exported files of $label; refusing to push"
  if [ "$expected" -ne "$actual" ]; then
    die "refusing to push $label: the export has $actual of $expected files (export attributes?), so it cannot be scanned"
  fi

  # 1. The documents of the pushed commit.
  if ! run_scanner "$work/scanner.js" --root="$work/tree" --require-terms </dev/null; then
    printf 'pre-push: refusing to push %s: its documents failed the hygiene scan\n' "$label" >&2
    if [ "$fallback" -eq 1 ]; then
      printf "pre-push: %s has no hygiene baseline of its own; merge or rebase onto the public remote's main and push again\n" "$label" >&2
    fi
    blocked=1
  fi

  # 2. The lines that the commits new to the remote add to those documents.
  # --text: diff and binary attributes (from the branch, info/attributes or
  # core.attributesFile) must not turn a document into "Binary files differ".
  # --diff-merges=remerge: lines that only a conflict resolution adds.
  # --full-history: walk side branches even when a merge leaves the scope
  # unchanged. git may omit a remerge diff with only a message on stderr and
  # exit 0 (for example when it cannot write its temporary objects), so any
  # stderr output refuses the push as well.
  git log -n 0 --diff-merges=remerge "$commit" </dev/null >/dev/null 2>"$work/probe.err" ||
    die "git 2.36 or newer is required for the added-lines scan (--diff-merges=remerge); refusing to push"
  if [ -s "$work/probe.err" ]; then
    printf 'pre-push: refusing to push %s: the added-lines scan could not read the commits; git reported:\n' "$label" >&2
    cat "$work/probe.err" >&2
    exit 1
  fi
  exclude=$(known_remote_sha "$remote_sha")
  # git skips the remerge diff of a merge with three or more parents.
  git rev-list --min-parents=3 "$commit" --not --remotes="$remote_name" ${exclude:+"$exclude"} \
    >"$work/octopus" </dev/null ||
    die "cannot list the merges of $label; refusing to push"
  if [ -s "$work/octopus" ]; then
    die "$label contains a merge with more than two parents; the guard cannot scan it. Recreate it as two-parent merges and push again"
  fi
  # shellcheck disable=SC2086
  git -c core.quotePath=false -c log.showRoot=true -c log.showSignature=false \
    log -p --text --diff-merges=remerge --full-history --no-ext-diff --no-textconv --no-color --no-renames \
    --src-prefix=a/ --dst-prefix=b/ \
    --format='commit %H' "$commit" --not --remotes="$remote_name" ${exclude:+"$exclude"} -- $SCOPE_PATHS \
    >"$work/changes" 2>"$work/changes.err" </dev/null
  status=$?
  if [ "$status" -ne 0 ] || [ -s "$work/changes.err" ]; then
    printf 'pre-push: refusing to push %s: the added-lines scan could not read the commits; git reported:\n' "$label" >&2
    cat "$work/changes.err" >&2
    exit 1
  fi
  run_scanner "$work/scanner.js" --root="$work/tree" --stdin-diff --require-terms <"$work/changes" >"$work/changes.out"
  status=$?
  cat "$work/changes.out" || die "cannot read a temporary file; refusing to push"
  if [ "$status" -eq 1 ]; then
    printf 'pre-push: a commit in %s adds a listed term or identifier. If it is still present at the tip, fix or allowlist it; if a later commit removed it, squash those commits, then push again\n' "$label" >&2
    blocked=1
  elif [ "$status" -ne 0 ]; then
    printf 'pre-push: refusing to push %s: the scan of the added lines could not run (exit %s); see the scanner message above\n' "$label" "$status" >&2
    blocked=1
  elif ! grep -q 'OK (supplied commits)' "$work/changes.out"; then
    printf 'pre-push: refusing to push %s: the hygiene scanner did not run its --stdin-diff mode\n' "$label" >&2
    blocked=1
  fi

  # 3. The messages of the commits new to the remote, and the pushed ref name.
  git -c log.showSignature=false log --format=%B "$commit" --not --remotes="$remote_name" ${exclude:+"$exclude"} \
    >"$work/messages" </dev/null ||
    die "cannot list the commit messages of $label; refusing to push"
  printf 'ref\n%s\n' "$remote_ref" >>"$work/messages" || die "cannot write a temporary file; refusing to push"
  if ! run_scanner "$work/scanner.js" --stdin --require-terms <"$work/messages"; then
    printf 'pre-push: refusing to push %s: a commit message or the pushed ref name failed the hygiene scan\n' "$label" >&2
    blocked=1
  fi
done 3<"$tmp/refs"

[ "$blocked" -eq 0 ] || exit 1
exit 0
