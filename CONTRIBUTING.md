# Contributing to Truman

Want to help build the worst users on the internet? Let's go.

Truman is an open-source project that creates AI-powered synthetic users who get frustrated and rage-quit your app. Every contribution — whether it's a terrifying new persona, a cleaner CLI flag, or a typo fix — makes the simulation more brutally realistic.

## What we need help with

Here's where you can make the biggest impact right now:

- **Persona packs** — funny, realistic, niche user archetypes (see below)
- **Adapter patterns** — Postman collection import, GraphQL introspection, gRPC support
- **CLI improvements** — better output formatting, new flags, interactive mode polish
- **Ollama model testing** — try different local models, report what works and what hallucinates
- **Documentation** — tutorials, examples, guides for specific frameworks
- **Bug fixes** — something broke? Even better, fix it and tell us how

## Good first issues

New here? We tag beginner-friendly issues so you can jump in without reading the entire codebase:

**[Good first issues](https://github.com/Go-Pomegranate/Truman/labels/good%20first%20issue)**

Pick one, comment that you're on it, and ship it. No approval needed to start.

## Persona packs

The single easiest way to contribute. Persona YAML files define the synthetic users that Truman drops into your app — their personality, patience level, quirks, and frustration triggers.

Got a user archetype that would break things in a funny or useful way? Write a YAML file and open a PR. Examples of personas we'd love to see:

- The product manager who only tests the happy path
- The accessibility-first user who tabs through everything
- The teenager who tries to break every input field with emoji
- The enterprise buyer who needs to "loop in stakeholders" before clicking anything

Look at the existing files in `families/` for the format. Keep personas vivid and specific — the LLM does better work when the personality is sharp.

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

Biome handles formatting and linting. Run `pnpm format` before committing and you're good.

## Contributions and IP

By submitting a pull request you agree that your contribution is licensed under the same MIT license as the project. Contributing does not grant any rights to the ParentOS name, brand, products, or services.

---

Questions? Open an issue. We don't bite — but our synthetic users might.
