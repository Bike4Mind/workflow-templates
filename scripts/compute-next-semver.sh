#!/usr/bin/env bash
# compute-next-semver.sh — pure SemVer bump for premium overlay releases.
#
# Usage:   compute-next-semver.sh <CURRENT>
#   <CURRENT>  MAJOR.MINOR.PATCH (no "v" prefix). Empty/absent => 0.0.0.
#   stdin      commit subject lines, one per line.
#   stdout     next MAJOR.MINOR.PATCH when a bump is warranted; nothing otherwise.
#   exit       0 on success (release or no-op); 2 on malformed <CURRENT>.
#
# Bump rules mirror bike4mind core's auto-changeset.yml (max across commits):
#   type!: / type(scope)!:  -> major
#   feat                    -> minor
#   fix | perf | refactor   -> patch
#   everything else         -> ignored
set -euo pipefail

CURRENT="${1:-0.0.0}"
[ -z "$CURRENT" ] && CURRENT="0.0.0"
if ! [[ "$CURRENT" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "usage: compute-next-semver.sh <MAJOR.MINOR.PATCH>; got '$CURRENT'" >&2
  exit 2
fi
MAJOR="${BASH_REMATCH[1]}"; MINOR="${BASH_REMATCH[2]}"; PATCH="${BASH_REMATCH[3]}"
# Force base-10: a leading-zero segment (e.g. "08", "010") is otherwise read as
# octal by $(( )), silently corrupting or erroring the bump. 10# pins decimal.
MAJOR=$((10#$MAJOR)); MINOR=$((10#$MINOR)); PATCH=$((10#$PATCH))

# conventional-commit subject: type(optional scope)(optional !): <space> description
conv='^[a-z]+(\([a-zA-Z0-9,/_-]+\))?(!)?:[[:space:]].+'
bang='^[a-z]+(\([a-zA-Z0-9,/_-]+\))?!:'

level=0   # 0=none 1=patch 2=minor 3=major
while IFS= read -r subject || [ -n "$subject" ]; do
  [ -z "$subject" ] && continue
  [[ "$subject" =~ $conv ]] || continue
  type="${subject%%[!a-z]*}"          # leading lowercase run = the type token
  if [[ "$subject" =~ $bang ]]; then
    cur=3
  elif [ "$type" = "feat" ]; then
    cur=2
  elif [ "$type" = "fix" ] || [ "$type" = "perf" ] || [ "$type" = "refactor" ]; then
    cur=1
  else
    cur=0
  fi
  [ "$cur" -gt "$level" ] && level="$cur"
done

case "$level" in
  3) MAJOR=$((MAJOR+1)); MINOR=0; PATCH=0 ;;
  2) MINOR=$((MINOR+1)); PATCH=0 ;;
  1) PATCH=$((PATCH+1)) ;;
  0) exit 0 ;;   # no release -> print nothing
esac
echo "${MAJOR}.${MINOR}.${PATCH}"
