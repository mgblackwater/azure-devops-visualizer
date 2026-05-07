import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Divider,
  IconButton,
  Stack,
  Tooltip
} from '@mui/material'
import { styled } from '@mui/material/styles'
import FormatBoldIcon from '@mui/icons-material/FormatBold'
import FormatItalicIcon from '@mui/icons-material/FormatItalic'
import StrikethroughSIcon from '@mui/icons-material/StrikethroughS'
import CodeIcon from '@mui/icons-material/Code'
import LinkIcon from '@mui/icons-material/Link'
import FormatListBulletedIcon from '@mui/icons-material/FormatListBulleted'
import FormatListNumberedIcon from '@mui/icons-material/FormatListNumbered'
import DataObjectIcon from '@mui/icons-material/DataObject'
import { EditorContent, ReactRenderer, useEditor } from '@tiptap/react'
import type { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Mention from '@tiptap/extension-mention'
import type {
  SuggestionKeyDownProps,
  SuggestionProps
} from '@tiptap/suggestion'
import tippy, { type Instance as TippyInstance } from 'tippy.js'
import type { AdoComment, AdoWorkItem, IpcError } from '@shared/adoTypes'
import { useAddWorkItemCommentMutation } from '@/store/api/adoApi'
import MentionList, { type MentionItem, type MentionListHandle } from './MentionList'
import { useMentionSuggestions } from './useMentionSuggestions'
import { isEditorEmpty, serializeForAdo } from './commentSerialize'

interface CommentComposerProps {
  projectId: string
  workItem: AdoWorkItem | undefined
  /**
   * Existing comment thread on this work item. Used to surface
   * "recent contributors" at the top of the `@`-mention picker — the
   * people the user is statistically most likely to want to tag are
   * the people already in the conversation.
   */
  comments: AdoComment[] | undefined
}

/**
 * `EditorContent` is rendered as a child of this styled wrapper. The
 * wrapper owns the editor's surface chrome (border, padding, focus
 * ring) so the editor itself doesn't need any inline `sx` and the
 * styling stays consistent across drawer widths.
 *
 * Notes:
 *   - `outline: none` on `.ProseMirror` removes Chromium's default
 *     focus ring; we draw our own on the wrapper instead so the
 *     toolbar inherits the ring too — useful as a single visual
 *     "this whole thing is the editor" affordance.
 *   - Placeholder styling targets the empty-paragraph decoration that
 *     `@tiptap/extension-placeholder` injects.
 */
const EditorSurface = styled(Box)(({ theme }) => ({
  borderRadius: theme.shape.borderRadius,
  border: `1px solid ${theme.palette.divider}`,
  backgroundColor: theme.palette.background.paper,
  transition: 'border-color 120ms, box-shadow 120ms',
  '&:focus-within': {
    borderColor: theme.palette.primary.main,
    boxShadow: `0 0 0 1px ${theme.palette.primary.main}`
  },
  '& .ProseMirror': {
    outline: 'none',
    minHeight: 80,
    padding: theme.spacing(1, 1.25),
    fontSize: 13,
    lineHeight: 1.55,
    color: theme.palette.text.primary,
    wordBreak: 'break-word',
    '& p.is-editor-empty:first-of-type::before': {
      content: 'attr(data-placeholder)',
      float: 'left',
      color: theme.palette.text.disabled,
      pointerEvents: 'none',
      height: 0
    },
    '& p': { margin: theme.spacing(0.5, 0) },
    '& ul, & ol': { paddingLeft: theme.spacing(3), margin: theme.spacing(0.5, 0) },
    '& code': {
      fontFamily: 'monospace',
      backgroundColor:
        theme.palette.mode === 'dark'
          ? 'rgba(255,255,255,0.08)'
          : 'rgba(0,0,0,0.06)',
      padding: '0 4px',
      borderRadius: 3
    },
    '& pre': {
      backgroundColor:
        theme.palette.mode === 'dark'
          ? 'rgba(255,255,255,0.08)'
          : 'rgba(0,0,0,0.06)',
      padding: theme.spacing(1),
      borderRadius: theme.shape.borderRadius,
      overflowX: 'auto'
    },
    '& blockquote': {
      borderLeft: `3px solid ${theme.palette.divider}`,
      paddingLeft: theme.spacing(1.25),
      margin: theme.spacing(0.5, 0),
      color: theme.palette.text.secondary
    },
    '& a': { color: theme.palette.primary.main },
    '& span[data-type="mention"]': {
      backgroundColor:
        theme.palette.mode === 'dark'
          ? 'rgba(99, 167, 255, 0.20)'
          : 'rgba(25, 118, 210, 0.10)',
      color: theme.palette.primary.main,
      padding: '0 4px',
      borderRadius: 3,
      fontWeight: 500
    }
  }
}))

const ToolbarBar = styled(Stack)(({ theme }) => ({
  flexDirection: 'row',
  alignItems: 'center',
  gap: theme.spacing(0.25),
  flexWrap: 'wrap',
  padding: theme.spacing(0.25, 0.5),
  borderBottom: `1px solid ${theme.palette.divider}`,
  backgroundColor:
    theme.palette.mode === 'dark'
      ? 'rgba(255,255,255,0.02)'
      : 'rgba(0,0,0,0.02)'
}))

/**
 * Comment composer for the work-item drawer's Discussion section.
 *
 * Uses TipTap as the WYSIWYG layer (with `StarterKit`'s built-in
 * markdown shortcuts), a custom `Mention` extension wired to a
 * MUI-styled floating picker, and posts the result via the
 * `addWorkItemComment` mutation. On success the editor clears and
 * the surrounding `listWorkItemComments` query refetches via tag
 * invalidation.
 */
export default function CommentComposer({
  projectId,
  workItem,
  comments
}: CommentComposerProps): JSX.Element {
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isEmpty, setIsEmpty] = useState(true)
  const [addComment, addState] = useAddWorkItemCommentMutation()
  const submitting = addState.isLoading

  const { allItems, loading: mentionsLoading, filterItems } = useMentionSuggestions({
    projectId,
    workItem,
    comments
  })

  // The Mention extension is constructed once at editor mount; it
  // captures whatever `filterItems` is at that moment. To keep the
  // suggestion list reactive we read through refs that the React
  // closure updates on every render.
  const filterItemsRef = useRef(filterItems)
  filterItemsRef.current = filterItems
  const mentionsLoadingRef = useRef(mentionsLoading)
  mentionsLoadingRef.current = mentionsLoading
  // `allItems` ref isn't strictly necessary because filterItems already
  // closes over allItems, but having the latest snapshot around is
  // useful for the `loading` heuristic in the popup component.
  const allItemsRef = useRef<MentionItem[]>(allItems)
  allItemsRef.current = allItems

  const workItemIdRef = useRef<number | undefined>(workItem?.id)
  workItemIdRef.current = workItem?.id

  // ------- Editor + extensions -------
  const editor = useEditor({
    extensions: [
      // StarterKit covers bold/italic/strike/code/codeBlock/blockquote/
      // headings/lists/links + the markdown input rules. We disable
      // `link.openOnClick` so clicking a link inside the editor
      // doesn't navigate the renderer mid-compose; the outer drawer
      // already opens links via the `RichDescription` flow.
      StarterKit.configure({
        link: { openOnClick: false, autolink: true, linkOnPaste: true },
        // Drop the trailingNode extension's empty paragraph; we strip
        // trailing empties on serialize anyway, and the visible blank
        // line below the cursor looks awkward in a compact composer.
        trailingNode: false
      }),
      Placeholder.configure({
        placeholder: 'Write a comment… use @ to mention someone.'
      }),
      Mention.configure({
        HTMLAttributes: {
          // Class name lines up with the styling in `EditorSurface` —
          // and serializer rewrites it into the ADO anchor form on
          // submit, so this only affects the editor's local view.
          class: 'mention'
        },
        suggestion: buildMentionSuggestion(filterItemsRef, mentionsLoadingRef)
      })
    ],
    immediatelyRender: true,
    onUpdate: ({ editor: ed }) => {
      // Track empty state in React so the Submit button can be
      // disabled reactively. We rely on TipTap's own `isEmpty` here
      // for the live check; the serialized HTML is only computed at
      // submit time.
      setIsEmpty(ed.isEmpty)
    },
    onCreate: ({ editor: ed }) => {
      setIsEmpty(ed.isEmpty)
    }
  })

  // ------- Submission -------
  const submit = useCallback(async () => {
    if (!editor || submitting) return
    const html = editor.getHTML()
    if (isEditorEmpty(html)) return
    const adoHtml = serializeForAdo(html)
    if (!adoHtml) return
    setErrorMessage(null)
    try {
      const id = workItemIdRef.current
      if (id == null) {
        setErrorMessage('No work item selected.')
        return
      }
      await addComment({
        projectId,
        workItemId: id,
        htmlText: adoHtml
      }).unwrap()
      // On success — clear the editor *back* to its empty placeholder
      // state. We deliberately keep focus so the user can immediately
      // start a follow-up comment if they want to.
      editor.commands.clearContent(true)
      setIsEmpty(true)
    } catch (err) {
      const ipc = err as IpcError | undefined
      setErrorMessage(ipc?.message ?? 'Failed to post comment.')
    }
  }, [addComment, editor, projectId, submitting])

  // ------- Cmd/Ctrl+Enter to submit -------
  // Bound on the wrapper rather than via TipTap keymap because we want
  // submit() to run with the latest closure (state + projectId), and
  // a TipTap keymap binds at editor-create time.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void submit()
      }
    },
    [submit]
  )

  // Sync editor disable state with the in-flight mutation so the user
  // can't double-submit by typing during the network round trip.
  useEffect(() => {
    if (!editor) return
    editor.setEditable(!submitting)
  }, [editor, submitting])

  const submitDisabled = submitting || isEmpty || !workItem

  // Memoise the toolbar handlers so the IconButtons don't churn —
  // micro-optimisation but it keeps the visual focus ring stable
  // when the editor selection changes.
  const toolbar = useMemo(
    () => buildToolbarSpec(editor),
    [editor]
  )

  return (
    <Box onKeyDown={onKeyDown}>
      <EditorSurface>
        <ToolbarBar>
          {toolbar.map((btn) => (
            <Tooltip key={btn.label} title={btn.label}>
              <span>
                <IconButton
                  size="small"
                  aria-label={btn.label}
                  disabled={!editor || submitting || btn.disabled}
                  color={btn.active ? 'primary' : 'default'}
                  onClick={btn.onClick}
                  sx={{ borderRadius: 1 }}
                >
                  {btn.icon}
                </IconButton>
              </span>
            </Tooltip>
          ))}
          {mentionsLoading && allItems.length === 0 && (
            <Box
              sx={{
                ml: 'auto',
                fontSize: 10,
                color: 'text.disabled',
                pr: 0.5
              }}
            >
              Loading mentions…
            </Box>
          )}
        </ToolbarBar>
        <EditorContent editor={editor} />
      </EditorSurface>

      {errorMessage && (
        <Alert
          severity="error"
          variant="outlined"
          onClose={() => setErrorMessage(null)}
          sx={{ mt: 1 }}
        >
          {errorMessage}
        </Alert>
      )}

      <Stack
        direction="row"
        spacing={1}
        alignItems="center"
        justifyContent="flex-end"
        sx={{ mt: 1 }}
      >
        <Box sx={{ flex: 1, fontSize: 11, color: 'text.disabled' }}>
          Submit with Ctrl/Cmd + Enter
        </Box>
        <Button
          size="small"
          variant="text"
          disabled={submitting || isEmpty}
          onClick={() => {
            editor?.commands.clearContent(true)
            setIsEmpty(true)
            setErrorMessage(null)
          }}
        >
          Clear
        </Button>
        <Divider orientation="vertical" flexItem />
        <Button
          size="small"
          variant="contained"
          disabled={submitDisabled}
          onClick={() => void submit()}
        >
          {submitting ? 'Posting…' : 'Comment'}
        </Button>
      </Stack>
    </Box>
  )
}

