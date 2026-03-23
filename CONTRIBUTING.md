# Contributing

## Prerequisites

- Node.js 20+
- pnpm

## Setup

```bash
git clone https://github.com/Go-Pomegranate/Truman.git
cd Truman
pnpm install
pnpm build
```

## Development

```bash
pnpm dev          # Run CLI in dev mode (tsx)
pnpm test         # Run tests (vitest)
pnpm typecheck    # TypeScript check
pnpm lint         # Biome lint
pnpm format       # Biome format
```

## Pull requests

- Use [conventional commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, etc.)
- Keep PRs small and focused
- Tests required for new features and bug fixes
- `pnpm lint && pnpm typecheck && pnpm test` must pass

## Code style

Biome handles formatting and linting. Run `pnpm format` before committing.

## Contributions and IP

By submitting a pull request you agree that your contribution is licensed
under the same MIT license as the project. Contributing does not grant any
rights to the ParentOS name, brand, products, or services.
