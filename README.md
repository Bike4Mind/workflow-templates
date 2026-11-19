# workflow-templates

Reusable GitHub Actions workflows shared across Bike4Mind repos. Each one is called with `workflow_call` from a small stub in the calling repo. Each workflow's header comment documents its inputs.

## pr-bot-review

The PR review bot. A caller adds the stub below as `.github/workflows/pr-bot-review.yml`, then creates the labels `bot-review` and `bot-review-fold`.

- `bot-review` reviews the PR and posts one review.
- `bot-review-fold` also applies the findings that meet the skill's fold bar, as one non-force fixup commit on the PR head.

The label is removed when the run finishes, so re-applying it starts a fresh run. On a draft, a fork or a protected ref the run is skipped and the label stays. Remove it and add it again once the PR qualifies.

### Caller stub

```yaml
name: pr-bot-review
on:
  pull_request:
    types: [labeled]
permissions:
  contents: read
  pull-requests: write
  issues: write
  actions: read
  id-token: write  # required by claude-code-action even when using anthropic_api_key
concurrency:
  group: pr-bot-review-${{ github.event.pull_request.number }}-${{ (github.event.label.name == 'bot-review' || github.event.label.name == 'bot-review-fold') && 'bot' || github.run_id }}
  cancel-in-progress: ${{ github.event.label.name != 'bot-review-fold' }}
jobs:
  review:
    # Do NOT switch this to pull_request_target: it would check out the untrusted
    # head and run an agent over it. The fork gate lives inside the reusable.
    if: github.event.label.name == 'bot-review' || github.event.label.name == 'bot-review-fold'
    # workflow-templates main, <date>
    uses: Bike4Mind/workflow-templates/.github/workflows/pr-bot-review.yml@<40-char sha>
    secrets: inherit
    with:
      fold_mode: ${{ github.event.label.name == 'bot-review-fold' }}
      # b4m-devtools main, <date>
      skill_ref: <40-char sha>
```

### What the stub must keep

- **`permissions:`** The reusable's token can only narrow what the caller grants. Without this block the job gets the repo's default read-only token, and every review write fails with 403.
- **`concurrency:`** A group inside a called workflow does not reliably supersede the caller's run, so it lives here. The `cancel-in-progress` test must name `bot-review-fold`: a fold run never cancels a run already in flight. Workflow-level concurrency applies before the job `if:`, so every label added to the PR joins a group. The `run_id` fallback in the group key gives any other label a group of its own, so it cancels nothing.
- **`secrets: inherit`.** The reusable declares no `secrets:` block. It reads the secrets `ANTHROPIC_API_KEY`, `PREMIUM_OVERLAY_APP_PRIVATE_KEY` and `BOT_REVIEW_APP_PRIVATE_KEY`, and the variables `PREMIUM_OVERLAY_CLIENT_ID` and `BOT_REVIEW_CLIENT_ID`, all from the calling repo or its org. The `PREMIUM_OVERLAY_*` App reads the skill repo. The `BOT_REVIEW_*` App pushes fold commits, so it must be installed on the calling repo with `contents: write`.
- **Both SHAs.** Pin `uses:` and `skill_ref` to full 40-character commit SHAs. `skill_ref` has no default, and the run refuses anything but a SHA.
- **The label names, in all three places.** The `if:`, `fold_mode` and `cancel-in-progress` lines each name `bot-review-fold`. Miss the `if:` and no fold run starts. Miss `cancel-in-progress` and an incoming fold run cancels whatever is already in flight.

### Inputs worth setting

- `verdict_on_clean` defaults to `COMMENT`. Set `APPROVE` if a clean review should count as an approval.
- `changeset_guard` defaults to `false`. Set it to `true` in a repo whose release bot pushes changeset commits, so a re-review is skipped when those are the only new commits. `changeset_bot_login` names that bot.
- `runner_label` defaults to `ubuntu-latest`. A fold run refuses anything but a GitHub-hosted Linux runner, because its write fences name that image's paths. Review runs work on any runner. Do not pass `vars.RUNNER_LABEL` here: repos point it at their build tier, which would fail every fold run.
- `anthropic_federation_rule_id`, `anthropic_organization_id`, `anthropic_service_account_id` and `anthropic_workspace_id` switch the review from the `ANTHROPIC_API_KEY` secret to workload identity federation. They are identifiers, not secrets, and the stub still needs `id-token: write`. Setting the rule id stops the secret reaching the action, so a failed exchange fails the review: it is not a runtime fallback, and rolling back means dropping these `with:` lines from the stub. Two things to know before the first federated run:
  - Make the federation rule require both the calling repository (`repository`, or the `sub` for it) and the workflow, by matching the `job_workflow_ref` claim against `Bike4Mind/workflow-templates/.github/workflows/pr-bot-review.yml@`. Callers pin by SHA, so the claim ends in `@<sha>` and needs a prefix match. Neither condition is enough alone: `repository` alone lets any other workflow in the repo with `id-token: write` exchange a token, and the `job_workflow_ref` prefix alone accepts tokens from any other owner's repo that calls this public reusable.
  - The action's inline-comment classification step runs only with an API key, so on a federated run every buffered inline comment that is not confirmed is posted unclassified.
