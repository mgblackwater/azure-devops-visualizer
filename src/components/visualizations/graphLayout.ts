import dagre from 'dagre'
import { Position, type Edge, type Node } from '@xyflow/react'

export type LayoutDirection = 'LR' | 'TB'

export interface LayoutOptions {
  direction?: LayoutDirection
  nodeWidth?: number
  nodeHeight?: number
  ranksep?: number
  nodesep?: number
  /**
   * Pairs of (parentId, childId) representing the parent-child relationships
   * dagre laid out vertically (LR) / horizontally (TB) as siblings. Provided
   * separately from `edges` so we can sort by hierarchy ignoring dependency
   * edges that share endpoints.
   */
  siblingGroups?: Array<[string, string]>
  /**
   * Sort key per node id (lower = appears first within its sibling group).
   * If omitted, dagre's default order is preserved.
   */
  siblingOrder?: Map<string, number>
}

const DEFAULT_NODE_WIDTH = 240
const DEFAULT_NODE_HEIGHT = 96

export function layoutGraph(
  nodes: Node[],
  edges: Edge[],
  options: LayoutOptions = {}
): { nodes: Node[]; edges: Edge[] } {
  const direction = options.direction ?? 'LR'
  const nodeWidth = options.nodeWidth ?? DEFAULT_NODE_WIDTH
  const nodeHeight = options.nodeHeight ?? DEFAULT_NODE_HEIGHT

  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir: direction,
    ranksep: options.ranksep ?? (direction === 'LR' ? 70 : 55),
    nodesep: options.nodesep ?? (direction === 'LR' ? 18 : 28),
    edgesep: 8,
    marginx: 16,
    marginy: 16
  })

  for (const node of nodes) {
    g.setNode(node.id, { width: nodeWidth, height: nodeHeight })
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target)
  }

  dagre.layout(g)

  // Post-layout sibling reorder.
  // dagre offers no per-rank sort hook, so we mutate the dagre node positions
  // before reading them. For each parent group we collect the slots dagre gave
  // to its children (along the sibling axis), sort those slots, and reassign
  // them to children in the order requested by `siblingOrder`. This preserves
  // dagre's spacing while honoring our priority.
  if (options.siblingGroups && options.siblingOrder && options.siblingGroups.length > 0) {
    const siblingAxis: 'x' | 'y' = direction === 'LR' ? 'y' : 'x'
    const parentToChildren = new Map<string, string[]>()
    for (const [parent, child] of options.siblingGroups) {
      if (!g.node(parent) || !g.node(child)) continue
      if (!parentToChildren.has(parent)) parentToChildren.set(parent, [])
      const arr = parentToChildren.get(parent)!
      if (!arr.includes(child)) arr.push(child)
    }
    const FALLBACK = Number.MAX_SAFE_INTEGER
    for (const [, children] of parentToChildren.entries()) {
      if (children.length < 2) continue
      const slots = children
        .map((id) => g.node(id)[siblingAxis])
        .sort((a, b) => a - b)
      const desired = [...children].sort((a, b) => {
        const av = options.siblingOrder!.get(a) ?? FALLBACK
        const bv = options.siblingOrder!.get(b) ?? FALLBACK
        if (av !== bv) return av - bv
        return Number(a) - Number(b)
      })
      for (let i = 0; i < desired.length; i += 1) {
        const node = g.node(desired[i])
        node[siblingAxis] = slots[i]
      }
    }
  }

  const positionedNodes: Node[] = nodes.map((node) => {
    const p = g.node(node.id)
    if (!p) return node
    return {
      ...node,
      position: {
        x: p.x - nodeWidth / 2,
        y: p.y - nodeHeight / 2
      },
      sourcePosition: direction === 'LR' ? Position.Right : Position.Bottom,
      targetPosition: direction === 'LR' ? Position.Left : Position.Top
    }
  })

  return { nodes: positionedNodes, edges }
}

/* ---------- subtree (Reingold-Tilford-ish) layout for hierarchies ---------- */

export interface TreeLayoutOptions {
  /** id → ordered list of child ids. Order is preserved exactly. */
  childrenOf: Map<string, string[]>
  /** Root ids in the left-to-right order they should appear. */
  roots: string[]
  nodeWidth?: number
  nodeHeight?: number
  /** Horizontal gap between sibling subtrees. */
  hSpacing?: number
  /** Vertical gap between hierarchy levels. */
  vSpacing?: number
  /** Extra horizontal gap inserted between adjacent root subtrees. */
  rootGap?: number
}

interface SubtreeMeasure {
  width: number
  /** x offset (relative to subtree left) for each child, in order. */
  childOffsets: number[]
}

/**
 * Pure-tree layout used by the hierarchy view.
 *
 * Properties (which dagre cannot guarantee):
 *  - Every child sits within its parent's subtree x-range. Subtrees from
 *    different parents are placed side-by-side and *never interleave*.
 *  - Sibling order is preserved exactly as supplied (`childrenOf`).
 *  - A parent is horizontally centred above its children's combined span.
 *
 * Returns absolute `{ x, y }` coordinates for the top-left of each node.
 * Items not reachable from `roots` are not positioned.
 */
export function layoutTree(
  options: TreeLayoutOptions
): Map<string, { x: number; y: number }> {
  const NW = options.nodeWidth ?? 240
  const NH = options.nodeHeight ?? 96
  const HSPACE = options.hSpacing ?? 24
  const VSPACE = options.vSpacing ?? 80
  const ROOT_GAP = options.rootGap ?? HSPACE * 2

  const measureCache = new Map<string, SubtreeMeasure>()

  /** Bottom-up: compute the width each subtree consumes and where each
   *  child sits relative to the subtree's left edge. */
  function measure(id: string): SubtreeMeasure {
    const cached = measureCache.get(id)
    if (cached) return cached

    const children = options.childrenOf.get(id) ?? []
    if (children.length === 0) {
      const r: SubtreeMeasure = { width: NW, childOffsets: [] }
      measureCache.set(id, r)
      return r
    }
    let cursor = 0
    const childOffsets: number[] = []
    for (let i = 0; i < children.length; i += 1) {
      const childMeasure = measure(children[i])
      childOffsets.push(cursor)
      cursor += childMeasure.width
      if (i < children.length - 1) cursor += HSPACE
    }
    // Subtree must be at least as wide as the parent node itself —
    // otherwise the parent visually overflows beyond the children.
    const r: SubtreeMeasure = {
      width: Math.max(NW, cursor),
      childOffsets
    }
    measureCache.set(id, r)
    return r
  }

  const positions = new Map<string, { x: number; y: number }>()
  const seen = new Set<string>()

  /** Top-down: emit absolute positions, centring the parent above its
   *  children's span and pushing each child into its measured slot. */
  function place(id: string, leftX: number, depth: number): void {
    if (seen.has(id)) return
    seen.add(id)
    const m = measure(id)
    const y = depth * (NH + VSPACE)
    const parentX = leftX + (m.width - NW) / 2
    positions.set(id, { x: parentX, y })

    const children = options.childrenOf.get(id) ?? []
    for (let i = 0; i < children.length; i += 1) {
      place(children[i], leftX + m.childOffsets[i], depth + 1)
    }
  }

  let cursor = 0
  for (const root of options.roots) {
    const m = measure(root)
    place(root, cursor, 0)
    cursor += m.width + ROOT_GAP
  }

  return positions
}
