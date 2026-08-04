# overlay-link

Wires a hydrated premium overlay into the host's `apps/client` so pnpm links it before the
host's premium codegen runs, then verifies the link took.

The host (`Bike4Mind/bike4mind`) gitignores `packages/premium/*`, so `apps/client/package.json`
cannot declare an overlay and pnpm never links it on its own. Since `bike4mind#1014` the host's
premium codegen `exit 1`s under CI on that un-linked state, so any workflow that hydrates an
overlay and runs `pnpm install` itself must add the link first.

This is a two-phase action because the consumer's own `pnpm install` sits between the phases:

```yaml
- uses: Bike4Mind/workflow-templates/.github/actions/overlay-link@main
  with:
    overlay_name: bob   # -> @bike4mind/premium-bob
    phase: link         # BEFORE install

- run: pnpm install --no-frozen-lockfile --recursive

- uses: Bike4Mind/workflow-templates/.github/actions/overlay-link@main
  with:
    overlay_name: bob
    phase: verify       # AFTER install
```

`overlay-ci.yml` (the shared reusable) inlines these same two steps. This action exists so the
bespoke workflows that cannot shim the reusable - `eval.yml` in the overlay repos, and any other
workflow that hydrates the host and installs itself - stop hand-copying the block. Previously the
copies were kept byte-identical by eye across four repos and had already started to drift.
