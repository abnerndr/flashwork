import type { Node, NodeProps } from '@xyflow/react';

import type { FloorContainerNodeData } from '../../state/canvasStore';

type FloorFlowNode = Node<FloorContainerNodeData, 'floorContainer'>;

export function FloorContainer({ data, selected }: NodeProps<FloorFlowNode>) {
  return (
    <div className={`floor-container ${selected ? 'is-selected' : ''}`}>
      <div className="floor-container__header">
        <strong>{data.name}</strong>
        <span className="floor-container__branch">{data.branch}</span>
      </div>
      <div className="floor-container__path" title={data.worktreePath}>
        {data.worktreePath}
      </div>
      <div className="floor-container__body" />
    </div>
  );
}
