#!/usr/bin/env bash
# Develop DSH changes that can break the running harness in an isolated git worktree under
# .worktree/<name>, prove them there, then adopt them into the main checkout.
#   scripts/worktree-dev.sh new <name> [--base <ref>] [--with-local] [--story <text>]
#       create .worktree/<name> on branch wt/<name>, install deps, write the story and checks templates;
#       --with-local commits the main checkout's uncommitted changes as the worktree's baseline
#   scripts/worktree-dev.sh status [<name>]  show lifecycle state (story, eval, adoption)
#   scripts/worktree-dev.sh build <name>     build:artifacts inside the worktree
#   scripts/worktree-dev.sh smoke <name>     boot the worktree's `dsh web` with its own DSH_HOME and probe it
#   scripts/worktree-dev.sh eval <name>      build, run every command in the checks file, smoke; stamp HEAD
#   scripts/worktree-dev.sh adopt <name> [--build]
#       apply baseline..HEAD to the main checkout as uncommitted changes; requires a passing eval of HEAD;
#       --build then installs (when manifests changed), runs build:artifacts, and smokes the main checkout
#   scripts/worktree-dev.sh unadopt <name>  reverse the adopted patch in the main checkout
#   scripts/worktree-dev.sh web <name> [port] run the worktree's web app in the foreground
#   scripts/worktree-dev.sh rm <name> [--force] remove a clean worktree, its DSH_HOME, and state (branch is kept)
set -euo pipefail

root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
# Always resolve the main checkout, even when invoked from inside a linked worktree.
root="$(cd "$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"
cmd="${1:-}"; name="${2:-}"
usage() { sed -n 2,17p "$0"; exit 2; }
die() { echo "worktree-dev: $*" >&2; exit 1; }
[[ -n "$cmd" ]] || usage
if [[ "$cmd" != status ]]; then
  [[ -n "$name" ]] || usage
fi
if [[ -n "$name" ]]; then
  [[ "$name" =~ ^[A-Za-z0-9._-]+$ && "$name" != .* ]] || die "invalid name: $name"
fi
dir="$root/.worktree/$name"
home="$root/.worktree/.home/$name"
state="$root/.worktree/.state/$name"
main_home="${DSH_MAIN_HOME:-$HOME/.dsh}"

require_worktree() { [[ -d "$dir" ]] || die "no worktree at $dir; run: $0 new $name"; }

write_overlay() {
  mkdir -p "$home"
  # Sessions and storages stay isolated in $home; credentials are the main harness's own file,
  # so refreshed tokens and saved keys are shared. Sign-out here also signs out the main harness.
  if [[ -f "$main_home/.credentials.yaml" ]]; then
    cat > "$home/credentials.overlay.yml" <<EOF
- id: credentials
  config:
    path: $main_home/.credentials.yaml
EOF
  else
    printf '[]\n' > "$home/credentials.overlay.yml"
  fi
}

