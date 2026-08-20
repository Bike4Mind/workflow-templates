#!/bin/sh
set -eu

# Self-test for a gitleaks configuration.
#
# Guards the failure mode this exists for: a config that loads without error while
# detecting nothing. That is a secret-scanning outage, and it is invisible - the scan
# job goes green, the pre-commit hook goes green, and nothing is being caught.
#
# Three known ways it happens, one assertion each:
#   1. `[extend] useDefault` missing or misspelled, so no builtin rule is loaded.
#   2. The `[[allowlists]]` array form used instead of the singular `[allowlist]`
#      table, which some gitleaks versions silently ignore, dropping every exclusion.
#   3. A domain rule whose regex has a capturing group that the `entropy` floor is
#      applied to, so it scores a short literal and never reports. Exit status cannot
#      see this, because an overlapping builtin rule reports the same shape - so each
#      domain rule is checked by rule id in the JSON report.
#
# Usage: gitleaks-config-selftest.sh [path-to-config]
#   default: gitleaks-default.toml sitting next to this script
#
# Set GITLEAKS_REQUIRED=1 to fail rather than skip when gitleaks is not installed.
# In CI a skip is indistinguishable from a pass, so CI always sets it.
#
# Every canary is GENERATED at runtime into a temp dir. Never commit a
# credential-shaped literal: secret scanners alert on example values in tracked
# files, and cannot tell a fabricated one from a live one.

# Resolved from the script's own location, not the repo root: this ships inside a
# composite action and runs with the CALLING repository as the working directory.
# shellcheck disable=SC1007  # `CDPATH= cd` clears CDPATH for this command only,
# so a user's CDPATH cannot make `cd` land somewhere else and print the wrong path.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CONFIG=${1:-"$SCRIPT_DIR/gitleaks-default.toml"}

if [ ! -f "$CONFIG" ]; then
  echo "FAIL: config not found: $CONFIG"
  exit 1
fi

GITLEAKS_PATH=$(command -v gitleaks 2>/dev/null || true)
if [ -z "$GITLEAKS_PATH" ]; then
  if [ "${GITLEAKS_REQUIRED:-0}" = "1" ]; then
    echo "FAIL: GITLEAKS_REQUIRED=1 but gitleaks is not on PATH."
    exit 1
  fi
  echo "gitleaks is not installed; skipping config self-test."
  echo "  Mac: brew install gitleaks"
  exit 0
fi

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT
FAILED=0

# run_scan <file> <report-path> -> writes a JSON report.
#
# Judged by report CONTENTS, never by exit status. gitleaks exits non-zero both when
# it finds a secret AND when the invocation is wrong - a flag that does not exist on
# this version, an unreadable config - so an exit-status assertion happily reports
# "detected" for a scan that never ran. That is the same class of silent outage this
# script exists to catch. Anything other than 0 (clean) or 1 (findings) is fatal.
#
# This is not hypothetical: the first draft passed `--no-git`, which `gitleaks dir`
# does not accept on 8.30, and the usage error read as a successful detection.
run_scan() {
  _file=$1
  _report=$2
  _err="$TEMP_DIR/stderr.txt"
  set +e
  "$GITLEAKS_PATH" dir --config "$CONFIG" --no-banner --redact --log-level error \
    --report-format json --report-path "$_report" "$_file" >/dev/null 2>"$_err"
  _rc=$?
  set -e
  if [ "$_rc" -ne 0 ] && [ "$_rc" -ne 1 ]; then
    echo "FAIL: gitleaks exited $_rc - the scan did not run."
    sed 's/^/      /' "$_err" | head -5
    exit 1
  fi
}

# findings_count <report-path> -> number of findings recorded
findings_count() {
  if [ ! -s "$1" ]; then
    echo 0
    return
  fi
  # `grep -c` prints 0 AND exits 1 on no match, so a `|| echo 0` fallback emits two
  # lines and the caller's [ ] test blows up. Capture, then default.
  _n=$(grep -c '"RuleID"' "$1" 2>/dev/null) || _n=0
  echo "${_n:-0}"
}

