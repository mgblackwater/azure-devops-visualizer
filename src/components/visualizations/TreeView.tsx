import { useMemo, useState } from 'react'
import {
  Box,
  Button,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import UnfoldMoreIcon from '@mui/icons-material/UnfoldMore'
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import { applyTypeFilter, useWorkItems } from '@/hooks/useWorkItems'
import { useAppDispatch, useAppSelector } from '@/store'
import { selectWorkItem } from '@/store/workspaceSlice'
import TypeFilter from './TypeFilter'
import {
  getAssigneeName,
  getState,
  getTitle,
  getType,
  relationTargetId,
  sortKey,
  typeBadge,
  type SiblingSortMode
} from '@/utils/workItemFields'
import { colorForState, colorForType, readableTextColor } from '@/utils/adoColors'
import EmptyState from './EmptyState'
import type { AdoWorkItem } from '@shared/adoTypes'

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

interface TreeRow {
  id: number
  depth: number
  hasChildren: boolean
  expanded: boolean
}

function initials(name: string): string {
  if (!name || name === 'Unassigned') return '—'
  const parts = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '—'
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase()
}

/**
 * Indented tree view of the workspace items — file-explorer style.
 *
 * Compared to the diagrammatic Hierarchy view, this is purely a vertical
 * outline: every item is a row, depth is encoded as left indent, and a
 * chevron toggles expansion. There are no arrows to follow, so even very
 * wide hierarchies (a Feature with 20 PBIs) read cleanly.
 *
 * Sort mode is applied *within each parent's children* — never globally —
 * so subtree boundaries stay intact.
 */
export default function TreeView(): JSX.Element {
  const raw = useWorkItems()
  const { source, selectedWorkItemId, hiddenTypes } = useAppSelector((s) => s.workspace)
  const filtered = useMemo(() => applyTypeFilter(raw, hiddenTypes), [raw, hiddenTypes])
  const { items, links, isLoading, isFetching, error } = filtered
  const dispatch = useAppDispatch()

  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [sortMode, setSortMode] = useState<SiblingSortMode>('stackRank')
  const [search, setSearch] = useState('')

  const itemById = useMemo(() => new Map(items.map((w) => [w.id, w])), [items])

  const index = useMemo(() => {
    const ids = new Set(items.map((w) => w.id))
    return buildIndex(
      ids,
      links,
      items.map((w) => ({ id: w.id, relations: w.relations }))
    )
  }, [items, links])

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

  /** Build the flat row list in display order via DFS, respecting
   *  collapsed state. */
  const rows = useMemo<TreeRow[]>(() => {
    const out: TreeRow[] = []
    const seen = new Set<number>()

    const roots = items
      .map((w) => w.id)
      .filter((id) => {
        const p = index.parentOf.get(id)
        return p === undefined || !itemById.has(p)
      })
      .sort(cmp)

    /**
     * Mark every descendant of `id` as seen *without* emitting a row.
     * Called when a parent is collapsed so the orphan-fallback below
     * doesn't treat the hidden children as top-level items and re-emit
     * them at depth 0 (which was the symptom of "collapse does nothing").
     */
    function markSubtreeSeen(id: number): void {
      if (seen.has(id)) return
      seen.add(id)
      const children = index.childrenOf.get(id)
      if (!children) return
      for (const c of children) markSubtreeSeen(c)
    }

    function walk(id: number, depth: number): void {
      if (seen.has(id)) return
      seen.add(id)
      const children = index.childrenOf.get(id)
      const hasChildren = !!children && children.size > 0
      const expanded = hasChildren && !collapsed.has(id)
      out.push({ id, depth, hasChildren, expanded })
      if (!expanded) {
        // Hide descendants — but claim them as visited so the orphan
        // loop further down doesn't promote them to root rows.
        if (children) for (const c of children) markSubtreeSeen(c)
        return
      }
      const ordered = [...(children ?? [])].sort(cmp)
      for (const c of ordered) walk(c, depth + 1)
    }

    for (const r of roots) walk(r, 0)
    // Truly disconnected items (cycle participants, items whose parent
    // sits outside the workspace query) still surface as orphan roots
    // so the user can reach them.
    for (const w of items) {
      if (!seen.has(w.id)) walk(w.id, 0)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, index, collapsed, sortMode, itemById])

  /** Apply the search filter without breaking subtree structure: a row
   *  is shown if it matches OR any of its descendants matches. */
  const visibleRows = useMemo<TreeRow[]>(() => {
    const term = search.trim().toLowerCase()
    if (!term) return rows

    function matches(w: AdoWorkItem): boolean {
      if (String(w.id) === term) return true
      const t = getTitle(w).toLowerCase()
      const ty = getType(w).toLowerCase()
      const a = getAssigneeName(w).toLowerCase()
      return t.includes(term) || ty.includes(term) || a.includes(term)
    }

    // Build the "matched ancestors" set: any matching item plus every
    // ancestor up the chain.
    const visible = new Set<number>()
    for (const w of items) {
      if (!matches(w)) continue
      visible.add(w.id)
      let cur: number | undefined = index.parentOf.get(w.id)
      while (cur !== undefined && !visible.has(cur)) {
        visible.add(cur)
        cur = index.parentOf.get(cur)
      }
    }

    return rows.filter((r) => visible.has(r.id))
  }, [rows, items, index, search])

  function toggleCollapse(id: number): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        // Expanding a parent only reveals its *immediate* children;
        // grandchildren stay hidden until the user expands their direct
        // parent themselves. This matches how OS file explorers behave
        // and avoids "expand a Feature, get a wall of every Task three
        // levels deep" surprises.
        next.delete(id)
      } else {
        // Collapsing a parent also collapses every descendant that has
        // children of its own, so that when the user later re-expands
        // this node the deeper levels start fresh (collapsed).
        next.add(id)
        const stack = [...(index.childrenOf.get(id) ?? [])]
        while (stack.length > 0) {
          const cur = stack.pop()!
          const kids = index.childrenOf.get(cur)
          if (!kids || kids.size === 0) continue
          next.add(cur)
          for (const k of kids) stack.push(k)
        }
      }
      return next
    })
  }

  function expandAll(): void {
    setCollapsed(new Set())
  }
  function collapseAll(): void {
    const all = new Set<number>()
    for (const id of index.childrenOf.keys()) all.add(id)
    setCollapsed(all)
  }

  return (
    <Box
      sx={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}
    >
      <Stack
        direction="row"
        spacing={1.5}
        alignItems="center"
        useFlexGap
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
          <InputLabel id="tree-sort">Sort siblings by</InputLabel>
          <Select
            labelId="tree-sort"
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
            <MenuItem value="default">Default (load order)</MenuItem>
          </Select>
        </FormControl>
        <TextField
          size="small"
          placeholder="Filter by id / title / owner…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ minWidth: 240, flex: '1 1 240px', maxWidth: 360 }}
        />
        <TypeFilter items={raw.items} compact />
        <Chip size="small" label={`${visibleRows.length}/${items.length} rows`} />
        <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
          Click a row to inspect · click the arrow to expand / collapse
        </Typography>
      </Stack>
      <Box sx={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'auto' }}>
        <EmptyState
          hasSource={!!source}
          isLoading={isLoading}
          isFetching={isFetching}
          error={error}
          count={items.length}
          emptyHint="Use a tree WIQL (e.g. Features and child items) to populate the tree."
        />
        {items.length > 0 && (
          <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
            {visibleRows.map((row) => {
              const w = itemById.get(row.id)
              if (!w) return null
              const focused = selectedWorkItemId === row.id
              return (
                <TreeRowView
                  key={row.id}
                  row={row}
                  item={w}
                  focused={focused}
                  onToggle={() => toggleCollapse(row.id)}
                  onOpen={() => dispatch(selectWorkItem(row.id))}
                />
              )
            })}
          </Box>
        )}
      </Box>
    </Box>
  )
}

