# Contributing to neu-browser-mcp

Thanks for your interest in contributing! This document covers how to propose changes, the local development setup, and the conventions we follow.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report bugs** and **request features** via [GitHub Issues](../../issues) using the provided templates.
- **Improve docs** — fixes to the README and inline docs are always welcome.
- **Submit code** via pull requests (see below).

For security vulnerabilities, **do not** open a public issue — follow [SECURITY.md](SECURITY.md).

## Development workflow

This project uses a **pull-request workflow**. Direct pushes to `main` are not accepted; all changes land through review.

1. **Fork** the repository (or create a branch if you have write access).
2. Create a topic branch: `git checkout -b feat/short-description`.
3. Make your change, with tests where it makes sense.
4. Run the checks locally (see below).
5. Open a pull request against `main`. Fill out the PR template — describe the change, how you tested it, and link any related issue.
6. CI runs on the PR. Address review feedback by pushing follow-up commits.

Keep PRs focused: one logical change per PR is much easier to review than a large mixed bag.

## Local development

Requires Node.js 24 (the current LTS) or newer. The project uses **npm**, **[Biome](https://biomejs.dev)** for linting and formatting, and **[Vitest](https://vitest.dev)** for tests.

```bash
npm install
npx tsc --noEmit          # type-check
npx biome check .         # lint + format
npm test                  # unit tests
npm run build             # bundle + type declarations into dist/
```

## Adding a browser backend

A backend is one file in `src/providers/` that returns a `BrowserProvider` (see `src/types.ts`). Before opening a PR for a new one, please open an issue: the tool surface is shared by every backend, so we want to agree on how the backend's sessions map onto it first.

## Commit and PR conventions

- Write commit messages in **English**, present tense, with a concise summary line. We loosely follow [Conventional Commits](https://www.conventionalcommits.org/) prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`) — not enforced, but appreciated.
- Keep the history readable: squash noisy fix-up commits before requesting review when practical.
- Reference issues with `Fixes #123` / `Closes #123` so they auto-close on merge.

## License of contributions

This project is licensed under the [Apache License 2.0](LICENSE). By submitting a contribution, you agree that it is licensed under the same terms, and you certify that you have the right to submit it (per the Apache-2.0 inbound=outbound convention).