rand_str() {
  LC_ALL=C tr -dc "$1" < /dev/urandom | head -c "$2"
}

# --- Assertion 1: builtin rules are loaded ------------------------------------
# An AWS access-key shape is used because it comes from gitleaks' builtin ruleset,
# not from the domain rules in the config, so it can only match when
# `[extend] useDefault = true` is in effect.
#
# The suffix charset is base32, not A-Z0-9: gitleaks 8.28 narrowed the builtin rule
# to [A-Z2-7]{16} (real AWS key ids are base32), so a suffix containing 0/1/8/9 goes
# undetected and this assertion would report an outage that is not happening.
# Base32 also matches the wider pre-8.28 charset, so one canary covers both.
printf "const canary = 'AKIA%s';\n" "$(rand_str 'A-Z2-7' 16)" > "$TEMP_DIR/canary.ts"
run_scan "$TEMP_DIR/canary.ts" "$TEMP_DIR/canary.json"
if [ "$(findings_count "$TEMP_DIR/canary.json")" -eq 0 ]; then
  echo "FAIL: builtin rules are not active - a planted AWS-key shape was not detected."
  echo "      Check that the config still contains [extend] useDefault = true."
  FAILED=1
else
  echo "ok: builtin rules active (planted credential shape detected)"
fi

# --- Assertion 2: the global allowlist is honored -----------------------------
# The probe must be a shape the DEFAULT ruleset reports and this config exempts.
# Getting that wrong is easy and silent: the first draft used AWS's canonical
# documentation key, which gitleaks' own builtin allowlist already exempts, so the
# assertion passed no matter what this config's [allowlist] did.
#
# So the probe is validated before it is trusted - scanned with no config at all,
# where it MUST report. Slack's documentation sample webhook fits: the builtin
# slack-webhook-url rule reports it, and only this config's global regexes exempt it.
SLACK_SAMPLE="https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXXX"
printf "const hook = '%s';\n" "$SLACK_SAMPLE" > "$TEMP_DIR/allowlisted.ts"

set +e
"$GITLEAKS_PATH" dir --no-banner --redact --log-level error \
  --report-format json --report-path "$TEMP_DIR/probe-unconfigured.json" \
  "$TEMP_DIR/allowlisted.ts" >/dev/null 2>&1
set -e
if [ "$(findings_count "$TEMP_DIR/probe-unconfigured.json")" -eq 0 ]; then
  echo "WARN: the allowlist probe no longer trips the default ruleset."
  echo "      This assertion is now vacuous - pick a different probe shape."
else
  run_scan "$TEMP_DIR/allowlisted.ts" "$TEMP_DIR/allowlisted.json"
  if [ "$(findings_count "$TEMP_DIR/allowlisted.json")" -eq 0 ]; then
    echo "ok: global allowlist honored (documentation sample excluded)"
  else
    echo "FAIL: an allowlisted documentation sample reported a finding."
    echo "      The global allowlist is being ignored. Check that the config still"
    echo "      uses the singular [allowlist] table and still lists the sample"
    echo "      literals - the [[allowlists]] array form is silently ignored by some"
    echo "      gitleaks versions."
    FAILED=1
  fi
fi

# --- Assertion 3: every domain rule is reachable ------------------------------
#
# Scoped to the rules the config actually declares. A repository that brings its own
# .gitleaks.toml names its rules differently - bike4mind uses bike4mind-slack-webhook
# where the org default uses b4m-slack-webhook - so asserting ids it never defines
# reports a scanning outage that is not happening.
#
# That is not hypothetical: it failed every nightly sweep of bike4mind, and because
# the sweep runs the scan with continue-on-error the job still reported green. Only
# the "did not scan" line in the tracking issue caught it.
#
# Deriving the set from the config rather than from the file path keeps a config that
# DOES declare these rules honest even when it lives somewhere else, which is what the
# test suite relies on to prove this assertion can still fail.
ASSERTED=0
SKIPPED=0