- `max_changed_files`, `protected_base_refs`, `protected_head_refs` and `skip_head_ref_prefix` gate which PRs are reviewed at all. The defaults suit most repos.

Every input is described in the header of [`.github/workflows/pr-bot-review.yml`](.github/workflows/pr-bot-review.yml).

## sst-deploy console promotion

`sst-deploy.yml` also supports an opt-in, SHA-pinned console promotion. Existing push and preview calls keep their current behavior when every promotion input is omitted; the promotion gate job is skipped without allocating a runner. A promotion caller must pass all three:

| Input | Value |
| --- | --- |
| `promotion_sha` | `inputs.sha`, a full lowercase commit SHA reachable from main |
| `promotion_actor` | `vars.DEPLOY_CONSOLE_ACTOR`, the trusted console App bot login including `[bot]` |
| `promotion_required_checks` | A nonempty JSON array of exact check names from the main push workflow |

The caller must expose `workflow_dispatch` inputs `tier` (choice containing only `production`) and `sha`. Dispatch must target main. Blank or invalid promotion configuration fails closed; the App actor must match both the original actor and rerun initiator. The gate runs without an environment, package installation, secrets or OIDC permissions. It requires the newest staging deployment for that SHA to have a successful latest non-inactive status, both written by `github-actions[bot]`. Required checks must be successful GitHub Actions checks from a push on main for the same SHA; dispatch and PR runs cannot substitute for main validation. A check counts only when the job list of that push run contains it, with the same id and name. List the staging deploy job among the required checks, so the staging result is verified as a job of that run. The newest matching main-push check wins, including failed or pending reruns.

Caller job permissions must include `contents: read`, `actions: read`, `checks: read`, `deployments: write`, `id-token: write`, and `pull-requests: write`. The last permission is required by the reusable workflow’s preview job declaration even when promotion skips that job. Existing callers with explicit permission blocks must add the new Actions/check read permissions when upgrading; unconstrained callers retain their existing permission inheritance. Retain the application's existing `sst_app`, stages, environments, URLs, Node/pnpm versions, validation command, and pre/post deployment commands. Those hooks continue to run against the selected source. The production job shares `deploy-<prod_env>` concurrency with ordinary deployments and checks out the exact approved SHA. Staging and preview jobs do not run for a promotion.

The promotion creates an explicit Deployment record for the selected SHA before checkout, reports `in_progress`, then reports `success`, `failure` or `error` (cancellation). GitHub's automatic environment record may separately reference the dispatch ref; the explicit record identifies the promoted source. Forced termination may prevent final status reporting. No persistent queue or queued event is provided by this adapter.

Onboarding should generate a separate `deploy-tier.yml` caller pinned to an immutable workflow-templates commit containing this contract. Keep automatic main enablement off until its GitHub App repository access, actor variable, required checks, staging evidence and production permissions are verified. This adapter does not disable existing production branch triggers; that is a separate rollout decision.

Local validation: `node --test tests/*.test.cjs` and `actionlint -shellcheck="" .github/workflows/sst-deploy.yml`. Local tests do not prove deployed permissions, OIDC trust, or environment protection settings. Test the workflow in a sandbox repository, covering existing push and preview behavior and promotion allow and deny cases, before pointing real callers at a new revision.

The promotion inputs interact with the other inputs as follows. A promotion never runs the staging job, so `staging: false` does not change it, but the gate still requires a staging deployment record for the SHA, which only the staging job writes. A caller that sets `staging: false` therefore needs another process to publish that record, or every promotion is denied. `validate_runner`, `deploy_runner` and `working_directory` apply to a promotion exactly as they do to an ordinary run; the gate job itself always runs on `ubuntu-latest`.

For console onboarding, require both the source validation and staging deployment checks, for example `["deploy / Validate","deploy / Deploy staging"]`; verify the exact names in each app before enabling it. The staging success check supplies push/main workflow provenance. Deployment records alone identify the shared GitHub Actions bot, not which workflow wrote them: every repository workflow with `deployments: write` shares that identity. This initial adapter does not change historical staging payloads or claim stronger record provenance.

