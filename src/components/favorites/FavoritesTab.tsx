import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box,
  Button,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Tooltip,
  Typography
} from '@mui/material'
import AssignmentIcon from '@mui/icons-material/Assignment'
import MenuBookIcon from '@mui/icons-material/MenuBook'
import BookmarkIcon from '@mui/icons-material/Bookmark'
import CloseIcon from '@mui/icons-material/Close'
import { useGetConnectionQuery } from '@/store/api/adoApi'
import { useAppDispatch, useAppSelector } from '@/store'
import {
  removeFavorite,
  selectFavorites,
  type FavoriteItem,
  type FavoriteKind
} from '@/store/favoritesSlice'
import { selectWorkItem, setSource } from '@/store/workspaceSlice'
import { fuzzyMatches } from '@/utils/fuzzyMatch'

/**
 * Vertical list of pinned items rendered inside the "Favorites" tab on
 * the Home page. Replaces the older `FavoritesStrip` paper that sat
 * above the My Work tabs — moving it into a tab reclaims vertical space
 * for users with many pins.
 *
 * Items are grouped by kind under sticky-style subheaders, with each
 * group sorted newest-first (the underlying selector already returns
 * newest-first; the per-kind partitioning preserves that order).
 *
 * Favorites are not project-filtered — the stored label / meta is
 * sufficient to navigate back, so we don't need to refetch ADO data
 * to render a row.
 */
export interface FavoritesTabProps {
  /**
   * Fuzzy filter query owned by the parent panel. Empty / whitespace-only
   * values short-circuit to "match all". Co-ordinated with the search
   * input on `MyWorkPanel` so the same `/`-to-focus + `Esc`-to-clear
   * shortcuts work consistently across tabs.
   */
  filterQuery?: string
  /**
   * Invoked when the user clicks the "Clear filter" button on the
   * filtered-empty state. The parent panel resets its own state so the
   * search input clears in lockstep with the list returning to full.
   */
  onClearFilter?: () => void
}

export default function FavoritesTab({
  filterQuery = '',
  onClearFilter
}: FavoritesTabProps = {}): JSX.Element {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const orgUrl = useGetConnectionQuery().data?.organizationUrl
  const favorites = useAppSelector((s) => selectFavorites(s, orgUrl))

  /**
   * Apply the fuzzy filter before grouping so each kind bucket reflects
   * what's visible. Filtering after grouping would leave empty group
   * headers behind.
   */
  const filtered = useMemo(() => {
    const q = filterQuery.trim()
    if (!q) return favorites
    return favorites.filter((fav) =>
      fuzzyMatches(q, buildFavoriteSearchableText(fav))
    )
  }, [favorites, filterQuery])

  const grouped = useMemo(() => {
    const out: Record<FavoriteKind, FavoriteItem[]> = {
      workItem: [],
      wikiPage: [],
      savedQuery: []
    }
    // selectFavorites already returns newest-first; pushing in iteration
    // order preserves that within each bucket.
    for (const fav of filtered) out[fav.kind].push(fav)
    return out
  }, [filtered])

  const filterActive = filterQuery.trim().length > 0

  function handleOpen(item: FavoriteItem): void {
    switch (item.kind) {
      case 'workItem': {
        const id = Number(item.id)
        if (Number.isFinite(id)) dispatch(selectWorkItem(id))
        return
      }
      case 'wikiPage': {
        const wikiId = String(item.meta?.wikiId ?? '')
        const path = String(item.meta?.path ?? '')
        if (!wikiId || !path) return
        navigate(
          `/wiki?wiki=${encodeURIComponent(wikiId)}&path=${encodeURIComponent(path)}`
        )
        return
      }
      case 'savedQuery': {
        dispatch(
          setSource({
            kind: 'savedQuery',
            queryId: item.id,
            queryName: item.label
          })
        )
        navigate('/visualize?view=tree')
      }
    }
  }

  function handleRemove(item: FavoriteItem): void {
    if (!orgUrl) return
    dispatch(
      removeFavorite({
        organizationUrl: orgUrl,
        kind: item.kind,
        id: item.id
      })
    )
  }

  if (favorites.length === 0) {
    return (
      <Box sx={{ p: 4, textAlign: 'center' }}>
        <Typography color="text.secondary">
          No favorites yet — click the ⭐ on a work item or wiki page to
          pin it here.
        </Typography>
      </Box>
    )
  }

  if (filterActive && filtered.length === 0) {
    return (
      <Box sx={{ p: 4, textAlign: 'center' }}>
        <Typography color="text.secondary" gutterBottom>
          No items in this list match{' '}
          <Box
            component="span"
            sx={{
              fontFamily: 'monospace',
              bgcolor: 'action.hover',
              px: 0.5,
              borderRadius: 0.5
            }}
          >
            {filterQuery}
          </Box>
          .
        </Typography>
        {onClearFilter && (
          <Button size="small" onClick={onClearFilter} sx={{ mt: 1 }}>
            Clear filter
          </Button>
        )}
      </Box>
    )
  }

  return (
    <List
      dense
      disablePadding
      // The List itself is the container for kind-groups; each group is
      // its own nested <ul> per the MUI ListSubheader pattern so the
      // browser preserves the semantic header → item relationship.
      subheader={<li />}
      sx={{
        '& ul': { padding: 0 }
      }}
    >
      {KIND_ORDER.map((kind) => {
        const list = grouped[kind]
        if (list.length === 0) return null
        return (
          <li key={kind}>
            <ul>
              <ListSubheader
                disableSticky
                sx={{
                  bgcolor: 'transparent',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  fontSize: 11,
                  letterSpacing: 0.5,
                  lineHeight: 2.5,
                  color: 'text.secondary'
                }}
              >
                {KIND_HEADERS[kind]} · {list.length}
              </ListSubheader>
              {list.map((item) => (
                <FavoriteRow
                  key={`${item.kind}:${item.id}`}
                  item={item}
                  onOpen={() => handleOpen(item)}
                  onRemove={() => handleRemove(item)}
                />
              ))}
            </ul>
          </li>
        )
      })}
    </List>
  )
}