function TreeRowView({
  row,
  item,
  focused,
  onToggle,
  onOpen
}: {
  row: TreeRow
  item: AdoWorkItem
  focused: boolean
  onToggle: () => void
  onOpen: () => void
}): JSX.Element {
  const title = getTitle(item)
  const state = getState(item)
  const type = getType(item)
  const owner = getAssigneeName(item)
  const typeColor = colorForType(type)
  const stateColor = colorForState(state)
  // Indent step large enough that the relationship reads at a glance, but
  // not so large that 5+ levels run off the right edge of the viewport.
  const INDENT_PX = 22

  return (
    <Box
      component="li"
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        px: 1,
        py: 0.5,
        pl: `${row.depth * INDENT_PX + 8}px`,
        borderBottom: '1px solid',
        borderColor: 'divider',
        // Focused row uses the primary blue at low alpha so it reads on
        // both light (FAFAFA-ish) and dark (#161A22-ish) surfaces.
        bgcolor: focused ? 'rgba(26,115,232,0.16)' : 'transparent',
        cursor: 'pointer',
        '&:hover': {
          bgcolor: focused ? 'rgba(26,115,232,0.22)' : 'action.hover'
        }
      }}
      onClick={onOpen}
    >
      {/* Expander chevron — keeps a consistent slot even for leaves so
          all rows of the same depth align vertically. */}
      <Box
        onClick={(e) => {
          e.stopPropagation()
          if (row.hasChildren) onToggle()
        }}
        sx={{
          width: 22,
          height: 22,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 0.5,
          color: 'text.secondary',
          cursor: row.hasChildren ? 'pointer' : 'default',
          opacity: row.hasChildren ? 1 : 0,
          '&:hover': row.hasChildren ? { bgcolor: 'action.hover' } : undefined
        }}
        aria-label={row.expanded ? 'Collapse' : 'Expand'}
      >
        {row.expanded ? (
          <ExpandMoreIcon fontSize="small" />
        ) : (
          <ChevronRightIcon fontSize="small" />
        )}
      </Box>
      <Chip
        size="small"
        label={typeBadge(type)}
        sx={{
          height: 18,
          flexShrink: 0,
          bgcolor: typeColor,
          color: readableTextColor(typeColor),
          fontWeight: 700,
          '& .MuiChip-label': {
            px: 0.6,
            fontSize: 10,
            letterSpacing: 0.3,
            textTransform: 'uppercase'
          }
        }}
      />
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0, fontSize: 11 }}
      >
        #{item.id}
      </Typography>
      <Typography
        variant="body2"
        sx={{
          fontSize: 13,
          fontWeight: focused ? 600 : 500,
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {title}
      </Typography>
      <Tooltip title={owner}>
        <Box
          sx={{
            width: 22,
            height: 22,
            borderRadius: '50%',
            bgcolor: (theme) =>
              owner === 'Unassigned'
                ? theme.palette.action.disabledBackground
                : '#1A73E8',
            color: (theme) =>
              owner === 'Unassigned'
                ? theme.palette.text.secondary
                : '#FFFFFF',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 10,
            fontWeight: 700,
            flexShrink: 0
          }}
        >
          {initials(owner)}
        </Box>
      </Tooltip>
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        sx={{ flexShrink: 0, minWidth: 100, justifyContent: 'flex-end' }}
      >
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: stateColor,
            border: (theme) =>
              `1px solid ${
                theme.palette.mode === 'dark'
                  ? 'rgba(255,255,255,0.18)'
                  : 'rgba(0,0,0,0.08)'
              }`
          }}
        />
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: 11 }}>
          {state}
        </Typography>
      </Stack>
    </Box>
  )
}
