# TodoMVC Example

## Run

**Terminal 1** — start the API:
```bash
cd examples/todomvc
pnpm install
pnpm dev
```

**Terminal 2** — run Truman:
```bash
npx @parentos/truman run \
  -f examples/todomvc/families/smiths.yaml \
  -a examples/todomvc/adapter.json \
  --once
```

## What happens

The Smiths family interacts with your todo API:
- **Sarah** creates organized lists and completes them methodically
- **Mike** speedruns tasks with 2-word descriptions
- **Emma** checks reluctantly and quits at first friction