### Repository-owned additional checks

Promotion callers may opt in with both optional `policy_path` and `policy_digest` inputs. Omit both to keep the legacy contract. A partial, missing or invalid policy configuration denies promotion. These inputs are reviewed caller configuration; the dispatched user supplies the selected release SHA, not the policy authority.

The path is a relative JSON file on trusted main, at most 240 characters, with forward-slash ASCII segments containing letters, digits, underscores, dots or hyphens. Empty segments and exact `.`, `..` or `.git` segments are forbidden. Example: `.github/promotion-policy.json`.

```json
{"version":1,"additionalRequiredChecks":["Integration tests"]}
```

Only those two JSON keys are accepted. UTF-8 JSON is bounded to 16 KiB. Additions may be empty and may repeat names; they cannot remove centrally configured baseline checks. Baseline and additions each have at most 32 entries. For opted-in callers, names must be trimmed nonempty strings of at most 160 JavaScript code units, without ASCII control characters. The effective list is the unique union, sorted with JavaScript's default string ordering, at most 64 names. Its digest is lowercase SHA256 of UTF-8 `JSON.stringify(effectiveChecks)`.

The workflow independently resolves main to a full commit and reads the policy at that immutable commit. It verifies bounded file metadata, blob identity, schema, effective digest and the existing exact-SHA staging/check provenance. The same full verification is the first production step, before checkout or package code can use the job's OIDC permission, and runs again after package installation immediately before AWS credential configuration, deployment hooks and SST deployment. Missing policy, API failures, changed requirements or newly failing required checks deny deployment. Either production policy denial skips the failure-unlock hook; a deployment failure after both production verifications succeed keeps normal unlock behavior. Source commit, policy blob and effective digest are logged for audit. Formatting changes, duplicate additions, blob changes and unrelated main advances are accepted when effective requirements remain identical.

There is no atomic GitHub policy-and-deployment transaction. Policy updates after the final verification boundary apply to later deployments. Repository policy adds check names only; it cannot alter authorization, enable force, remove baseline checks or execute code. Trusted main maintainers review policy changes through the normal repository PR process. Existing pending console requests without the new policy snapshot must be recreated when a target first opts in.

### Standalone promotion verifier action

`.github/actions/verify-promotion` exposes the same verifier for applications that retain a bespoke deployment workflow. Reference the action with its reviewed immutable commit: `Bike4Mind/workflow-templates/.github/actions/verify-promotion@<full-reviewed-commit-sha>`. `sst-deploy.yml` invokes the action at a pinned full commit SHA at all three verification boundaries. Existing consumer workflow pins remain unchanged; they adopt this refactor only when they select a workflow revision containing it.

Inputs are `promotion_sha`, `promotion_actor`, `promotion_required_checks`, `staging_env`, `policy_path` and `policy_digest`, with the same meanings and policy contract above. Outputs are `enabled`, `policy_digest`, `policy_source_commit` and `policy_blob_sha`. The last three are populated only for an opted-in repository policy. Empty promotion configuration returns `enabled=false`; a successful no-op is not permission to deploy production. Partial or invalid promotion configuration fails closed.

The action derives the actor, rerun initiator, event, dispatch tier, ref, repository and GitHub token internally. It loads its verifier from the downloaded action directory without checking out or executing the application's selected source. Jobs require `contents: read`, `checks: read`, `actions: read` and `deployments: read`. It needs no AWS credentials, environment secrets or package installation, and performs no deployment or status writes.

A custom deployment workflow must run the verifier initially in a read-only job, first inside its environment/concurrency-bound production job before checkout or package code, and again immediately before AWS credentials after dependency installation. Require successful verification before production steps; do not let failure/cancellation cleanup obtain credentials or mutate state after a gate denial. Keep policy path and baseline checks in reviewed caller configuration. The action checks exact GitHub Actions names from successful push/main runs for the selected SHA; it does not require the application's deployment pipeline to use the SST template. Publish explicit staging `ref=SHA` metadata with a successful `github-actions[bot]` status only after the application's complete staging lifecycle succeeds.

Run the gate fixtures against the action and the frozen pre-extraction baseline:

```sh
node --test tests/promotion-gate.test.cjs
PROMOTION_GATE_ENGINE=baseline node --test tests/promotion-gate.test.cjs
```

The frozen verifier under `tests/fixtures` preserves the pre-extraction behavior for the same adversarial fixtures. Workflow tests separately assert the three immutable action references, input/output wiring, production ordering, legacy skip behavior and guarded failure cleanup. Local equivalence does not replace a live run in a sandbox repository.