assert_rule_reachable() {
  rule_id=$1
  canary=$2
  if ! grep -q "id *= *\"$rule_id\"" "$CONFIG"; then
    SKIPPED=$((SKIPPED + 1))
    return
  fi
  ASSERTED=$((ASSERTED + 1))
  canary_file="$TEMP_DIR/domain-$rule_id.ts"
  report_file="$TEMP_DIR/domain-$rule_id.json"
  printf '%s\n' "$canary" > "$canary_file"
  run_scan "$canary_file" "$report_file"
  if [ -f "$report_file" ] && grep -q "\"RuleID\": *\"$rule_id\"" "$report_file"; then
    echo "ok: $rule_id matched a generated canary"
  else
    echo "FAIL: $rule_id matched nothing - the rule is unreachable and scans nothing."
    echo "      Most likely its regex has a capture group that the entropy floor is"
    echo "      applied to. Make the group non-capturing, or point secretGroup at the"
    echo "      credential. Verify with: gitleaks dir --config <cfg> <canary-file>."
    FAILED=1
  fi
}

# Three shapes below would be findings in this very file if written out whole,
# because what makes them match is a literal rather than a generated high-entropy
# run: the mongodb rule needs only a bare scheme, and the JWT/session rules need only
# `<KEY>=` followed by any non-space. Splitting the shape across a variable keeps this
# script clean under the config it is testing.
MONGO_SCHEME="mongodb+srv"
JWT_KEY="JWT_SECRET"
SESSION_KEY="SESSION_SECRET"

assert_rule_reachable b4m-mongodb-uri \
  "const uri = '$MONGO_SCHEME://svc_$(rand_str 'a-z0-9' 8):$(rand_str 'A-Za-z0-9' 24)@cluster0.$(rand_str 'a-z0-9' 5).mongodb.net/app';"
# Anchored on the key NAME, so the canary needs that name adjacent to the value.
AWS_SECRET_KEY_NAME="aws_secret_access_key"
assert_rule_reachable b4m-aws-secret-access-key \
  "$AWS_SECRET_KEY_NAME = '$(rand_str 'A-Za-z0-9' 40)'"
assert_rule_reachable b4m-jwt-secret \
  "B4M_$JWT_KEY=$(rand_str 'A-Za-z0-9' 40)"
assert_rule_reachable b4m-session-secret \
  "B4M_$SESSION_KEY=$(rand_str 'A-Za-z0-9' 40)"
assert_rule_reachable b4m-stripe-keys \
  "const key = 'sk_live_$(rand_str 'A-Za-z0-9' 32)';"
assert_rule_reachable b4m-anthropic-key \
  "const key = 'sk-ant-$(rand_str 'A-Za-z0-9' 52)';"
assert_rule_reachable b4m-openai-key \
  "const key = 'sk-proj-$(rand_str 'A-Za-z0-9' 48)';"
assert_rule_reachable b4m-gemini-key \
  "const key = 'AIza$(rand_str 'A-Za-z0-9' 35)';"
assert_rule_reachable b4m-slack-webhook \
  "const hook = 'https://hooks.slack.com/services/T$(rand_str 'A-Za-z0-9' 9)/B$(rand_str 'A-Za-z0-9' 9)/$(rand_str 'A-Za-z0-9' 24)';"

if [ "$SKIPPED" -gt 0 ]; then
  echo "note: $SKIPPED rule assertion(s) skipped - this config does not declare them."
  if [ "$ASSERTED" -eq 0 ]; then
    echo "      No per-rule reachability was asserted. Builtin-rule and allowlist"
    echo "      assertions above are config-agnostic and did run."
  fi
fi

if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "gitleaks config self-test FAILED. A config can load cleanly and still detect"
  echo "nothing, so treat this as a secret-scanning outage, not a lint nit."
  exit 1
fi

echo "gitleaks config self-test passed."
