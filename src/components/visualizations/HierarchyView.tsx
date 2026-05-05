import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeMouseHandler
} from '@xyflow/react'
import {
  Box,
  Button,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Tooltip,
  Typography,
  useTheme
} from '@mui/material'
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore'
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import { applyTypeFilter, useWorkItems } from '@/hooks/useWorkItems'
import { useAppDispatch, useAppSelector } from '@/store'
import { selectWorkItem } from '@/store/workspaceSlice'
import TypeFilter from './TypeFilter'
import {
  getAssigneeName,
  getPriority,
  getState,
  getTitle,
  getType,
  relationTargetId,
  sortKey,
  type SiblingSortMode
} from '@/utils/workItemFields'
import { WorkItemNode, type WorkItemNodeData } from './WorkItemNode'
import HierarchyEdge, { colorForParent } from './HierarchyEdge'
import { layoutTree } from './graphLayout'
import { Position } from '@xyflow/react'
import EmptyState from './EmptyState'

const NODE_TYPES = { workItem: WorkItemNode }
const EDGE_TYPES = { hierarchy: HierarchyEdge }
const HIERARCHY_FORWARD = 'System.LinkTypes.Hierarchy-Forward'
const HIERARCHY_REVERSE = 'System.LinkTypes.Hierarchy-Reverse'

interface ParentChildIndex {
  childrenOf: Map<number, Set<number>>
  parentOf: Map<number, number>
}

function buildIndex(
  itemIds: Set<number>,
  links: { rel: string | null; source: { id: number } | null; target: { id: number } | null }[],
  itemRelations: { id: number; relations: { rel: string; url: string }[] | undefined }[]
): ParentChildIndex {
  const childrenOf = new Map<number, Set<number>>()
  const parentOf = new Map<number, number>()

  function addEdge(parent: number, child: number): void {
    if (!itemIds.has(parent) || !itemIds.has(child)) return
    if (!childrenOf.has(parent)) childrenOf.set(parent, new Set())
    childrenOf.get(parent)!.add(child)
    parentOf.set(child, parent)
  }

  for (const l of links) {
    if (!l.source || !l.target) continue
    if (l.rel === HIERARCHY_FORWARD) addEdge(l.source.id, l.target.id)
    else if (l.rel === HIERARCHY_REVERSE) addEdge(l.target.id, l.source.id)
  }

  for (const w of itemRelations) {
    if (!w.relations) continue
    for (const r of w.relations) {
      const targetId = relationTargetId(r.url)
      if (!targetId) continue
      if (r.rel === HIERARCHY_FORWARD) addEdge(w.id, targetId)
      else if (r.rel === HIERARCHY_REVERSE) addEdge(targetId, w.id)
    }
  }

  return { childrenOf, parentOf }
}