write_templates() {
  mkdir -p "$state"
  local story_text="${1:-<raw idea or user story>}"
  if [[ ! -f "$state/story.md" ]]; then
    cat > "$state/story.md" <<EOF
# $name

## User story

$story_text

## Acceptance criteria

Each criterion names the observable behavior and the check in \`checks\` that proves it.

- [ ] <criterion> — proven by: <check command>

## Risk to the running harness

<which packages, profiles, build outputs, or persisted data this can break>
EOF
  fi
  if [[ ! -f "$state/checks" ]]; then
    cat > "$state/checks" <<'EOF'
# One shell command per line, run from the worktree root by `eval`. Lines starting with # are ignored.
# Prefer the narrowest test that fails without the change, for example:
#   pnpm exec vitest run packages/<group>/<pkg>/tests/<file>.spec.ts
#   pnpm run build:check
EOF
  fi
}

kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

# Boot `dsh web` from checkout $1 with DSH_HOME $2, wait for its URL line, and require the
# launch URL to answer with the token-exchange redirect.
smoke_checkout() {
  local checkout="$1" smoke_home="$2" log url pid code waited=0
  mkdir -p "$smoke_home"
  log="$(mktemp -t dsh-smoke.XXXXXX)"
  (cd "$checkout" && exec env DSH_HOME="$smoke_home" pnpm --silent dsh --profile web \
    --patch "$home/credentials.overlay.yml" --no-open --port 0) >"$log" 2>&1 &
  pid=$!
  url=""
  while [[ -z "$url" ]]; do
    url="$(sed -n 's/^dsh web: \(http:[^ ]*\).*/\1/p' "$log" | head -1)"
    [[ -n "$url" ]] && break
    if ! kill -0 "$pid" 2>/dev/null; then
      cat "$log" >&2; rm -f "$log"; echo "smoke: dsh web exited before ready" >&2; return 1
    fi
    if (( waited >= 180 )); then
      kill_tree "$pid"; cat "$log" >&2; rm -f "$log"; echo "smoke: not ready in 180s" >&2; return 1
    fi
    sleep 1; waited=$((waited + 1))
  done
  code="$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)"
  kill_tree "$pid"; wait "$pid" 2>/dev/null || true
  if [[ "$code" != 303 ]]; then
    cat "$log" >&2; rm -f "$log"; echo "smoke: expected 303 from launch URL, got $code" >&2; return 1
  fi
  rm -f "$log"
  echo "smoke: ok ($checkout ready in ${waited}s)"
}

show_status() {
  local n="$1" s="$root/.worktree/.state/$1" d="$root/.worktree/$1" head
  if [[ ! -d "$d" ]]; then echo "$n: no worktree"; return; fi
  head="$(git -C "$d" rev-parse --short HEAD)"
  printf '%s: branch %s, HEAD %s' "$n" "$(git -C "$d" branch --show-current)" "$head"
  [[ -n "$(git -C "$d" status --porcelain)" ]] && printf ', uncommitted changes'
  if [[ ! -f "$s/base" ]]; then echo ', no lifecycle state'; return; fi
  if [[ -f "$s/eval" ]]; then
    # shellcheck disable=SC1091,SC2154
    ( . "$s/eval"; printf ', eval %s at %s' "$result" "${sha:0:10}"
      [[ "$sha" == "$(git -C "$d" rev-parse HEAD)" ]] || printf ' (stale)' )
  else
    printf ', not evaluated'
  fi
  [[ -f "$s/adopted.patch" ]] && printf ', adopted'
  echo
}

case "$cmd" in
  new)
    shift 2
    base="HEAD"; with_local=0; story=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --base) base="${2:?--base needs a ref}"; shift 2 ;;
        --with-local) with_local=1; shift ;;
        --story) story="${2:?--story needs text}"; shift 2 ;;
        -*) die "unknown option: $1" ;;
        *) base="$1"; shift ;;
      esac
    done
    [[ ! -e "$dir" ]] || die "$dir already exists"
    base_sha="$(git -C "$root" rev-parse --verify "$base^{commit}")"
    if (( with_local )) && [[ "$base_sha" != "$(git -C "$root" rev-parse HEAD)" ]]; then
      die "--with-local requires --base to be the main checkout's HEAD"
    fi
    git -C "$root" worktree add -b "wt/$name" "$dir" "$base_sha"
    mkdir -p "$state"
    echo "$base_sha" > "$state/base"
    if (( with_local )); then
      git -C "$root" diff --binary HEAD > "$state/local.patch"
      [[ -s "$state/local.patch" ]] && git -C "$dir" apply --index "$state/local.patch"
      (cd "$root" && git ls-files -o --exclude-standard -z | tar --null -T - -cf -) | tar -xf - -C "$dir"
      git -C "$dir" add -A
      if ! git -C "$dir" diff --cached --quiet; then
        # The snapshot is the user's existing work, not this change; hooks judge only authored commits.
        git -C "$dir" commit -q --no-verify -m "wt($name): carry uncommitted changes from main checkout"
      fi
    fi
    git -C "$dir" rev-parse HEAD > "$state/baseline"
    write_templates "$story"
    write_overlay
    (cd "$dir" && pnpm install --prefer-offline)
    echo "worktree: $dir"
    echo "story:    $state/story.md"
    echo "checks:   $state/checks"
    ;;
  status)
    if [[ -n "$name" ]]; then show_status "$name"; exit 0; fi
    found=0
    for d in "$root"/.worktree/*/; do
      [[ -d "$d" ]] || continue
      found=1; show_status "$(basename "$d")"
    done
    (( found )) || echo "no worktrees under $root/.worktree"
    ;;
  build)
    require_worktree
    (cd "$dir" && pnpm run build:artifacts)
    ;;
  smoke)
    require_worktree
    write_overlay
    smoke_checkout "$dir" "$home"
    ;;
  eval)
    require_worktree
    [[ -f "$state/base" ]] || write_templates ""
    [[ -f "$state/base" ]] || git -C "$dir" merge-base HEAD "$(git -C "$root" rev-parse HEAD)" > "$state/base"
    [[ -f "$state/baseline" ]] || cp "$state/base" "$state/baseline"
    [[ -z "$(git -C "$dir" status --porcelain)" ]] || die "commit or discard worktree changes before eval; eval stamps a commit"
    checks="$(grep -v '^[[:space:]]*\(#\|$\)' "$state/checks" || true)"
    [[ -n "$checks" ]] || die "no commands in $state/checks; add the checks that prove the acceptance criteria"
    sha="$(git -C "$dir" rev-parse HEAD)"
    rm -f "$state/eval"
    log="$state/eval.log"
    : > "$log"
    run_step() {
      echo "== $1" | tee -a "$log"
      if (cd "$dir" && bash -c "$1") >>"$log" 2>&1; then echo "   pass" | tee -a "$log"
      else echo "   FAIL (see $log)" | tee -a "$log"; printf 'result=fail\nsha=%s\nstep=%q\n' "$sha" "$1" > "$state/eval"; exit 1; fi
    }
    run_step "pnpm run build:artifacts"
    while IFS= read -r line; do run_step "$line"; done <<< "$checks"
    write_overlay
    echo "== smoke" | tee -a "$log"
    if smoke_checkout "$dir" "$home" >>"$log" 2>&1; then echo "   pass" | tee -a "$log"
    else echo "   FAIL (see $log)" | tee -a "$log"; printf 'result=fail\nsha=%s\nstep=smoke\n' "$sha" > "$state/eval"; exit 1; fi
    [[ "$(git -C "$dir" rev-parse HEAD)" == "$sha" && -z "$(git -C "$dir" status --porcelain)" ]] \
      || die "worktree changed during eval; rerun eval"
    printf 'result=pass\nsha=%s\nat=%s\n' "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$state/eval"
    echo "eval: pass at $sha"
    ;;
  adopt)
    require_worktree
    build=0; [[ "${3:-}" == --build ]] && build=1
    [[ -f "$state/eval" ]] || die "no eval record; run: $0 eval $name"
    # shellcheck disable=SC1091,SC2154
    . "$state/eval"
    [[ "$result" == pass ]] || die "last eval failed at step: ${step:-unknown}"
    [[ -z "$(git -C "$dir" status --porcelain)" ]] || die "worktree has uncommitted changes since eval"
    [[ "$sha" == "$(git -C "$dir" rev-parse HEAD)" ]] || die "HEAD moved since the passing eval of $sha; rerun eval"
    [[ ! -f "$state/adopted.patch" ]] || die "already adopted; run unadopt first to re-adopt"
    patch="$state/adopt.patch.tmp"
    git -C "$dir" diff --binary "$(cat "$state/baseline")" "$sha" > "$patch"
    [[ -s "$patch" ]] || { rm -f "$patch"; die "no changes between baseline and HEAD"; }
    if ! git -C "$root" apply --check "$patch"; then
      rm -f "$patch"
      die "patch does not apply to the main checkout; its files changed since the worktree baseline"
    fi
    git -C "$root" apply "$patch"
    mv "$patch" "$state/adopted.patch"
    echo "adopted into $root as uncommitted changes:"
    git -C "$root" apply --stat "$state/adopted.patch"
    if (( build )); then
      if git -C "$root" apply --numstat "$state/adopted.patch" | grep -q -E '(^|/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$'; then
        (cd "$root" && pnpm install --prefer-offline)
      fi
      if ! (cd "$root" && pnpm run build:artifacts) || ! smoke_checkout "$root" "$home/adopt-smoke"; then
        die "main checkout failed after adoption; restore it with: $0 unadopt $name && (cd $root && pnpm run build:artifacts)"
      fi
      echo "main checkout rebuilt; refresh the running GUI (restart dsh web if Host code changed)"
    else
      echo "next: (cd $root && pnpm run build:artifacts), then refresh the running GUI"
    fi
    ;;
  unadopt)
    [[ -f "$state/adopted.patch" ]] || die "nothing adopted for $name"
    git -C "$root" apply -R --check "$state/adopted.patch" \
      || die "adopted changes were edited in the main checkout; revert them by hand"
    git -C "$root" apply -R "$state/adopted.patch"
    mv "$state/adopted.patch" "$state/unadopted.patch"
    echo "reverted; rebuild with: (cd $root && pnpm run build:artifacts)"
    ;;
  web)
    require_worktree
    port="${3:-0}"
    write_overlay
    (cd "$dir" && DSH_HOME="$home" pnpm dsh --profile web --patch "$home/credentials.overlay.yml" --port "$port" --no-open)
    ;;
  rm)
    [[ ! -f "$state/adopted.patch" || "${3:-}" == --force ]] \
      || die "$name is adopted; rm would discard the patch unadopt needs (pass --force to remove anyway)"
    # Without --force, git refuses to remove a worktree that has uncommitted changes.
    git -C "$root" worktree remove "$dir"
    rm -rf "$home" "$state"
    ;;
  *) die "unknown command: $cmd" ;;
esac
