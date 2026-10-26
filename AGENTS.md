# Agent notes

Working conventions for this repository, so that automated assistants leave the
same kind of history a person would.

## Commits carry no AI attribution

Commit messages here are plain: a subject line, and a body when the reason
behind the change is worth explaining. Never append a "Generated with …" line, a
`Co-Authored-By:` trailer, an emoji badge, or any other credit for an AI tool,
model or agent — mine included. This holds for commits, amends, rebases,
squashes and cherry-picks.

It is not only a matter of taste: GitHub's contributor graph counts
`Co-Authored-By:` as shared authorship, so a trailer puts a bot in the
repository's contributor list. That already happened once here, and `main` had
to be rewritten and force-pushed to take it out. Don't reintroduce it.

## How changes land

- Commit straight to `main` and push once the change is finished and verified.
- `.githooks/pre-commit` runs the API suite before every commit; enable it per
  clone with `git config core.hooksPath .githooks`. Don't use `--no-verify` to
  push a change past a failing test — fix the test or the code.
