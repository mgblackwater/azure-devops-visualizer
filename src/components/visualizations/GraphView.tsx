import { useCallback, useMemo, useState } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeMouseHandler
} from '@xyflow/react'
import {
  Box,
  Chip,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  Typography,
  useTheme
} from '@mui/material'
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
import { layoutGraph, type LayoutDirection } from './graphLayout'
import EmptyState from './EmptyState'

const NODE_TYPES = { workItem: WorkItemNode }

interface GraphViewProps {
  /** 'LR' for dependency flow, 'TB' for hierarchy mind-map. */
  direction?: LayoutDirection
  /** When true, show only Hierarchy edges (used by HierarchyView). */
  hierarchyOnly?: boolean
}

const HIERARCHY_FORWARD = 'System.LinkTypes.Hierarchy-Forward'
const HIERARCHY_REVERSE = 'System.LinkTypes.Hierarchy-Reverse'
const DEPENDENCY_FORWARD = 'System.LinkTypes.Dependency-Forward'
const DEPENDENCY_REVERSE = 'System.LinkTypes.Dependency-Reverse'

export default function GraphView({
  direction = 'LR',
  hierarchyOnly = false
}: GraphViewProps): JSX.Element {
  const raw = useWorkItems()
  const { source, selectedWorkItemId, hiddenTypes } = useAppSelector((s) => s.workspace)
  const filtered = useMemo(() => applyTypeFilter(raw, hiddenTypes), [raw, hiddenTypes])
  const { items, byId, links, isLoading, isFetching, error } = filtered
  const dispatch = useAppDispatch()
  const muiTheme = useTheme()
  const isDark = muiTheme.palette.mode === 'dark'

  const [showHierarchy, setShowHierarchy] = useState(true)
  const [showDependency, setShowDependency] = useState(!hierarchyOnly)
  const [sortMode, setSortMode] = useState<SiblingSortMode>('stackRank')

  const childCountById = useMemo(() => {
    const m = new Map<number, number>()
    function bump(parent: number): void {
      m.set(parent, (m.get(parent) ?? 0) + 1)
    }
    for (const l of links) {
      if (!l.source || !l.target) continue
      if (l.rel === 'System.LinkTypes.Hierarchy-Forward') bump(l.source.id)
      else if (l.rel === 'System.LinkTypes.Hierarchy-Reverse') bump(l.target.id)
    }
    for (const w of items) {
      if (!w.relations) continue
      for (const r of w.relations) {
        const t = relationTargetId(r.url)
        if (!t) continue
        if (r.rel === 'System.LinkTypes.Hierarchy-Forward') bump(w.id)
        else if (r.rel === 'System.LinkTypes.Hierarchy-Reverse') bump(t)
      }
    }
    return m
  }, [items, links])

  const { nodes, edges, edgeStats, siblingGroups } = useMemo(() => {
    const nodes: Node[] = items.map((w) => ({
      id: String(w.id),
      type: 'workItem',
      position: { x: 0, y: 0 },
      data: {
        id: w.id,
        title: getTitle(w),
        type: getType(w),
        state: getState(w),
        assignee: getAssigneeName(w),
        priority: getPriority(w),
        childCount: childCountById.get(w.id) ?? 0,
        isFocused: selectedWorkItemId === w.id
      } satisfies WorkItemNodeData
    }))

    const edgeMap = new Map<string, Edge>()
    const siblingGroups: Array<[string, string]> = []
    let hierarchyCount = 0
    let dependencyCount = 0

    function addEdge(sourceId: number, targetId: number, kind: 'hierarchy' | 'dependency'): void {
      if (!byId.has(sourceId) || !byId.has(targetId)) return
      const id = `${kind}:${sourceId}->${targetId}`
      if (edgeMap.has(id)) return
      const isHierarchy = kind === 'hierarchy'
      // Pick palette pieces that read on either pane background. Dependency
      // accent uses our primary blue (which is already mode-aware in
      // theme.ts) and the label chip pulls from MUI's surface tokens so
      // it never ends up white-on-white or white-on-black.
      const dependencyAccent = muiTheme.palette.primary.main
      const hierarchyStroke = isDark ? '#6B7280' : '#9AA0A6'
      const labelBgFill = muiTheme.palette.background.paper
      const labelTextFill = isHierarchy
        ? muiTheme.palette.text.secondary
        : dependencyAccent
      edgeMap.set(id, {
        id,
        source: String(sourceId),
        target: String(targetId),
        type: 'smoothstep',
        animated: !isHierarchy,
        label: isHierarchy ? undefined : 'depends on',
        labelStyle: { fontSize: 10, fontWeight: 600, fill: labelTextFill },
        labelBgStyle: { fill: labelBgFill, fillOpacity: 0.9 },
        labelBgPadding: [3, 5],
        labelBgBorderRadius: 4,
        style: {
          stroke: isHierarchy ? hierarchyStroke : dependencyAccent,
          strokeWidth: isHierarchy ? 1.5 : 2
        },
        markerEnd: {
          type: 'arrowclosed' as const,
          color: isHierarchy ? hierarchyStroke : dependencyAccent
        }
      })
      if (isHierarchy) {
        hierarchyCount += 1
        siblingGroups.push([String(sourceId), String(targetId)])
      } else {
        dependencyCount += 1
      }
    }

    // 1. Edges learned from the WIQL link result.
    for (const l of links) {
      if (!l.rel || !l.source || !l.target) continue
      if (l.rel === HIERARCHY_FORWARD && showHierarchy) {
        addEdge(l.source.id, l.target.id, 'hierarchy')
      } else if (l.rel === HIERARCHY_REVERSE && showHierarchy) {
        addEdge(l.target.id, l.source.id, 'hierarchy')
      } else if (!hierarchyOnly && l.rel === DEPENDENCY_FORWARD && showDependency) {
        addEdge(l.source.id, l.target.id, 'dependency')
      } else if (!hierarchyOnly && l.rel === DEPENDENCY_REVERSE && showDependency) {
        addEdge(l.target.id, l.source.id, 'dependency')
      }
    }

    // 2. Edges learned from each item's own .relations[]. Available when the
    //    item was loaded with $expand=relations (from the drawer hydration).
    for (const w of items) {
      if (!w.relations) continue
      for (const r of w.relations) {
        const target = relationTargetId(r.url)
        if (!target) continue
        if (r.rel === HIERARCHY_FORWARD && showHierarchy) {
          addEdge(w.id, target, 'hierarchy')
        } else if (r.rel === HIERARCHY_REVERSE && showHierarchy) {
          addEdge(target, w.id, 'hierarchy')
        } else if (!hierarchyOnly && r.rel === DEPENDENCY_FORWARD && showDependency) {
          addEdge(w.id, target, 'dependency')
        } else if (!hierarchyOnly && r.rel === DEPENDENCY_REVERSE && showDependency) {
          addEdge(target, w.id, 'dependency')
        }
      }
    }

    const allEdges = [...edgeMap.values()]
    const siblingOrder =
      sortMode === 'default'
        ? undefined
        : new Map<string, number>(
            items.map((w) => [String(w.id), sortKey(w, sortMode)])
          )
    const positioned = layoutGraph(nodes, allEdges, {
      direction,
      siblingGroups,
      siblingOrder
    })
    return {
      nodes: positioned.nodes,
      edges: positioned.edges,
      edgeStats: { hierarchy: hierarchyCount, dependency: dependencyCount },
      siblingGroups
    }
  }, [
    items,
    links,
    byId,
    hierarchyOnly,
    showHierarchy,
    showDependency,
    direction,
    sortMode,
    selectedWorkItemId,
    childCountById,
    muiTheme,
    isDark
  ])

  const onNodeClick = useCallback<NodeMouseHandler>(
    (_event, node) => {
      const id = Number(node.id)
      if (Number.isFinite(id)) dispatch(selectWorkItem(id))
    },
    [dispatch]
  )

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
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={showHierarchy}
              onChange={(e) => setShowHierarchy(e.target.checked)}
            />
          }
          label="Hierarchy edges"
        />
        {!hierarchyOnly && (
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={showDependency}
                onChange={(e) => setShowDependency(e.target.checked)}
              />
            }
            label="Dependency edges"
          />
        )}
        <FormControl size="small" sx={{ minWidth: 200 }}>
          <InputLabel id="graph-sort">Sort siblings by</InputLabel>
          <Select
            labelId="graph-sort"
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
        <Chip size="small" label={`${nodes.length} nodes`} />
        <Chip
          size="small"
          variant="outlined"
          label={`${edgeStats.hierarchy} hierarchy`}
        />
        {!hierarchyOnly && (
          <Chip
            size="small"
            variant="outlined"
            label={`${edgeStats.dependency} dependency`}
          />
        )}
        {siblingGroups.length === 0 && (
          <Typography variant="caption" color="text.secondary">
            No hierarchy edges to sort by
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
          Tip: open items in the drawer to fetch their full relations.
        </Typography>
      </Stack>
      <Box sx={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <EmptyState
          hasSource={!!source}
          isLoading={isLoading}
          isFetching={isFetching}
          error={error}
          count={items.length}
        />
        {items.length > 0 && (
          <ReactFlowProvider>
            <ReactFlow
              className="graph-flow"
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              onNodeClick={onNodeClick}
              colorMode={muiTheme.palette.mode}
              fitView
              minZoom={0.1}
              nodesDraggable={false}
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
