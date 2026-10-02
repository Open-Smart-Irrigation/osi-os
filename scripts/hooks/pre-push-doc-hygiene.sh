#!/bin/sh
# Pre-push guard for the public osi-os repository.
#
# Install once per clone:
#   cp scripts/hooks/pre-push-doc-hygiene.sh .git/hooks/pre-push
#   chmod +x .git/hooks/pre-push
#   git config osi.docHygieneTermsFile <absolute path of the name list>
#
# Git runs it as `pre-push <remote name> <remote url>` and writes one line per
# pushed ref to standard input: <local ref> <local sha> <remote ref> <remote sha>.
#
# The hook acts only when the URL names the public repository. For such a push
# it refuses any commit whose tree, or whose history new to the remote,
# contains a private document folder; then it scans the documents of each
# pushed commit (not the checkout) and the messages of the commits new to the
# remote with scripts/verify-doc-hygiene.js. Any unexpected failure refuses
# the push. The name list is passed to the scanner in the environment and is
# never printed.

remote_name=$1
remote_url=$2

SCANNER_PATH=scripts/verify-doc-hygiene.js

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
  git ls-tree --full-tree --name-only "$1" -- \
    docs/policy docs/customers docs/gateways docs/customer-operations \
    docs/releases docs/reviews docs/records docs/archive </dev/null
}

# Commits new to the remote that add, change or remove a private folder.
# $1 = commit, $2 = remote sha to exclude (may be empty).
private_in_history() {
  git rev-list --full-history "$1" --not --remotes="$remote_name" ${2:+"$2"} -- \
    docs/policy docs/customers docs/gateways docs/customer-operations \
    docs/releases docs/reviews docs/records docs/archive </dev/null
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
tmp=$(cd "$tmp" && pwd) || die "cannot resolve the temporary directory; refusing to push"
trap 'exit 1' HUP INT TERM

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
    die "refusing to push $local_ref: $local_sha is not a commit"

  private_in_tree "$commit" >"$tmp/hits" || die "cannot list the tree of $local_ref; refusing to push"
  if [ -s "$tmp/hits" ]; then
    IFS= read -r first <"$tmp/hits"
    die "refusing to push $local_ref: the commit contains private document folders ($first)"
  fi

  exclude=$(known_remote_sha "$remote_sha")
  private_in_history "$commit" "$exclude" >"$tmp/hits" ||
    die "cannot list the new history of $local_ref; refusing to push"
  if [ -s "$tmp/hits" ]; then
    IFS= read -r first <"$tmp/hits"
    die "refusing to push $local_ref: its history contains private document folders (commit $first); if that history is already public, fetch the remote and push by remote name"
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

# Pass 2: scan the documents of each pushed commit and the new messages.
blocked=0
n=0
while IFS=' ' read -r local_ref local_sha remote_ref remote_sha extra <&3 || [ -n "$local_ref" ]; do
  is_zero "$local_sha" && continue
  n=$((n + 1))
  work="$tmp/ref$n"
  mkdir "$work" "$work/tree" || die "cannot create a temporary directory; refusing to push"
  commit=$(git rev-parse --verify --quiet "$local_sha^{commit}" </dev/null) ||
    die "refusing to push $local_ref: $local_sha is not a commit"

  # Scanner: from the pushed commit, else from the remote's main.
  scanner_from=
  found=$(git ls-tree --full-tree "$commit" -- "$SCANNER_PATH" </dev/null) ||
    die "cannot list the tree of $local_ref; refusing to push"
  if [ -n "$found" ]; then
    scanner_from=$commit
  elif remote_main=$(git rev-parse --verify --quiet "refs/remotes/$remote_name/main^{commit}" </dev/null 2>/dev/null); then
    found=$(git ls-tree --full-tree "$remote_main" -- "$SCANNER_PATH" </dev/null) ||
      die "cannot list the tree of $remote_name/main; refusing to push"
    [ -n "$found" ] && scanner_from=$remote_main
  fi
  if [ -z "$scanner_from" ]; then
    printf 'pre-push: no hygiene scanner in %s or on %s/main; file and message scan skipped\n' "$local_ref" "$remote_name" >&2
    continue
  fi
  command -v node >/dev/null 2>&1 || die "node is not installed; refusing to push to the public repository"
  git cat-file blob "$scanner_from:$SCANNER_PATH" >"$work/scanner.js" </dev/null ||
    die "cannot read the hygiene scanner for $local_ref; refusing to push"

  # Export the scanner's scope from the pushed commit.
  set --
  for p in README.md AGENTS.md CLAUDE.md CHANGELOG.md docs .claude/skills .github analysis \
    scripts/verify-doc-hygiene-allowlist.json; do
    found=$(git ls-tree --full-tree --name-only "$commit" -- "$p" </dev/null) ||
      die "cannot list the tree of $local_ref; refusing to push"
    if [ -n "$found" ]; then set -- "$@" "$p"; fi
  done
  : >"$work/expected" || die "cannot write a temporary file; refusing to push"
  if [ "$#" -gt 0 ]; then
    git archive --format=tar "$commit" "$@" >"$work/export.tar" </dev/null ||
      die "git archive failed for $local_ref; refusing to push"
    tar -x -f "$work/export.tar" -C "$work/tree" </dev/null ||
      die "cannot unpack the export of $local_ref; refusing to push"
    git ls-tree -r --full-tree "$commit" -- "$@" >"$work/expected" </dev/null ||
      die "cannot list the tree of $local_ref; refusing to push"
  fi
  # The scanner lists files with git ls-files, so the export becomes a
  # repository of its own.
  (
    unset_git_location
    cd "$work/tree" &&
      git -c init.defaultBranch=main init -q &&
      git add -A -f &&
      git ls-files >"$work/listed"
  ) </dev/null || die "cannot prepare the scan of $local_ref; refusing to push"

  # Every file of the commit must be in the export (export-ignore attributes
  # would otherwise hide files from the scan).
  expected=$(grep -c '^[0-7]* blob ' "$work/expected")
  [ "$?" -le 1 ] || die "cannot count the files of $local_ref; refusing to push"
  actual=$(wc -l <"$work/listed") || die "cannot count the exported files of $local_ref; refusing to push"
  if [ "$expected" -ne "$actual" ]; then
    die "refusing to push $local_ref: the export has $actual of $expected files (export attributes?), so it cannot be scanned"
  fi

  if ! run_scanner "$work/scanner.js" --root="$work/tree" --require-terms </dev/null; then
    printf 'pre-push: refusing to push %s: its documents failed the hygiene scan\n' "$local_ref" >&2
    blocked=1
  fi

  # Messages of the commits new to the remote.
  exclude=$(known_remote_sha "$remote_sha")
  git -c log.showSignature=false log --format=%B "$commit" --not --remotes="$remote_name" ${exclude:+"$exclude"} \
    >"$work/messages" </dev/null ||
    die "cannot list the commit messages of $local_ref; refusing to push"
  if ! run_scanner "$work/scanner.js" --stdin --require-terms <"$work/messages"; then
    printf 'pre-push: refusing to push %s: a commit message failed the hygiene scan\n' "$local_ref" >&2
    blocked=1
  fi
done 3<"$tmp/refs"

[ "$blocked" -eq 0 ] || exit 1
exit 0
