# Contributing

Issues and PRs welcome. Ground rules:

- **No secrets, ever.** No hostnames, certificates, tokens, or connection
  strings in code, fixtures, tests, or issue text. Fixtures are synthetic.
- `npm test` must pass (build + unit tests). If you touch tool behavior, run
  the integration smoke (`npm run smoke`) against a live site in BOTH auth
  modes and say so in the PR.
- Tool design conventions: read-only tools carry `readOnlyHint: true`;
  mutating tools register only under `QSEOW_ALLOW_MUTATIONS=true` and carry
  honest `destructiveHint`; every list tool is paged; every QRS egress path
  goes through `redactSecrets`.
- One behavior change per PR, with the "why" in the commit message.
