## Intent

What this change does and why. One paragraph max; link issues if any.

## Non-goals

What this change deliberately does NOT do (keeps review scope honest).

## Validation

State the exact commands run and their outcomes — never claim runtime
correctness from static checks alone:

```sh
npm run typecheck
npm test
npm run build
npm run verify:package
node scripts/verify-workflow-action-pins.mjs   # when workflows change
```

For behavioral/UI changes: point at the jsdom flow tests or the live smoke
evidence added/updated. For release/infra changes: state that a dry-run
release (`workflow_dispatch`, `dry_run: true`) was executed, per
`docs/RELEASE.md`.

## Risks

Anything a reviewer should probe (new server name edge cases, secret
handling, event races, workspace lifecycle, packaging surface).