export default function HierarchyView(): JSX.Element {
  const raw = useWorkItems()
  const { source, selectedWorkItemId, hiddenTypes } = useAppSelector((s) => s.workspace)
  const filtered = useMemo(() => applyTypeFilter(raw, hiddenTypes), [raw, hiddenTypes])
  const { items, links, isLoading, isFetching, error } = filtered
  const dispatch = useAppDispatch()
  const muiTheme = useTheme()
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [sortMode, setSortMode] = useState<SiblingSortMode>('stackRank')

  const index = useMemo(() => {
    const ids = new Set(items.map((w) => w.id))
    return buildIndex(
      ids,
      links,
      items.map((w) => ({ id: w.id, relations: w.relations }))
    )
  }, [items, links])

  const visibleIds = useMemo(() => {
    const visible = new Set<number>()
    const roots = items
      .map((w) => w.id)
      .filter((id) => !index.parentOf.has(id) || !items.some((w) => w.id === index.parentOf.get(id)))

    function walk(id: number): void {
      if (visible.has(id)) return
      visible.add(id)
      if (collapsed.has(id)) return
      const children = index.childrenOf.get(id)
      if (!children) return
      for (const c of children) walk(c)
    }

    for (const root of roots) walk(root)
    // Items whose parent isn't in the data still appear as orphan roots.
    for (const w of items) walk(w.id)
    return visible
  }, [items, index, collapsed])

  const layout = useMemo(() => {
    const itemById = new Map(items.map((w) => [w.id, w]))
    const NODE_WIDTH = 240
    const NODE_HEIGHT = 96

    // Comparator that respects the active sort mode. Falls back to
    // numeric id so the order is deterministic across renders even when
    // sortKeys collide (e.g. unset stack rank).
    function cmp(a: number, b: number): number {
      if (sortMode === 'default') return a - b
      const wa = itemById.get(a)
      const wb = itemById.get(b)
      if (!wa || !wb) return a - b
      const ka = sortKey(wa, sortMode)
      const kb = sortKey(wb, sortMode)
      if (ka !== kb) return ka - kb
      return a - b
    }

    /**
     * Build the ordered child map the layout consumes. Children that are
     * collapsed or invisible are omitted, and siblings are sorted by the
     * active sort mode *within each parent* — never globally — so the
     * tree-layout's subtree boundaries stay intact.
     */
    const orderedChildrenOf = new Map<string, string[]>()
    for (const [parent, children] of index.childrenOf.entries()) {
      if (!visibleIds.has(parent)) continue
      if (collapsed.has(parent)) continue
      const visibleChildren = [...children]
        .filter((c) => visibleIds.has(c))
        .sort(cmp)
      orderedChildrenOf.set(
        String(parent),
        visibleChildren.map(String)
      )
    }

    // Roots = visible items whose parent isn't visible (or doesn't exist).
    // Sorted by the active sort mode so ROOT order is also user-controlled,
    // not whatever traversal order the index happened to produce.
    const roots = items
      .filter((w) => visibleIds.has(w.id))
      .filter((w) => {
        const p = index.parentOf.get(w.id)
        return p === undefined || !visibleIds.has(p)
      })
      .map((w) => w.id)
      .sort(cmp)
      .map(String)

    const positions = layoutTree({
      childrenOf: orderedChildrenOf,
      roots,
      nodeWidth: NODE_WIDTH,
      nodeHeight: NODE_HEIGHT,
      hSpacing: 24,
      vSpacing: 90,
      rootGap: 60
    })

    const positionedNodes: Node[] = []
    for (const id of visibleIds) {
      const w = itemById.get(id)
      if (!w) continue
      const pos = positions.get(String(id))
      if (!pos) continue
      const childCount = index.childrenOf.get(id)?.size ?? 0
      positionedNodes.push({
        id: String(id),
        type: 'workItem',
        position: pos,
        // Tell React Flow which side of the node each handle is on so
        // edges originate from / arrive at the correct handle when we
        // route them ourselves.
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        data: {
          id: w.id,
          title: getTitle(w),
          type: getType(w),
          state: getState(w),
          assignee: getAssigneeName(w),
          priority: getPriority(w),
          childCount,
          collapsed: collapsed.has(id),
          // `isFocused` is intentionally OMITTED from the structural layout
          // — it changes on every drawer open, and re-running the layout
          // (and re-syncing local state) would wipe out manual drag edits.
          // A separate effect below mutates only this field on the live
          // node list when `selectedWorkItemId` changes.
          isFocused: false
        } satisfies WorkItemNodeData
      })
    }

    const finalEdges: Edge[] = []
    for (const [parent, children] of orderedChildrenOf.entries()) {
      const parentColor = colorForParent(parent)
      for (const child of children) {
        finalEdges.push({
          id: `h:${parent}->${child}`,
          source: parent,
          target: child,
          type: 'hierarchy',
          data: { parentColor },
          style: { stroke: parentColor, strokeWidth: 1.75 },
          markerEnd: { type: 'arrowclosed' as const, color: parentColor }
        })
      }
    }

    return { nodes: positionedNodes, edges: finalEdges }
    // selectedWorkItemId deliberately excluded — see isFocused note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, index, visibleIds, collapsed, sortMode])

  /* ---------- draggable + manual layout overrides ---------- */

  // React Flow tracks drag-induced position updates internally; we mirror
  // them into local state so the dragged positions stick across re-renders.
  // Whenever the upstream layout changes (sort / collapse / new items) we
  // re-sync from `layout` and clear the manual-edits flag.
  const [nodes, setNodes, onNodesChangeRF] = useNodesState<Node>(layout.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(layout.edges)
  const [hasManualEdits, setHasManualEdits] = useState(false)

  useEffect(() => {
    setNodes(layout.nodes)
    setEdges(layout.edges)
    setHasManualEdits(false)
  }, [layout, setNodes, setEdges])

  // Update *only* the focused-node highlight when selection changes —
  // keeping positions (and any in-progress manual rearrangement) intact.
  useEffect(() => {
    setNodes((current) =>
      current.map((n) => {
        const isFocused = Number(n.id) === selectedWorkItemId
        const prev = (n.data as WorkItemNodeData).isFocused
        if (prev === isFocused) return n
        return { ...n, data: { ...(n.data as WorkItemNodeData), isFocused } }
      })
    )
  }, [selectedWorkItemId, setNodes])

  /** Wrap RF's change handler so we can flag manual position edits. */
  const onNodesChange = useCallback<typeof onNodesChangeRF>(
    (changes) => {
      // A drag in flight emits a stream of position changes with
      // `dragging: true`; the final commit comes through with `dragging: false`.
      // We only flag on the *final* commit so a click that doesn't actually
      // move the node doesn't dirty the layout.
      const dragged = changes.some(
        (c) => c.type === 'position' && c.dragging === false
      )
      if (dragged) setHasManualEdits(true)
      onNodesChangeRF(changes)
    },
    [onNodesChangeRF]
  )

  const resetLayout = useCallback(() => {
    setNodes(layout.nodes)
    setEdges(layout.edges)
    setHasManualEdits(false)
  }, [layout, setNodes, setEdges])

  const onNodeClick = useCallback<NodeMouseHandler>(
    (event, node) => {
      const id = Number(node.id)
      if (!Number.isFinite(id)) return
      if (event.altKey || event.metaKey) {
        // Alt/Cmd-click toggles collapse for this node.
        setCollapsed((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
        return
      }
      dispatch(selectWorkItem(id))
    },
    [dispatch]
  )

  const expandAll = (): void => setCollapsed(new Set())
  const collapseAll = (): void => {
    const all = new Set<number>()
    for (const id of index.childrenOf.keys()) all.add(id)
    setCollapsed(all)
  }

  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
      <Stack
        direction="row"
        spacing={1.5}
        alignItems="center"
        sx={{
          p: 1.5,
          borderBottom: '1px solid',
          borderColor: 'divider',
          flexWrap: 'wrap',
          rowGap: 1
        }}
      >
        <Button
          size="small"
          variant="outlined"
          startIcon={<UnfoldLessIcon />}
          onClick={collapseAll}
        >
          Collapse all
        </Button>
        <Button
          size="small"
          variant="outlined"
          startIcon={<UnfoldMoreIcon />}
          onClick={expandAll}
        >
          Expand all
        </Button>
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel id="hierarchy-sort">Sort siblings by</InputLabel>
          <Select
            labelId="hierarchy-sort"
            label="Sort siblings by"
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SiblingSortMode)}
          >
            <MenuItem value="stackRank">Stack rank (backlog order)</MenuItem>
            <MenuItem value="priority">Priority (1-4)</MenuItem>
            <MenuItem value="title">Title (A-Z)</MenuItem>
            <MenuItem value="id">ID</MenuItem>
            <MenuItem value="startDate">Start date</MenuItem>
            <MenuItem value="targetDate">Target date</MenuItem>
            <MenuItem value="default">Default (dagre)</MenuItem>
          </Select>
        </FormControl>
        <TypeFilter items={raw.items} compact />
        {hasManualEdits && (
          <Tooltip title="Restore the auto-computed tree layout (does not change priority or links)">
            <Button
              size="small"
              variant="outlined"
              color="warning"
              startIcon={<RestartAltIcon />}
              onClick={resetLayout}
            >
              Reset layout
            </Button>
          </Tooltip>
        )}
        <Chip size="small" label={`${visibleIds.size}/${items.length} visible`} />
        <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
          Drag nodes to rearrange · click to inspect · Alt-click to collapse
        </Typography>
      </Stack>
      <Box sx={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <EmptyState
          hasSource={!!source}
          isLoading={isLoading}
          isFetching={isFetching}
          error={error}
          count={items.length}
          emptyHint="Use a tree WIQL (e.g. Features and child items) to populate the hierarchy."
        />
        {items.length > 0 && (
          <ReactFlowProvider>
            <ReactFlow
              className="hierarchy-flow"
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              onNodeClick={onNodeClick}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              // Drives ReactFlow's own theming: pane background, controls,
              // minimap, edge defaults. Pair with the CSS overrides so our
              // custom node looks right too.
              colorMode={muiTheme.palette.mode}
              fitView
              minZoom={0.1}
              // Manual rearrangement is purely cosmetic — it never changes
              // priority, parent links, or anything that hits ADO. The
              // "Reset layout" toolbar button restores the auto-computed
              // positions whenever the user wants to start over.
              nodesDraggable
              nodesConnectable={false}
              elementsSelectable
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={16} />
              <MiniMap pannable zoomable />
              <Controls />
            </ReactFlow>
          </ReactFlowProvider>
        )}
      </Box>
    </Box>
  )
}