interface ToolbarButtonSpec {
  label: string
  icon: JSX.Element
  active: boolean
  disabled?: boolean
  onClick: () => void
}

/**
 * Build the toolbar action specs against the (possibly null) editor.
 * `active` reflects the current selection's marks/nodes so the icons
 * highlight while the cursor is inside e.g. a list. We re-derive on
 * every render rather than subscribing to TipTap state — the editor
 * already triggers a re-render via `onUpdate` and `onSelectionUpdate`
 * when those change.
 */
function buildToolbarSpec(editor: Editor | null): ToolbarButtonSpec[] {
  if (!editor) {
    return [
      { label: 'Bold', icon: <FormatBoldIcon fontSize="small" />, active: false, onClick: noop, disabled: true },
      { label: 'Italic', icon: <FormatItalicIcon fontSize="small" />, active: false, onClick: noop, disabled: true },
      { label: 'Strikethrough', icon: <StrikethroughSIcon fontSize="small" />, active: false, onClick: noop, disabled: true },
      { label: 'Inline code', icon: <CodeIcon fontSize="small" />, active: false, onClick: noop, disabled: true },
      { label: 'Link', icon: <LinkIcon fontSize="small" />, active: false, onClick: noop, disabled: true },
      { label: 'Bullet list', icon: <FormatListBulletedIcon fontSize="small" />, active: false, onClick: noop, disabled: true },
      { label: 'Numbered list', icon: <FormatListNumberedIcon fontSize="small" />, active: false, onClick: noop, disabled: true },
      { label: 'Code block', icon: <DataObjectIcon fontSize="small" />, active: false, onClick: noop, disabled: true }
    ]
  }
  return [
    {
      label: 'Bold',
      icon: <FormatBoldIcon fontSize="small" />,
      active: editor.isActive('bold'),
      onClick: () => editor.chain().focus().toggleBold().run()
    },
    {
      label: 'Italic',
      icon: <FormatItalicIcon fontSize="small" />,
      active: editor.isActive('italic'),
      onClick: () => editor.chain().focus().toggleItalic().run()
    },
    {
      label: 'Strikethrough',
      icon: <StrikethroughSIcon fontSize="small" />,
      active: editor.isActive('strike'),
      onClick: () => editor.chain().focus().toggleStrike().run()
    },
    {
      label: 'Inline code',
      icon: <CodeIcon fontSize="small" />,
      active: editor.isActive('code'),
      onClick: () => editor.chain().focus().toggleCode().run()
    },
    {
      label: 'Link',
      icon: <LinkIcon fontSize="small" />,
      active: editor.isActive('link'),
      onClick: () => promptForLink(editor)
    },
    {
      label: 'Bullet list',
      icon: <FormatListBulletedIcon fontSize="small" />,
      active: editor.isActive('bulletList'),
      onClick: () => editor.chain().focus().toggleBulletList().run()
    },
    {
      label: 'Numbered list',
      icon: <FormatListNumberedIcon fontSize="small" />,
      active: editor.isActive('orderedList'),
      onClick: () => editor.chain().focus().toggleOrderedList().run()
    },
    {
      label: 'Code block',
      icon: <DataObjectIcon fontSize="small" />,
      active: editor.isActive('codeBlock'),
      onClick: () => editor.chain().focus().toggleCodeBlock().run()
    }
  ]
}

