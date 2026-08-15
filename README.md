# Flashwork

Local-first Electron desktop canvas for AI agents (monorepo).

## Requirements

- Node.js 22+
- pnpm 9+

## Scripts

```bash
pnpm install
pnpm lint
pnpm test
pnpm build
pnpm --filter @flashwork/desktop dev
```

## Structure

- `apps/desktop` — Electron + React shell (`@flashwork/desktop`)
- `packages/shared-types` — shared TypeScript contracts (`@flashwork/shared-types`)
