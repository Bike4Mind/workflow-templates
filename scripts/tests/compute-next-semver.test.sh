#!/usr/bin/env bash
# Dependency-free tests for compute-next-semver.sh (no bats/jq).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SUT="$HERE/../compute-next-semver.sh"
pass=0; fail=0

# check <name> <current> <stdin> <expected_stdout> <expected_exit>
check() {
  local name="$1" current="$2" input="$3" exp_out="$4" exp_code="$5"
  local out code
  out="$(printf '%s' "$input" | bash "$SUT" "$current" 2>/dev/null)"; code=$?
  if [ "$out" = "$exp_out" ] && [ "$code" = "$exp_code" ]; then
    pass=$((pass+1))
  else
    fail=$((fail+1))
    echo "FAIL - $name: got out='$out' code=$code ; want out='$exp_out' code=$exp_code"
  fi
}

check "feat->minor"          "0.1.0" $'feat: add x'                   "0.2.0" 0
check "fix->patch"           "0.1.0" $'fix: y'                        "0.1.1" 0
check "perf->patch"          "0.1.0" $'perf: faster'                  "0.1.1" 0
check "refactor->patch"      "0.1.0" $'refactor: tidy'               "0.1.1" 0
check "bang->major"          "0.1.0" $'feat!: boom'                   "1.0.0" 0
check "scope-bang->major"    "0.1.0" $'feat(api)!: boom'             "1.0.0" 0
check "fix-bang->major"      "0.1.0" $'fix!: boom'                    "1.0.0" 0
check "max-of-mixed"         "0.1.0" $'fix: a\nfeat: b\nchore: c'     "0.2.0" 0
check "major-wins"           "0.1.0" $'fix: a\nfeat!: b\nfeat: c'     "1.0.0" 0
check "no-release"           "0.1.0" $'chore: x\ndocs: y'            ""      0
check "empty-stdin"          "0.1.0" ''                               ""      0
check "nonconventional"      "0.1.0" $'update stuff\nWIP'             ""      0
check "patch-from-1x"        "1.2.3" $'fix: z'                        "1.2.4" 0
check "minor-resets-patch"   "1.2.3" $'feat: z'                       "1.3.0" 0
check "major-resets"         "1.2.3" $'feat!: z'                      "2.0.0" 0
check "multi-scope"          "0.1.0" $'feat(a,b): x'                 "0.2.0" 0
check "empty-current"        ""      $'feat: x'                       "0.1.0" 0
check "colon-required"       "0.1.0" $'feat add x'                    ""      0
check "chore-bang->major"    "0.1.0" $'chore!: boom'                  "1.0.0" 0
check "leading-zero-patch"   "1.2.08" $'fix: x'                       "1.2.9" 0
check "leading-zero-minor"   "1.010.3" $'feat: x'                     "1.11.0" 0

# usage error: malformed current version -> exit 2
printf 'feat: x' | bash "$SUT" "not-a-version" >/dev/null 2>&1; code=$?
if [ "$code" = "2" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL - bad-current-exit2: code=$code"; fi

echo "----"
echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
