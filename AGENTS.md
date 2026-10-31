# Working on pi-comms

Read [docs/PRINCIPLES.md](docs/PRINCIPLES.md) before making product, design or implementation decisions. It is the shared guide for contributors, users and integrations. Use the [README](README.md) for shipped behavior and [docs/ROADMAP.md](docs/ROADMAP.md) for proposed features and milestones.

## Product direction

> pi-comms provides shared communication for independently managed agents. Improve continuity, clarity and reach while keeping its concepts small and its behavior consistent.

Prioritize a pleasant Pi experience, practical persistent collaboration, selective cross-harness support and reuse by organizing packages. Users and those packages own agent organization and work acceptance; pi-comms owns clear communication.

## How to make changes

- Start with the user capability and the existing contract. Extend the current tools, records and views where they fit. Keep unselected roadmap proposals out of implementation scope.
- Inspect and adapt useful existing implementations first. Record upstream source/version, license, local changes and the concrete cleanup follow-up. Harmonize public behavior immediately; consolidate borrowed internals in bounded follow-ups.
- Make changes cohesive across schemas, runtime, instructions, human and agent views, tests and docs. Give each kind of state a clear owner. Resolve conflicting assumptions rather than adding patchy exceptions.
- Preserve exact identity, contact decisions, native permissions, human-input priority and honest uncertainty. Make consequential restrictions or compatibility changes explicit product decisions.
- Distinguish runtime observations, peer-reported work outcomes and requester acceptance. Build human, model and integration views from the same communication records.
- Lead with useful results in plain, stable terms. Keep essential instructions short and load longer recipes on demand. Include conditions where they change a decision; remove repeated defensive commentary.
- Seek sufficient confidence at the lowest reasonable ongoing cost. Use focused regressions and representative installed-artifact journeys. State what scripted tests and real use actually establish.

## PR and release requirements

Before opening or updating a PR, read `RELEASING.md`.

- PRs that change shipped behavior must bump `package.json` and `package-lock.json` together using `npm version patch --no-git-tag-version` (choose minor or major when appropriate), and add a matching `## [X.Y.Z]` entry in `CHANGELOG.md` describing the user-visible changes.
- Check the current version on `main` and npm before choosing the next version. Do not reuse a published version or an existing release tag.
- Documentation/test-only PRs that do not need publication may use `release:none`; do not use it to bypass the version bump for runtime fixes, or combine it with a version bump.
- Run `npm run verify` before handing off the PR. Include the intended release version and verification results in the PR description.

Merging to `main` triggers publication; the workflow does not bump versions. If the version already exists, it checks out the old tag and skips publishing, even when the run is green. Never move an existing release tag to ship new code.
