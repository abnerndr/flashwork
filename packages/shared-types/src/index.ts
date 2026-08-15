import { z } from 'zod';

export const FloorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type Floor = z.infer<typeof FloorSchema>;

export const CanvasNodeKindSchema = z.enum([
  'terminal',
  'ide',
  'portal',
  'sticky',
  'routerStatus',
  'floorContainer',
]);
export type CanvasNodeKind = z.infer<typeof CanvasNodeKindSchema>;

export const CanvasNodeBaseSchema = z.object({
  id: z.string().min(1),
  floorId: z.string().nullable(),
  kind: CanvasNodeKindSchema,
  position: z.object({ x: z.number(), y: z.number() }),
});
export type CanvasNodeBase = z.infer<typeof CanvasNodeBaseSchema>;

export const TerminalNodeDataSchema = CanvasNodeBaseSchema.extend({
  kind: z.literal('terminal'),
  sessionId: z.string().optional(),
  command: z.string().optional(),
});
export type TerminalNodeData = z.infer<typeof TerminalNodeDataSchema>;

export const IdeNodeDataSchema = CanvasNodeBaseSchema.extend({
  kind: z.literal('ide'),
  url: z.string().url().optional(),
});
export type IdeNodeData = z.infer<typeof IdeNodeDataSchema>;

export const PortalNodeDataSchema = CanvasNodeBaseSchema.extend({
  kind: z.literal('portal'),
  url: z.string().url().optional(),
});
export type PortalNodeData = z.infer<typeof PortalNodeDataSchema>;

export const StickyNoteNodeDataSchema = CanvasNodeBaseSchema.extend({
  kind: z.literal('sticky'),
  content: z.string().default(''),
});
export type StickyNoteNodeData = z.infer<typeof StickyNoteNodeDataSchema>;

export const RouterStatusNodeDataSchema = CanvasNodeBaseSchema.extend({
  kind: z.literal('routerStatus'),
});
export type RouterStatusNodeData = z.infer<typeof RouterStatusNodeDataSchema>;

export const FloorContainerNodeDataSchema = CanvasNodeBaseSchema.extend({
  kind: z.literal('floorContainer'),
  floorId: z.string().min(1),
});
export type FloorContainerNodeData = z.infer<typeof FloorContainerNodeDataSchema>;

export const CanvasNodeSchema = z.discriminatedUnion('kind', [
  TerminalNodeDataSchema,
  IdeNodeDataSchema,
  PortalNodeDataSchema,
  StickyNoteNodeDataSchema,
  RouterStatusNodeDataSchema,
  FloorContainerNodeDataSchema,
]);
export type CanvasNode = z.infer<typeof CanvasNodeSchema>;

export const PTYMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('spawn'),
    sessionId: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional(),
    cols: z.number().int().positive().default(80),
    rows: z.number().int().positive().default(24),
    env: z.record(z.string()).optional(),
  }),
  z.object({
    type: z.literal('write'),
    sessionId: z.string().min(1),
    data: z.string(),
  }),
  z.object({
    type: z.literal('resize'),
    sessionId: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('kill'),
    sessionId: z.string().min(1),
  }),
  z.object({
    type: z.literal('data'),
    sessionId: z.string().min(1),
    data: z.string(),
  }),
  z.object({
    type: z.literal('exit'),
    sessionId: z.string().min(1),
    exitCode: z.number().int().nullable(),
  }),
]);
export type PTYMessage = z.infer<typeof PTYMessageSchema>;

export const RouterStatusSchema = z.object({
  provider: z.string().min(1),
  quotaRemaining: z.number().nullable().optional(),
  estimatedCost: z.number().nullable().optional(),
  fallbackActive: z.boolean(),
  fallbackProvider: z.string().nullable().optional(),
});
export type RouterStatus = z.infer<typeof RouterStatusSchema>;