function FavoriteRow({
  item,
  onOpen,
  onRemove
}: {
  item: FavoriteItem
  onOpen: () => void
  onRemove: () => void
}): JSX.Element {
  const Icon = ICON_BY_KIND[item.kind]
  const subtitle = subtitleFor(item)
  return (
    <ListItem
      disablePadding
      secondaryAction={
        <Tooltip title="Remove from favorites">
          <IconButton
            size="small"
            edge="end"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
            aria-label={`Remove ${item.label} from favorites`}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      }
    >
      <ListItemButton onClick={onOpen} sx={{ pr: 6 }}>
        <ListItemIcon sx={{ minWidth: 32 }}>
          <Icon sx={{ fontSize: 20, color: 'text.secondary' }} />
        </ListItemIcon>
        <ListItemText
          primary={item.label || '(untitled)'}
          primaryTypographyProps={{
            variant: 'body2',
            sx: {
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }
          }}
          secondary={subtitle ?? undefined}
          secondaryTypographyProps={{
            variant: 'caption',
            sx: {
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'block'
            }
          }}
        />
      </ListItemButton>
    </ListItem>
  )
}

const KIND_ORDER: readonly FavoriteKind[] = [
  'workItem',
  'wikiPage',
  'savedQuery'
]

const KIND_HEADERS: Record<FavoriteKind, string> = {
  workItem: 'Work Items',
  wikiPage: 'Wiki Pages',
  savedQuery: 'Saved Queries'
}

const ICON_BY_KIND: Record<FavoriteKind, typeof AssignmentIcon> = {
  workItem: AssignmentIcon,
  wikiPage: MenuBookIcon,
  savedQuery: BookmarkIcon
}

/**
 * Builds the haystack string fed into `fuzzyMatches` for a favorite row.
 * Indexes everything visible on the row (label, derived subtitle) plus
 * a couple of fields the user is likely to recall — kind ("workItem" /
 * "wikiPage" / "savedQuery"), the raw id, and any string-typed `meta`
 * values like `wikiName`, `queryName`, `type`, and `path`. Non-string
 * meta values are skipped because `FavoriteItem.meta` allows numbers
 * and we only want textual signals here.
 */
function buildFavoriteSearchableText(item: FavoriteItem): string {
  const parts: string[] = [
    item.label,
    item.kind,
    item.id,
    KIND_HEADERS[item.kind],
    item.projectId ?? '',
    subtitleFor(item) ?? ''
  ]
  if (item.meta) {
    for (const v of Object.values(item.meta)) {
      if (typeof v === 'string' && v) parts.push(v)
    }
  }
  return parts.filter(Boolean).join(' ')
}

function subtitleFor(item: FavoriteItem): string | null {
  switch (item.kind) {
    case 'workItem': {
      const type = stringMeta(item, 'type')
      return type ? `${type} · #${item.id}` : `#${item.id}`
    }
    case 'wikiPage': {
      const wikiName = stringMeta(item, 'wikiName')
      return wikiName ?? null
    }
    case 'savedQuery': {
      const name = stringMeta(item, 'queryName')
      return name ?? null
    }
  }
}

function stringMeta(item: FavoriteItem, key: string): string | null {
  const v = item.meta?.[key]
  return typeof v === 'string' && v ? v : null
}
