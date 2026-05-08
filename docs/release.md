# Release and Publish Checklist

This checklist is intended to make releases repeatable, low-risk, and easy to audit.

## 1) Versioning and changelog prep

- [ ] Choose semantic version bump (`patch`, `minor`, or `major`).
- [ ] Update `package.json` version.
- [ ] Update `CHANGELOG.md` with:
  - [ ] user-visible changes,
  - [ ] breaking changes,
  - [ ] migration notes (if needed).
- [ ] Confirm docs reflect current API behavior (especially protocol and result fields).

## 2) Local quality gates

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm run test`
- [ ] `npm run build`

If any command fails, do not publish.

## 3) Package content verification

- [ ] Run `npm pack --dry-run`.
- [ ] Confirm only expected files are included:
  - [ ] `dist/**`
  - [ ] `README.md`
  - [ ] `LICENSE`
- [ ] Confirm no private/internal files are included.
- [ ] Confirm generated type declarations are present in `dist`.

## 4) CI and branch readiness

- [ ] Ensure CI workflow is green on target commit.
- [ ] Ensure branch has required approvals/reviews.
- [ ] Ensure no pending docs or test TODOs tied to this version.

## 5) npm publish steps (public scoped package)

- [ ] Authenticate npm account with publish permissions for `@coveragemap`.
- [ ] Verify current npm identity:

```bash
npm whoami
```

- [ ] Publish:

```bash
npm publish --access public
```

- [ ] Verify package/version appears on npm registry.

## 6) Post-publish verification

- [ ] Install published version in a clean sample project.
- [ ] Run a smoke test import:
  - [ ] `SpeedTestEngine`
  - [ ] key type exports
  - [ ] build succeeds with consumer bundler.
- [ ] Confirm README examples still run against published package.

## 7) Post-release communication

- [ ] Create release/tag notes in GitHub.
- [ ] Share key changes and migration notes to consumers.
- [ ] Track any hotfix issues for first 24-48 hours.

## Semver policy guidance

- Use `0.x` while API still evolves quickly.
- Use `1.0.0` when:
  - API is stable,
  - docs are complete and specific,
  - CI/test coverage is consistently strong,
  - release process is proven over multiple iterations.
