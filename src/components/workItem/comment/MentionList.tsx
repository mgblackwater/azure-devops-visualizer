import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useState
} from 'react'
import { Avatar, Box, Paper, Typography } from '@mui/material'
import type { SuggestionKeyDownProps } from '@tiptap/suggestion'

/**
 * The shape passed *into* the editor when the user picks a row. TipTap's
 * `Mention` extension expects an object with `id` (stored on the node)
 * and `label` (what gets rendered). We pre-build the descriptor-shaped
 * id here so the serializer can blindly rewrite to the ADO anchor form
 * without re-deriving anything.
 */
export interface MentionItem {
  /** Stable identity key — the descriptor when ADO returned one, else the GUID. */
  id: string
  /** Display name used as the visible mention label, e.g. "Alice Smith". */
  label: string
  /** Email / `uniqueName` for the secondary line. May be empty. */
  uniqueName?: string
  /** Avatar URL when ADO returned one. Falls back to initials. */
  imageUrl?: string
  /**
   * Marks rows that come from this work item's recent contributors so
   * the renderer can show a subtle "Recent" hint and pin them above
   * the rest of the project list.
   */
  recent?: boolean
}

/**
 * Imperative handle TipTap's suggestion API calls into. Returning
 * `true` from `onKeyDown` tells the suggestion runtime that the popup
 * has handled the key and the editor should leave it alone (e.g. so
 * Enter selects a row instead of inserting a newline).
 */
export interface MentionListHandle {
  onKeyDown(props: SuggestionKeyDownProps): boolean
}

interface MentionListProps {
  items: MentionItem[]
  loading: boolean
  /**
   * Called when the user picks a row. The wrapping `ReactRenderer` will
   * forward this to the suggestion plugin's `command` callback so the
   * editor inserts the actual mention node.
   */
  command: (item: MentionItem) => void
}

/**
 * Floating mention picker rendered by TipTap's suggestion API. Keyboard
 * navigation lives entirely inside `onKeyDown` (exposed via ref) so the
 * popup behaves predictably even when the editor view doesn't have
 * focus during a programmatic insertion.
 */
const MentionList = forwardRef<MentionListHandle, MentionListProps>(
  function MentionList({ items, loading, command }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0)

    // Reset the cursor whenever the candidate list churns. Without this,
    // typing past the end of a row makes the list shrink while the
    // cursor stays at the (now out-of-bounds) old index, which makes
    // Enter feel broken.
    useEffect(() => {
      setSelectedIndex(0)
    }, [items])

    const selectIndex = useCallback(
      (index: number) => {
        const item = items[index]
        if (item) command(item)
      },
      [items, command]
    )

    useImperativeHandle(
      ref,
      () => ({
        onKeyDown: ({ event }) => {
          if (items.length === 0) {
            // Even with no items we still need to swallow Esc so the
            // suggestion runtime can close the popup. Other keys fall
            // through to the editor for normal typing.
            if (event.key === 'Escape') return true
            return false
          }
          if (event.key === 'ArrowUp') {
            setSelectedIndex((i) => (i + items.length - 1) % items.length)
            return true
          }
          if (event.key === 'ArrowDown') {
            setSelectedIndex((i) => (i + 1) % items.length)
            return true
          }
          if (event.key === 'Enter') {
            selectIndex(selectedIndex)
            return true
          }
          if (event.key === 'Tab') {
            // Tab shouldn't move focus out of the editor while a picker
            // is open — it's a natural "accept current row" gesture.
            selectIndex(selectedIndex)
            return true
          }
          if (event.key === 'Escape') return true
          return false
        }
      }),
      [items, selectedIndex, selectIndex]
    )

    return (
      <Paper
        elevation={6}
        sx={{
          minWidth: 240,
          maxWidth: 320,
          maxHeight: 280,
          overflowY: 'auto',
          py: 0.5,
          borderRadius: 1.5,
          border: '1px solid',
          borderColor: 'divider'
        }}
      >
        {loading && items.length === 0 && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', px: 1.25, py: 0.75 }}
          >
            Searching…
          </Typography>
        )}
        {!loading && items.length === 0 && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', px: 1.25, py: 0.75 }}
          >
            No matches
          </Typography>
        )}
        {items.map((item, index) => {
          const selected = index === selectedIndex
          return (
            <Box
              key={`${item.id || item.label}:${index}`}
              role="option"
              aria-selected={selected}
              onMouseEnter={() => setSelectedIndex(index)}
              onMouseDown={(e) => {
                // Prevent the editor losing focus before we get to commit
                // the selection — focus loss tears the suggestion popup
                // down before the click handler fires.
                e.preventDefault()
                selectIndex(index)
              }}
              sx={(theme) => ({
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.25,
                py: 0.75,
                cursor: 'pointer',
                bgcolor: selected
                  ? theme.palette.action.selected
                  : 'transparent',
                '&:hover': { bgcolor: theme.palette.action.hover }
              })}
            >
              <Avatar
                src={item.imageUrl}
                alt={item.label}
                sx={{ width: 24, height: 24, fontSize: 11 }}
              >
                {initialsFor(item.label)}
              </Avatar>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 500,
                    lineHeight: 1.2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {item.label}
                </Typography>
                {item.uniqueName && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{
                      display: 'block',
                      lineHeight: 1.2,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {item.uniqueName}
                  </Typography>
                )}
              </Box>
              {item.recent && (
                <Typography
                  variant="caption"
                  color="primary"
                  sx={{ fontSize: 10, fontWeight: 600, ml: 0.5 }}
                >
                  RECENT
                </Typography>
              )}
            </Box>
          )
        })}
      </Paper>
    )
  }
)

function initialsFor(name: string): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/).slice(0, 2)
  return parts.map((p) => p.charAt(0).toUpperCase()).join('') || '?'
}

export default MentionList
