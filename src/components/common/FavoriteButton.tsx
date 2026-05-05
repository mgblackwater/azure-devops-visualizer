import { IconButton, Tooltip, type SxProps, type Theme } from '@mui/material'
import StarIcon from '@mui/icons-material/Star'
import StarBorderIcon from '@mui/icons-material/StarBorder'
import { useGetConnectionQuery } from '@/store/api/adoApi'
import { useAppDispatch, useAppSelector } from '@/store'
import {
  selectIsFavorite,
  toggleFavorite,
  type FavoriteItem
} from '@/store/favoritesSlice'

/**
 * Star toggle. Reads the active org from the connection query and the
 * favorited-state from the store, dispatches `toggleFavorite` on click.
 *
 * Caller passes the `FavoriteItem` shape minus `addedAt` (slice owns
 * the timestamp). The same component handles both states; the icon and
 * tooltip flip automatically.
 */
export default function FavoriteButton({
  size = 'small',
  sx,
  ...item
}: Omit<FavoriteItem, 'addedAt'> & {
  size?: 'small' | 'medium'
  sx?: SxProps<Theme>
}): JSX.Element {
  const dispatch = useAppDispatch()
  const orgUrl = useGetConnectionQuery().data?.organizationUrl
  const isFavorite = useAppSelector((state) =>
    selectIsFavorite(state, orgUrl, item.kind, item.id)
  )

  function handleClick(): void {
    if (!orgUrl) return
    dispatch(toggleFavorite({ organizationUrl: orgUrl, item }))
  }

  return (
    <Tooltip title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}>
      <span>
        <IconButton
          size={size}
          onClick={handleClick}
          disabled={!orgUrl}
          // Filled-warning when on, neutral outline otherwise — same
          // language as the project pin in HomePage so users learn one
          // visual idiom for "saved for me".
          color={isFavorite ? 'warning' : 'default'}
          aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          aria-pressed={isFavorite}
          sx={sx}
        >
          {isFavorite ? (
            <StarIcon fontSize={size === 'small' ? 'small' : 'medium'} />
          ) : (
            <StarBorderIcon fontSize={size === 'small' ? 'small' : 'medium'} />
          )}
        </IconButton>
      </span>
    </Tooltip>
  )
}