function noop(): void {
  /* placeholder while the editor isn't ready */
}

/**
 * Crude link prompt — `window.prompt` is intentionally minimal; the
 * comment composer's link affordance is supposed to be a one-liner,
 * not a modal dialog. If the user clears the input we unset the link
 * mark on the current selection.
 */
function promptForLink(editor: Editor): void {
  const previous = editor.getAttributes('link').href as string | undefined
  const url = window.prompt('Enter URL', previous ?? 'https://')
  if (url === null) return
  if (url === '') {
    editor.chain().focus().extendMarkRange('link').unsetLink().run()
    return
  }
  editor
    .chain()
    .focus()
    .extendMarkRange('link')
    .setLink({ href: url, target: '_blank', rel: 'noopener noreferrer' })
    .run()
}

/**
 * Wire the Mention extension's suggestion API into our React-rendered
 * `MentionList` popup. Returns the `suggestion` config object directly
 * — we live with the loose `any`-shaped TipTap typings inside the
 * helper so the rest of the file can stay strict.
 *
 * The two refs let the suggestion plugin read the latest filter
 * function and loading state without re-creating the editor on every
 * render.
 */
function buildMentionSuggestion(
  filterItemsRef: React.MutableRefObject<(query: string) => MentionItem[]>,
  loadingRef: React.MutableRefObject<boolean>
): NonNullable<Parameters<typeof Mention.configure>[0]>['suggestion'] {
  return {
    char: '@',
    items: ({ query }) => filterItemsRef.current(query),
    // The suggestion plugin's `command` is what the picker calls to
    // commit the selection — it inserts the mention node and replaces
    // the trigger range. We pre-shape the `id` and `label` because
    // those become `data-id` / `data-label` on the rendered span,
    // which is what the serializer rewrites into ADO's anchor form.
    command: ({ editor, range, props }) => {
      const item = props as MentionItem
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          {
            type: 'mention',
            attrs: {
              id: item.id,
              label: item.label
            }
          },
          { type: 'text', text: ' ' }
        ])
        .run()
    },
    render: () => {
      let component: ReactRenderer<MentionListHandle> | null = null
      let popup: TippyInstance[] | null = null

      function getRect(props: SuggestionProps<MentionItem, MentionItem>): (() => DOMRect) | null {
        if (!props.clientRect) return null
        const fn = props.clientRect
        return () => {
          const rect = fn()
          // Tippy is happy with an empty rect when the trigger is
          // briefly off-screen during scroll; we can't return null
          // here because Tippy's positioner would crash.
          return rect ?? new DOMRect(0, 0, 0, 0)
        }
      }

      return {
        onStart: (props: SuggestionProps<MentionItem, MentionItem>) => {
          component = new ReactRenderer(MentionList, {
            props: {
              items: props.items,
              loading: loadingRef.current && props.items.length === 0,
              command: props.command
            },
            editor: props.editor
          })
          if (!props.clientRect) return
          const rect = getRect(props)
          if (!rect) return
          popup = tippy('body', {
            getReferenceClientRect: rect,
            appendTo: () => document.body,
            content: component.element,
            showOnCreate: true,
            interactive: true,
            trigger: 'manual',
            placement: 'bottom-start',
            // No animation keeps the popup snappy and reduces flicker
            // when the user types rapidly past the end of the list.
            animation: false,
            // Tippy's default theme has rounded corners + arrow which
            // clashes with the MUI Paper inside; turn the chrome off.
            arrow: false,
            offset: [0, 6],
            duration: [50, 50],
            zIndex: 1500
          })
        },
        onUpdate: (props: SuggestionProps<MentionItem, MentionItem>) => {
          component?.updateProps({
            items: props.items,
            loading: loadingRef.current && props.items.length === 0,
            command: props.command
          })
          if (!popup || !props.clientRect) return
          const rect = getRect(props)
          if (rect) popup[0].setProps({ getReferenceClientRect: rect })
        },
        onKeyDown: (props: SuggestionKeyDownProps) => {
          if (props.event.key === 'Escape') {
            popup?.[0].hide()
            return true
          }
          return component?.ref?.onKeyDown(props) ?? false
        },
        onExit: () => {
          popup?.[0].destroy()
          component?.destroy()
          popup = null
          component = null
        }
      }
    }
  }
}
