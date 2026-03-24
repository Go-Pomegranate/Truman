#!/usr/bin/env bash
# Run this after `gh auth login` to set up GitHub repo metadata and issues.
# Usage: bash docs/launch/github-setup.sh

set -euo pipefail

REPO="Go-Pomegranate/Truman"

echo "==> Setting repo description..."
gh repo edit "$REPO" \
  --description "Synthetic users that get frustrated, rage-quit, and file bug reports. AI-powered UX chaos testing."

echo "==> Setting repo topics..."
gh repo edit "$REPO" \
  --add-topic ai \
  --add-topic testing \
  --add-topic ux \
  --add-topic synthetic-users \
  --add-topic developer-tools \
  --add-topic llm \
  --add-topic openai \
  --add-topic anthropic \
  --add-topic npc \
  --add-topic simulation \
  --add-topic quality-assurance \
  --add-topic user-testing \
  --add-topic typescript \
  --add-topic cli

echo "==> Creating 'good first issue' label (if missing)..."
gh label create "good first issue" --repo "$REPO" \
  --description "Good for newcomers" --color 7057ff 2>/dev/null || true

echo "==> Creating good-first-issues..."

gh issue create --repo "$REPO" \
  --title "Add persona pack: e-commerce power user" \
  --label "good first issue,enhancement" \
  --body "$(cat <<'EOF'
## What

Create a persona YAML file for an e-commerce power user — someone who:
- Compares prices obsessively
- Opens 15 tabs of the same product
- Adds/removes items from cart repeatedly
- Hunts for coupon codes before checkout
- Abandons cart if shipping isn't free

## Where

Add to `examples/families/` as `shopaholic.yaml`

## Why

This persona pack helps test e-commerce apps with realistic user behavior that scripted tests never capture.

## Getting started

Look at existing family files in `examples/families/` for the YAML format. The [README personas](../../README.md#meet-your-worst-users) show the style we're going for — funny comments, realistic quirks.
EOF
)"

gh issue create --repo "$REPO" \
  --title "Add persona pack: accessibility / screen reader user" \
  --label "good first issue,enhancement" \
  --body "$(cat <<'EOF'
## What

Create a persona YAML file for a screen reader user — someone who:
- Navigates entirely via keyboard (Tab, Enter, Escape)
- Relies on ARIA labels and semantic HTML
- Gets frustrated when focus traps break
- Can't see images without alt text
- Needs clear heading hierarchy

## Where

Add to `examples/families/` as `accessibility.yaml`

## Why

Accessibility testing is critical but often skipped. A synthetic screen reader user would surface issues that visual testing misses entirely.
EOF
)"

gh issue create --repo "$REPO" \
  --title "Support Postman collection import as adapter" \
  --label "good first issue,enhancement" \
  --body "$(cat <<'EOF'
## What

Add the ability to import a Postman collection JSON file and auto-generate an `adapter.json` from it. Many teams already have Postman collections documenting their APIs.

## How

- Parse Postman collection v2.1 format
- Extract endpoints, methods, headers, and example bodies
- Generate a compatible `adapter.json`
- Could be a new CLI command: `truman import-postman collection.json`

## Where

New file in `src/adapters/` or as a CLI subcommand.
EOF
)"

gh issue create --repo "$REPO" \
  --title "Add --json flag to report command" \
  --label "good first issue,enhancement" \
  --body "$(cat <<'EOF'
## What

Add a `--json` flag to `truman report` that outputs the report as structured JSON instead of the human-readable format.

## Why

Makes it easy to pipe Truman reports into other tools, dashboards, CI checks, or bug trackers.

## Expected output

```json
{
  "personas": [
    {
      "name": "Jaden",
      "frustrated": true,
      "frustration": 0.92,
      "actions": 12,
      "bugs_found": [],
      "quit_reason": "Page load exceeded patience threshold"
    }
  ],
  "summary": {
    "total_personas": 4,
    "frustrated": 3,
    "bugs_found": 2
  }
}
```
EOF
)"

gh issue create --repo "$REPO" \
  --title "Create a persona gallery page in docs" \
  --label "good first issue,documentation" \
  --body "$(cat <<'EOF'
## What

Create a `docs/persona-gallery.md` that showcases all available persona packs with previews, descriptions, and use cases.

## Format

For each persona pack:
- Name and one-liner description
- The YAML snippet (keep it fun/readable)
- What kind of app it's best for testing
- Example output / what bugs it tends to find

## Why

Makes it easy for new users to browse and pick personas. Also makes contributing new personas more visible and rewarding.
EOF
)"

gh issue create --repo "$REPO" \
  --title "Make frustration threshold configurable per persona" \
  --label "good first issue,enhancement" \
  --body "$(cat <<'EOF'
## What

Currently the frustration threshold (0.85) is global. Some personas should have different thresholds:
- An impatient Gen Z user might quit at 0.6
- A determined QA engineer might push through to 0.95

## How

Add an optional `frustrationThreshold` field to the persona YAML schema:

```yaml
- name: Jaden
  patience: 1
  frustrationThreshold: 0.6  # quits early
```

Default stays at 0.85 if not specified.

## Where

- Schema: `schemas/`
- Engine: `src/agent/DecisionEngine.ts` (where frustration is checked)
- Types: `src/types.ts`
EOF
)"

gh issue create --repo "$REPO" \
  --title "Add GraphQL adapter support" \
  --label "good first issue,enhancement" \
  --body "$(cat <<'EOF'
## What

Currently adapters work with REST/HTTP APIs. Add support for GraphQL APIs so synthetic users can:
- Discover available queries/mutations from introspection
- Execute GraphQL operations instead of REST calls
- Handle GraphQL-specific error patterns

## How

- New adapter type in `src/adapters/`
- Accept a GraphQL endpoint URL + optional introspection query
- Map discovered operations to actions the LLM can choose from

## Why

Tons of modern apps use GraphQL. This opens Truman up to a much larger audience.
EOF
)"

echo ""
echo "Done! Repo description, topics, and 7 good-first-issues created."
echo "View them: gh issue list --repo $REPO --label 'good first issue'"
