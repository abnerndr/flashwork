import { join } from 'node:path';

let floorsRootOverride: string | null = null;

export function getFloorsRoot(): string {
  if (floorsRootOverride) return floorsRootOverride;
  if (process.env.FLASHWORK_FLOORS_ROOT) {
    return process.env.FLASHWORK_FLOORS_ROOT;
  }
  return join(process.cwd(), '.worktrees');
}

export function setFloorsRootForTests(root: string | null): void {
  floorsRootOverride = root;
}
