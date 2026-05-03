import { BaseEdge, type EdgeProps } from '@xyflow/react'

/**
 * Tree-branch edge for the hierarchy view.
 *
 * Routes each parent → child link as a strict orthogonal three-segment path:
 *   parent.bottom → straight down to a "bus" line → over to child.x → down to child.top
 *
 * Because every child of a parent draws on top of the same short vertical
 * stub directly under that parent, the result reads as a clean fan-out
 * from the parent (org-chart / file-tree style).
 *
 * Subtrees are laid out side-by-side by `layoutTree` so a parent's bus is
 * always confined to its own subtree's x-range — there's no need to
 * stagger bus levels because two parents' buses can never overlap
 * horizontally in the first place.
 *
 * `data.parentColor` tints the edge & arrow head so children sharing a
 * parent are visibly grouped even when many siblings fan out.
 */
export interface HierarchyEdgeData {
  parentColor?: string
}

export default function HierarchyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerEnd,
  data
}: EdgeProps): JSX.Element {
  const d = (data ?? {}) as HierarchyEdgeData
  const parentColor = d.parentColor

  // Fixed stub: bus sits a short, predictable distance below the parent
  // regardless of how far the child is. All children of one parent then
  // visually share the same stub.
  const STUB = 22
  const dy = targetY - sourceY
  const stub = dy > 0 ? Math.min(STUB, Math.max(1, dy - 12)) : dy * 0.5
  const busY = sourceY + stub

  const R = 6 // soft corner radius
  const sameX = Math.abs(targetX - sourceX) < 0.5

  let path: string
  if (sameX) {
    path = `M ${sourceX},${sourceY} L ${targetX},${targetY}`
  } else {
    const dir = targetX > sourceX ? 1 : -1
    const c1x = sourceX + dir * R
    const c2x = targetX - dir * R
    path = [
      `M ${sourceX},${sourceY}`,
      `L ${sourceX},${busY - R}`,
      `Q ${sourceX},${busY} ${c1x},${busY}`,
      `L ${c2x},${busY}`,
      `Q ${targetX},${busY} ${targetX},${busY + R}`,
      `L ${targetX},${targetY}`
    ].join(' ')
  }

  const finalStyle = parentColor
    ? { stroke: parentColor, strokeWidth: 1.75, ...style }
    : style

  return <BaseEdge id={id} path={path} style={finalStyle} markerEnd={markerEnd} />
}

/** Stable colour pick from a small ergonomic palette, hashed by parent id. */
const PARENT_PALETTE = [
  '#1A73E8', // blue
  '#7B61FF', // purple
  '#0F9D58', // green
  '#F9AB00', // amber
  '#D93025', // red
  '#00A39E', // teal
  '#E8710A', // orange
  '#9334E6'  // violet
]

export function colorForParent(parentId: string | number): string {
  const id = String(parentId)
  let h = 0
  for (let i = 0; i < id.length; i += 1) {
    h = (h * 31 + id.charCodeAt(i)) >>> 0
  }
  return PARENT_PALETTE[h % PARENT_PALETTE.length]
}
