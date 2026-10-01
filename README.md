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
- `max_changed_files`, `protected_base_refs`, `protected_head_refs` and `skip_head_ref_prefix` gate which PRs are reviewed at all. The defaults suit most repos.

Every input is described in the header of [`.github/workflows/pr-bot-review.yml`](.github/workflows/pr-bot-review.yml).
