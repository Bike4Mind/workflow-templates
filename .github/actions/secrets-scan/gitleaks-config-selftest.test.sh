#!/bin/sh
set -eu

# Tests for scripts/gitleaks-config-selftest.sh.
#
# A guard that cannot fail is not a guard. Each case below breaks the config in one
# of the specific ways that has already caused a silent scanning outage, and asserts
# the self-test reports it. Without these, the self-test could regress into always
# printing "passed" and nothing would notice.

# shellcheck disable=SC1007  # `CDPATH= cd` clears CDPATH for this command only,
# so a user's CDPATH cannot make `cd` land somewhere else and print the wrong path.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SELFTEST="$SCRIPT_DIR/gitleaks-config-selftest.sh"
GOOD_CONFIG="$SCRIPT_DIR/gitleaks-default.toml"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is not installed; skipping self-test tests."
  echo "  Mac: brew install gitleaks"
  exit 0
fi

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT
FAILED=0

# run_selftest <config> -> prints exit status, never aborts this script
run_selftest() {
  set +e
  GITLEAKS_REQUIRED=1 sh "$SELFTEST" "$1" >"$TEMP_DIR/out.txt" 2>&1
  _rc=$?
  set -e
  echo "$_rc"
}

expect_pass() {
  _name=$1
  if [ "$(run_selftest "$2")" -eq 0 ]; then
    echo "ok: $_name"
  else
    echo "FAIL: $_name - expected the self-test to pass, it did not:"
    sed 's/^/      /' "$TEMP_DIR/out.txt"
    FAILED=1
  fi
}

expect_fail() {
  _name=$1
  _config=$2
  _needle=$3
  if [ "$(run_selftest "$_config")" -eq 0 ]; then
    echo "FAIL: $_name - the self-test passed on a config it should have rejected."
    FAILED=1
  elif grep -q "$_needle" "$TEMP_DIR/out.txt"; then
    echo "ok: $_name"
  else
    echo "FAIL: $_name - rejected, but not for the expected reason ('$_needle'):"
    sed 's/^/      /' "$TEMP_DIR/out.txt"
    FAILED=1
  fi
}

# --- The shipped config is healthy -------------------------------------------
expect_pass "shipped default config passes" "$GOOD_CONFIG"

# --- Builtin rules disabled ---------------------------------------------------
# Drops [extend] useDefault, which is what leaves every builtin rule off while the
# config still parses.
sed '/^\[extend\]$/,$d' "$GOOD_CONFIG" > "$TEMP_DIR/no-builtins.toml"
expect_fail "config without [extend] useDefault is rejected" \
  "$TEMP_DIR/no-builtins.toml" "builtin rules are not active"

# --- Global allowlist not honored ---------------------------------------------
# Removes the literal that exempts AWS's canonical documentation key, so the
# allowlist probe starts reporting. This is the generic "exclusions stopped
# applying" failure.
#
# Note on the [[allowlists]] array form: it is a genuine hazard on older gitleaks,
# which parse it and silently ignore it, but the pinned 8.30.1 supports both forms,
# so it cannot be reproduced here. The config comment keeps the warning; this case
# tests the outcome (exclusions not applied) rather than one cause of it.
# Strips the Slack documentation sample literals from the GLOBAL [allowlist] only.
# The b4m-slack-webhook rule keeps its own rule-level allowlist, so this isolates
# the global table: if only the rule allowlist were doing the work, the probe would
# stay quiet and this case would not fail.
sed '/^\[allowlist\]$/,/^\[\[rules\]\]$/{/T00000000/d;/B00000000/d;/XXXXXXXXXXXXXXXXXXXXXXXXX/d;}' \
  "$GOOD_CONFIG" > "$TEMP_DIR/no-allowlist.toml"
expect_fail "config that stops honoring the allowlist is rejected" \
  "$TEMP_DIR/no-allowlist.toml" "global allowlist is being ignored"

# --- A domain rule made unreachable -------------------------------------------
# Rewrites the mongodb rule's regex so it cannot match anything. Exit status alone
# cannot see this - an overlapping builtin reports the same shapes - which is why
# the self-test checks rule ids in the JSON report.
sed 's|mongodb(?:|zzznomatch(?:|' "$GOOD_CONFIG" > "$TEMP_DIR/dead-rule.toml"
expect_fail "config with an unreachable domain rule is rejected" \
  "$TEMP_DIR/dead-rule.toml" "b4m-mongodb-uri matched nothing"

# --- A caller's own config runs the generic assertions only -------------------
# A repository that brings its own .gitleaks.toml names its rules differently, so the
# per-rule canaries cannot apply. It must still be held to the config-agnostic
# assertions rather than skipped wholesale. Renaming every rule simulates that.
sed 's/^id = "b4m-/id = "custom-/' "$GOOD_CONFIG" > "$TEMP_DIR/custom-rule-ids.toml"
expect_pass "a config with foreign rule ids passes the generic assertions" \
  "$TEMP_DIR/custom-rule-ids.toml"

# ...but is still rejected when a generic assertion genuinely fails, so the escape
# hatch above cannot be used to smuggle a broken config through.
sed '/^\[extend\]$/,$d' "$TEMP_DIR/custom-rule-ids.toml" > "$TEMP_DIR/custom-broken.toml"
expect_fail "a foreign-id config with builtins disabled is still rejected" \
  "$TEMP_DIR/custom-broken.toml" "builtin rules are not active"

# --- A missing config is an error, not a skip ---------------------------------
expect_fail "a missing config file is rejected" \
  "$TEMP_DIR/does-not-exist.toml" "config not found"

if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "gitleaks-config-selftest tests FAILED."
  exit 1
fi

echo "gitleaks-config-selftest tests passed."
