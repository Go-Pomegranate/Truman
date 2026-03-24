# Show HN: Truman – Synthetic users that get frustrated and rage-quit your app

E2E tests follow scripts. Real users don't. They get confused, impatient, and leave. We built Truman to simulate that.

Truman is an open-source tool that creates AI-powered synthetic users (we call them NPCs) that browse your app, get frustrated, and quit — just like real users. You describe personas in YAML and an LLM decides what they'd actually do next.

Here's what a persona looks like:

```yaml
# 89-year-old grandmother. Will absolutely break your app.
- name: Abuela Carmen
  patience: 5
  techSavviness: 1
  persona: "Doesn't know what she tapped. Doesn't care. Somehow ended up on the admin panel."
  quirks: ["Double-taps everything", "Holds buttons like a TV remote"]
```

The LLM drives each NPC through your app step by step, maintaining a frustration score. When frustration crosses 0.85, they leave. You get a report showing what worked and exactly what made them quit.

Key details:

- **Persona-driven**: personality, patience, and quirks are all configurable in YAML
- **Frustration modeling**: frustration > 0.85 = they're gone
- **Stateful memory**: NPCs remember previous sessions
- **Multi-provider**: OpenAI, Anthropic, or Ollama (completely free and local)
- **Works with any HTTP API** via a simple adapter pattern
- **One command to try it**: `npx @parentos/truman roast` gives you 3 brutal personas and a bug report
- **MIT licensed**, written in TypeScript

We built this because we kept shipping features that passed every test but still confused real people. Truman doesn't replace E2E tests — it fills the gap between "all tests pass" and "why did 40% of users drop off on step 3."

Runs locally with Ollama if you don't want to send anything to an API. No accounts, no telemetry.

GitHub: https://github.com/Go-Pomegranate/Truman
