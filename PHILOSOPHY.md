# Philosophy

## Your tests are lying to you

E2E tests follow scripts. Real users don't.

A test clicks "Add to cart" because you told it to. A real user hesitates, gets distracted, comes back tomorrow, forgets their password, tries on mobile, gives up, tries again on desktop, and then clicks "Add to cart" — if you're lucky.

**Truman doesn't test your app. Truman lives in it.**

## Principles

**Personas > scripts.**
A frustrated teenager and a methodical parent use the same button differently. The teenager rage-taps. The parent reads the label first. Both find different bugs. Your test suite finds neither.

**State > isolation.**
Real users have history. They remember yesterday's broken checkout. They avoid features that failed last time. They build frustration over sessions, not just actions. Truman remembers too.

**Schedules > on-demand.**
Nobody opens your app at `test:start`. Anna checks it at 7am with coffee. Tomek checks at 5:30pm after work. Kasia checks after school — if she feels like it. Timing reveals bugs that "run all tests" never will.

**Frustration > assertions.**
`expect(status).toBe(200)` tells you the server responded. It tells you nothing about whether the user wanted to throw their phone. Truman tracks frustration. When it hits 0.85, the persona walks away — just like a real user.

**Families > users.**
Users don't exist in isolation. Dad creates a task, mom sees it, teen ignores it, kid can't read it. Truman simulates relationships, not just individuals.

## What Truman is not

- Not a load testing tool (use k6)
- Not a scripted E2E framework (use Playwright)
- Not a monitoring agent (use Datadog)

Truman is the closest thing to putting a real family in front of your app without actually doing it.

## The name

[The Truman Show](https://en.wikipedia.org/wiki/The_Truman_Show) — a man whose entire life is a simulation. He doesn't know it. Your app's synthetic users don't know it either. They just live their lives, use your app, and report back what sucked.
