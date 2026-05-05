import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Box,
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
export default function FavoritesTab(): JSX.Element {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const orgUrl = useGetConnectionQuery().data?.organizationUrl
  const favorites = useAppSelector((s) => selectFavorites(s, orgUrl))

  const grouped = useMemo(() => {
    const out: Record<FavoriteKind, FavoriteItem[]> = {
      workItem: [],
      wikiPage: [],
      savedQuery: []
    }
    // selectFavorites already returns newest-first; pushing in iteration
    // order preserves that within each bucket.
    for (const fav of favorites) out[fav.kind].push(fav)
    return out
  }, [favorites])

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
