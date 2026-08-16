import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import {
  CreateFloorRequestSchema,
  RemoveFloorRequestSchema,
  type Floor,
} from '@flashwork/shared-types';
import { WorktreeManager } from '@flashwork/worktree-manager';

import { getFloorsRoot } from '../floors/paths';

export const FLOORS_IPC = {
  create: 'floors:create',
  list: 'floors:list',
  remove: 'floors:remove',
} as const;

type FloorRecord = Floor & { worktreeId: string };

const floors = new Map<string, FloorRecord>();

function getManager(): WorktreeManager {
  return new WorktreeManager({
    repoRoot: process.cwd(),
    worktreesDir: getFloorsRoot(),
  });
}

export function registerFloorsIpc(): void {
  ipcMain.handle(FLOORS_IPC.create, async (_event, raw: unknown) => {
    const input = CreateFloorRequestSchema.parse(raw ?? {});
    const id = randomUUID();
    const name = input.name ?? `Floor ${floors.size + 1}`;
    const branch =
      input.branch ?? `floor/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id.slice(0, 6)}`;

    const manager = getManager();
    const worktree = await manager.create({
      branch,
      name: id.slice(0, 8),
      baseRef: input.baseRef,
    });

    const floor: FloorRecord = {
      id,
      name,
      worktreePath: worktree.path,
      branch: worktree.branch,
      createdAt: new Date().toISOString(),
      worktreeId: worktree.id,
    };
    floors.set(id, floor);

    const { worktreeId: _worktreeId, ...publicFloor } = floor;
    return publicFloor;
  });

  ipcMain.handle(FLOORS_IPC.list, () => {
    return [...floors.values()].map(({ worktreeId: _id, ...floor }) => floor);
  });

  ipcMain.handle(FLOORS_IPC.remove, async (_event, raw: unknown) => {
    const { floorId } = RemoveFloorRequestSchema.parse(raw);
    const floor = floors.get(floorId);
    if (!floor) {
      throw new Error(`Unknown floor: ${floorId}`);
    }

    const manager = getManager();
    await manager.remove(floor.worktreePath);
    floors.delete(floorId);
    return { ok: true as const };
  });
}

export function getFloorById(floorId: string): Floor | undefined {
  const record = floors.get(floorId);
  if (!record) return undefined;
  const { worktreeId: _id, ...floor } = record;
  return floor;
}
