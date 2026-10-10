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
npm test                  # unit tests, no network
npm run build             # bundle + type declarations into dist/
```

`npm install` sets up a pre-commit hook that lints the staged files and type-checks, the same checks CI runs.

## Adding a browser backend

Backends are community-maintained: the maintainers run `nap`, and a backend for a hosted browser service is welcome from anyone with an account there.

A backend is one file in `src/providers/` that returns a `BrowserProvider` (see `src/types.ts`), plus a `case` in `src/env.ts` so the standalone server can select it. Declare in `capabilities` only what the service really does; the tools adapt to the declaration.

A backend PR needs:

- Unit tests with a stubbed `fetch`, like `test/nap.test.ts`.
- A passing smoke run against the real service, with the output pasted in the PR. Maintainers cannot run it for you, since CI holds no credentials for hosted services.
- A row in the README's Backends table and its variables under "Run it as a server".

### Smoke test

`npm run smoke` creates one real browser on the backend selected by the environment, checks that it answers over CDP, lists it, lists its files if the backend has file access, and releases it. It uses a five-minute timeout, so a run costs a few minutes of browser time at most.

```bash
NEU_BROWSER_BACKEND=nap \
NAP_BROWSER_URL=https://browser.example.com \
NAP_BROWSER_TOKEN=<token> \
npm run smoke
```

## Commit and PR conventions

- Write commit messages in **English**, present tense, with a concise summary line. We loosely follow [Conventional Commits](https://www.conventionalcommits.org/) prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`) — not enforced, but appreciated.
- Keep the history readable: squash noisy fix-up commits before requesting review when practical.
- Reference issues with `Fixes #123` / `Closes #123` so they auto-close on merge.

## License of contributions

This project is licensed under the [Apache License 2.0](LICENSE). By submitting a contribution, you agree that it is licensed under the same terms, and you certify that you have the right to submit it (per the Apache-2.0 inbound=outbound convention).
