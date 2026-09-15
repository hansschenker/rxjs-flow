#!/usr/bin/env bash
# Run in WSL/Linux/Git Bash with GitHub push authentication already configured.
# Default: prepare and dry-run. Pass --push to perform the reviewed import.
set -euo pipefail

mode=${1:---dry-run}
if [[ $# -gt 1 || ( "$mode" != --dry-run && "$mode" != --push ) ]]; then
  echo 'Usage: bash import-rxjs-flow.sh [--dry-run|--push]' >&2
  exit 2
fi

source_url=https://github.com/hansschenker/rxjs-stack.git
destination_url=https://github.com/hansschenker/rxjs-flow.git
audited_commit=cbc91eefbccdeaf17221d06c75bdd237fe5e5499
documentation_commit=d701cb72f14293e96acac2cb163e6434e5fb0f54
documentation_ref=refs/heads/docs/rxjs-dataflow-plan-2026-09-15
export GIT_TERMINAL_PROMPT=0

command -v git >/dev/null
import_dir=$(mktemp -d "$PWD/rxjs-flow-import.XXXXXX")
echo "Import evidence directory: $import_dir"
trap 'echo "Stopped. Evidence retained in: $import_dir" >&2' ERR
date -u +%Y-%m-%dT%H:%M:%SZ > "$import_dir/started-at.txt"
git --version > "$import_dir/git-version.txt"

git ls-remote --refs "$destination_url" > "$import_dir/destination-before.txt"
if [[ -s "$import_dir/destination-before.txt" ]]; then
  echo 'Destination already has references. Stop and recheck M00; nothing will be overwritten.' >&2
  exit 1
fi

git clone --bare "$source_url" "$import_dir/history.git"
cd "$import_dir/history.git"
git remote rename origin source
git remote set-url --push source DISABLED
git remote add destination "$destination_url"

[[ $(git rev-parse --is-shallow-repository) == false ]]
[[ $(git rev-parse refs/heads/main) == "$audited_commit" ]]
[[ $(git rev-parse "$documentation_ref") == "$documentation_commit" ]]
git merge-base --is-ancestor "$audited_commit" "$documentation_ref"
git fsck --full > "$import_dir/fsck.txt" 2>&1
git rev-list --count --all > "$import_dir/commit-count.txt"
git for-each-ref --format='%(objectname) %(refname)' refs/heads refs/tags |
  LC_ALL=C sort > "$import_dir/source-refs.txt"

# The reviewed history has no LFS attributes or submodule metadata. Stop if that changes.
git rev-list --all --objects > "$import_dir/objects.txt"
if grep -Eq '(^|/| )(\.gitattributes|\.gitmodules)$' "$import_dir/objects.txt"; then
  echo 'LFS/submodule metadata requires review before this import.' >&2
  exit 1
fi

# Create-only safeguard, including a destination change between the two checks.
mkdir -p "$import_dir/hooks"
cat > "$import_dir/hooks/pre-push" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
while read -r local_ref local_oid remote_ref remote_oid; do
  if [[ ! "$remote_oid" =~ ^0+$ ]]; then
    echo "Refusing to update existing destination reference: $remote_ref" >&2
    exit 1
  fi
done
HOOK
chmod +x "$import_dir/hooks/pre-push"
git config core.hooksPath "$import_dir/hooks"

[[ $(git remote get-url --push destination) == "$destination_url" ]]
git ls-remote --refs destination > "$import_dir/destination-recheck.txt"
[[ ! -s "$import_dir/destination-recheck.txt" ]]

echo 'Reference snapshot to import:'
cat "$import_dir/source-refs.txt"
echo 'This copies existing CI, Claude workflows (including weekly maintenance), and Dependabot configuration.'
echo 'Repository settings, secrets, PRs, and issues are not copied. CI may run after the push.'

if [[ "$mode" == --dry-run ]]; then
  git push --dry-run --atomic destination 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*' \
    > "$import_dir/push-dry-run.txt" 2>&1 || { cat "$import_dir/push-dry-run.txt" >&2; exit 1; }
  cat "$import_dir/push-dry-run.txt"
  echo 'Dry run only. Use --push to import from an authenticated terminal.'
  exit 0
fi

git push --atomic destination 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*' \
  > "$import_dir/push.txt" 2>&1 || { cat "$import_dir/push.txt" >&2; exit 1; }
cat "$import_dir/push.txt"
git ls-remote --refs --heads --tags destination |
  awk '{print $1 " " $2}' | LC_ALL=C sort > "$import_dir/destination-after.txt"
diff -u "$import_dir/source-refs.txt" "$import_dir/destination-after.txt"
date -u +%Y-%m-%dT%H:%M:%SZ > "$import_dir/completed-at.txt"
echo "Import verified. Resume M00; the application test baseline is still pending. Evidence: $import_dir"
