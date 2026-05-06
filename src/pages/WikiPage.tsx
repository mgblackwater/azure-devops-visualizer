import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  InputAdornment,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import ClearIcon from '@mui/icons-material/Clear'
import LaunchIcon from '@mui/icons-material/Launch'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import DescriptionIcon from '@mui/icons-material/Description'
import FolderOpenIcon from '@mui/icons-material/FolderOpen'
import DOMPurify from 'dompurify'
import {
  useGetConnectionQuery,
  useGetWikiPageQuery,
  useGetWikiPageTreeQuery,
  useListWikisQuery,
  useSearchWikiQuery
} from '@/store/api/adoApi'
import { useAppSelector } from '@/store'
import { IPC } from '@shared/contract'
import type { AdoWiki, AdoWikiPage } from '@shared/adoTypes'
import MarkdownView from '@/components/wiki/MarkdownView'
import FavoriteButton from '@/components/common/FavoriteButton'

const SIDEBAR_WIDTH = 320
const SEARCH_DEBOUNCE_MS = 300
const SEARCH_MIN_CHARS = 2
const SEARCH_TOP = 50

export default function WikiPage(): JSX.Element {
  const projectId = useAppSelector((s) => s.workspace.projectId)
  const projectName = useAppSelector((s) => s.workspace.projectName)
  const orgUrl = useGetConnectionQuery().data?.organizationUrl ?? ''

  const [searchParams, setSearchParams] = useSearchParams()
  const wikiIdParam = searchParams.get('wiki') ?? ''
  const pathParam = searchParams.get('path') ?? ''

  const wikisQ = useListWikisQuery(
    projectId ? { projectId } : (undefined as never),
    { skip: !projectId }
  )

  const wikis = wikisQ.data ?? []

  // Default to the first wiki when none is selected. We don't keep this
  // in component state — the URL is the source of truth so deep-links
  // stay shareable.
  useEffect(() => {
    if (!projectId) return
    if (wikiIdParam) return
    if (wikis.length === 0) return
    const next = new URLSearchParams(searchParams)
    next.set('wiki', wikis[0].id)
    setSearchParams(next, { replace: true })
  }, [projectId, wikiIdParam, wikis, searchParams, setSearchParams])

  const activeWiki =
    wikis.find((w) => w.id === wikiIdParam) ?? (wikis[0] ?? null)

  function selectWiki(nextId: string): void {
    const next = new URLSearchParams(searchParams)
    next.set('wiki', nextId)
    next.delete('path')
    setSearchParams(next, { replace: true })
  }

  function navigateToPath(path: string): void {
    const next = new URLSearchParams(searchParams)
    if (activeWiki) next.set('wiki', activeWiki.id)
    next.set('path', path)
    setSearchParams(next)
  }

  if (!projectId) {
    return (
      <Box sx={{ p: 3, flex: 1 }}>
        <Alert severity="info">
          Pick a project on Home to browse its wiki pages.
        </Alert>
      </Box>
    )
  }

  return (
    <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <WikiSidebar
        projectId={projectId}
        wikis={wikis}
        wikisLoading={wikisQ.isLoading}
        wikisError={wikisQ.error}
        activeWikiId={activeWiki?.id ?? ''}
        activePath={pathParam}
        onSelectWiki={selectWiki}
        onNavigateToPath={navigateToPath}
      />
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        {activeWiki && pathParam ? (
          <WikiPagePane
            projectId={projectId}
            projectName={projectName ?? ''}
            wikiId={activeWiki.id}
            wikiName={activeWiki.name}
            wikiRepositoryId={activeWiki.repositoryId ?? ''}
            path={pathParam}
            orgUrl={orgUrl}
          />
        ) : (
          <Box sx={{ p: 4, flex: 1 }}>
            <Typography color="text.secondary">
              {activeWiki
                ? 'Pick a page from the sidebar to start reading.'
                : wikisQ.isLoading
                  ? 'Loading wikis…'
                  : 'No wikis are visible for this project.'}
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  )
}

/* ------------------------------------------------------------------ */
/* sidebar                                                              */
/* ------------------------------------------------------------------ */

interface SidebarProps {
  projectId: string
  wikis: AdoWiki[]
  wikisLoading: boolean
  wikisError: unknown
  activeWikiId: string
  activePath: string
  onSelectWiki: (id: string) => void
  onNavigateToPath: (path: string) => void
}

function WikiSidebar({
  projectId,
  wikis,
  wikisLoading,
  wikisError,
  activeWikiId,
  activePath,
  onSelectWiki,
  onNavigateToPath
}: SidebarProps): JSX.Element {
  const [searchInput, setSearchInput] = useState('')
  // Debounced version actually fed to the search query — we don't want
  // a query per keystroke, especially against the alm-search host.
  const [debouncedTerm, setDebouncedTerm] = useState('')

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedTerm(searchInput.trim())
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [searchInput])

  const wantSearch = debouncedTerm.length >= SEARCH_MIN_CHARS

  const treeQ = useGetWikiPageTreeQuery(
    activeWikiId ? { projectId, wikiId: activeWikiId } : (undefined as never),
    { skip: !activeWikiId }
  )

  const searchQ = useSearchWikiQuery(
    wantSearch
      ? { projectId, term: debouncedTerm, top: SEARCH_TOP }
      : (undefined as never),
    { skip: !wantSearch }
  )

  // ADO returns NOT_FOUND from the search extension when it isn't
  // installed / not licensed; we also treat any other server error as
  // "unavailable" so the UI degrades gracefully to local-only results
  // rather than getting stuck on a "no matches" message.
  const searchUnavailable = useMemo(() => {
    if (!wantSearch) return false
    return !!searchQ.error
  }, [wantSearch, searchQ.error])

  // Tokens drive both the tree-prune decision (does this node match?)
  // and the title highlighter inside TreeNode. Use the live input so
  // local filtering reacts instantly; the server-side search uses the
  // debounced term to avoid hammering alm-search on every keystroke.
  const tokens = useMemo(() => tokenizeQuery(searchInput), [searchInput])
  const searchActive = tokens.length > 0

  const localMatches = useMemo(
    () => collectLocalMatches(treeQ.data, tokens),
    [treeQ.data, tokens]
  )

  // Server matches contribute paths (so the matching content page
  // appears in the filtered tree even if its name doesn't match the
  // term) and snippets (rendered inline beneath the matching node).
  const serverMatches = useMemo(() => {
    const paths = new Set<string>()
    const snippets = new Map<string, string>()
    for (const r of searchQ.data?.results ?? []) {
      if (!r.path) continue
      paths.add(r.path)
      const snippet = pickFirstHighlight(r.hits)
      if (snippet) snippets.set(r.path, snippet)
    }
    return { paths, snippets }
  }, [searchQ.data])

  const allMatches = useMemo(() => {
    const set = new Set<string>(localMatches)
    for (const p of serverMatches.paths) set.add(p)
    return set
  }, [localMatches, serverMatches.paths])

  // When inactive, hand the raw tree through unchanged so the user
  // can browse normally. When active, prune to the union of local +
  // server matches, preserving ancestors so each match is reachable
  // through its real path in the wiki.
  const filteredTree = useMemo(() => {
    if (!searchActive) return treeQ.data
    return filterTreeByMatches(treeQ.data, allMatches) ?? undefined
  }, [searchActive, treeQ.data, allMatches])

  return (
    <Box
      sx={{
        width: SIDEBAR_WIDTH,
        flexShrink: 0,
        borderRight: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0
      }}
    >
      <Stack spacing={1} sx={{ p: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Autocomplete
          size="small"
          options={wikis ?? []}
          getOptionLabel={(opt) => opt.name}
          isOptionEqualToValue={(a, b) => a.id === b.id}
          value={(wikis ?? []).find((w) => w.id === activeWikiId) ?? null}
          onChange={(_e, value) => {
            if (value) onSelectWiki(value.id)
          }}
          loading={wikisLoading}
          renderInput={(params) => (
            <TextField
              {...params}
              size="small"
              label={wikisLoading ? 'Loading wikis…' : 'Wiki'}
              error={!wikisLoading && (wikisError != null || (wikis?.length ?? 0) === 0)}
            />
          )}
        />
        <TextField
          size="small"
          fullWidth
          placeholder={
            searchUnavailable
              ? 'Filter pages locally…'
              : 'Search wiki pages…'
          }
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
              endAdornment: searchInput ? (
                <InputAdornment position="end">
                  <Tooltip title="Clear search">
                    <IconButton
                      size="small"
                      edge="end"
                      onClick={() => setSearchInput('')}
                    >
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </InputAdornment>
              ) : null
            }
          }}
        />
      </Stack>

      {searchActive && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            px: 1.75,
            py: 0.5,
            borderBottom: '1px solid',
            borderColor: 'divider',
            color: 'text.secondary'
          }}
        >
          <Typography variant="caption" sx={{ fontSize: 11, flex: 1 }}>
            {searchUnavailable
              ? 'Showing page-name matches only'
              : `${allMatches.size} match${allMatches.size === 1 ? '' : 'es'}${
                  wantSearch && searchQ.isFetching ? ' · searching content…' : ''
                }`}
          </Typography>
          {wantSearch && searchQ.isFetching && (
            <CircularProgress size={12} thickness={5} />
          )}
        </Box>
      )}

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', py: 0.5 }}>
        <PageTreePanel
          tree={filteredTree}
          loading={treeQ.isLoading}
          error={treeQ.error}
          activePath={activePath}
          onNavigate={onNavigateToPath}
          searchActive={searchActive}
          searchTerm={searchInput.trim()}
          tokens={tokens}
          matchedPaths={searchActive ? allMatches : undefined}
          snippets={searchActive ? serverMatches.snippets : undefined}
        />
      </Box>
    </Box>
  )
}

/* ------------------------------------------------------------------ */
/* page tree                                                            */
/* ------------------------------------------------------------------ */

interface TreeContext {
  searchActive: boolean
  searchTerm: string
  tokens: string[]
  matchedPaths?: Set<string>
  snippets?: Map<string, string>
}

function PageTreePanel({
  tree,
  loading,
  error,
  activePath,
  onNavigate,
  searchActive,
  searchTerm,
  tokens,
  matchedPaths,
  snippets
}: {
  tree: AdoWikiPage | undefined
  loading: boolean
  error: unknown
  activePath: string
  onNavigate: (path: string) => void
  searchActive: boolean
  searchTerm: string
  tokens: string[]
  matchedPaths?: Set<string>
  snippets?: Map<string, string>
}): JSX.Element {
  if (loading) {
    return (
      <Box sx={{ px: 1.5, py: 1 }}>
        {Array.from({ length: 6 }).map((_, idx) => (
          <Skeleton key={idx} height={24} sx={{ my: 0.5 }} />
        ))}
      </Box>
    )
  }
  if (error) {
    return (
      <Alert severity="error" sx={{ mx: 1.5, my: 1 }}>
        Failed to load page tree.
      </Alert>
    )
  }
  const roots = tree?.subPages ?? (tree?.path === '/' ? tree?.subPages : [])
  const rootList = roots ?? []
  if (rootList.length === 0) {
    return (
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', px: 1.5, py: 1 }}
      >
        {searchActive
          ? `No matches for “${searchTerm}”.`
          : 'No pages in this wiki yet.'}
      </Typography>
    )
  }
  const ctx: TreeContext = {
    searchActive,
    searchTerm,
    tokens,
    matchedPaths,
    snippets
  }
  return (
    <Box sx={{ px: 0.5 }}>
      {rootList.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          activePath={activePath}
          onNavigate={onNavigate}
          ctx={ctx}
        />
      ))}
    </Box>
  )
}

function TreeNode({
  node,
  depth,
  activePath,
  onNavigate,
  ctx
}: {
  node: AdoWikiPage
  depth: number
  activePath: string
  onNavigate: (path: string) => void
  ctx: TreeContext
}): JSX.Element {
  const hasChildren = !!node.subPages && node.subPages.length > 0
  const isActive = node.path === activePath
  // Expand by default when this branch contains the active path so the
  // sidebar reveals the user's location after a deep-link / search jump.
  const containsActive = hasChildren && isAncestorPath(node.path, activePath)
  const [expanded, setExpanded] = useState<boolean>(
    () => isActive || containsActive
  )

  // If the active path moves under us after mount, open up to reveal it.
  useEffect(() => {
    if (containsActive && !expanded) setExpanded(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containsActive])

  // While a search is active we always render every kept descendant —
  // the whole point of the filter is "show me where these matches
  // live". The user's manually-set `expanded` state is preserved
  // underneath so collapse-state survives clearing the search.
  const showChildren = hasChildren && (ctx.searchActive || expanded)
  const isMatch = !!ctx.matchedPaths?.has(node.path)
  const snippetHtml = ctx.snippets?.get(node.path) ?? null
  const label = lastSegment(node.path)
  return (
    <Box>
      <Box
        role="button"
        tabIndex={0}
        onClick={() => onNavigate(node.path)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onNavigate(node.path)
        }}
        sx={(theme) => ({
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          py: 0.5,
          pl: 0.5 + depth * 1.25,
          pr: 1,
          borderRadius: 1,
          cursor: 'pointer',
          color: isActive ? 'primary.main' : 'text.primary',
          bgcolor: isActive
            ? theme.palette.mode === 'dark'
              ? 'rgba(99, 167, 255, 0.10)'
              : 'rgba(25, 118, 210, 0.08)'
            : 'transparent',
          fontWeight: isActive || isMatch ? 600 : 400,
          '&:hover': { bgcolor: 'action.hover' }
        })}
      >
        {hasChildren ? (
          ctx.searchActive ? (
            // During search the chevron toggle is non-functional (we
            // force-render children), so present a static folder icon
            // instead — keeps the row visually balanced without
            // implying a click affordance the user can't really use.
            <Box
              sx={{
                width: 24,
                display: 'inline-flex',
                justifyContent: 'center'
              }}
            >
              <FolderOpenIcon
                sx={{ fontSize: 16, color: 'text.disabled' }}
              />
            </Box>
          ) : (
            <IconButton
              size="small"
              onClick={(e) => {
                e.stopPropagation()
                setExpanded((v) => !v)
              }}
              sx={{ p: 0.25, mr: 0.25 }}
              aria-label={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? (
                <ExpandMoreIcon fontSize="small" />
              ) : (
                <ChevronRightIcon fontSize="small" />
              )}
            </IconButton>
          )
        ) : (
          <Box sx={{ width: 24, display: 'inline-flex', justifyContent: 'center' }}>
            <DescriptionIcon
              sx={{ fontSize: 14, color: 'text.disabled' }}
            />
          </Box>
        )}
        <Typography
          variant="body2"
          sx={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 13
          }}
        >
          {ctx.searchActive && ctx.tokens.length > 0
            ? renderHighlightedLabel(label, ctx.tokens)
            : label}
        </Typography>
      </Box>
      {snippetHtml && (
        <SnippetBlock html={snippetHtml} indentDepth={depth} />
      )}
      {hasChildren && showChildren && (
        <Box>
          {node.subPages!.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onNavigate={onNavigate}
              ctx={ctx}
            />
          ))}
        </Box>
      )}
    </Box>
  )
}

/**
 * Renders a wiki-search content snippet directly under its tree node.
 * ADO's `highlights` payload uses `<em>` to mark matched tokens; we
 * sanitise it to a tiny allowlist before rendering as HTML so search
 * payloads can't smuggle in arbitrary markup.
 */
function SnippetBlock({
  html,
  indentDepth
}: {
  html: string
  indentDepth: number
}): JSX.Element {
  const safeHtml = useMemo(
    () =>
      DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['em', 'strong', 'b', 'i', 'span'],
        ALLOWED_ATTR: []
      }),
    [html]
  )
  return (
    <Box
      sx={{
        // Indent the snippet under the row's icon column so it visually
        // belongs to the matched node rather than its siblings.
        pl: 0.5 + indentDepth * 1.25 + 3,
        pr: 1,
        pb: 0.75,
        fontSize: 11.5,
        color: 'text.secondary',
        lineHeight: 1.4,
        '& em': {
          fontStyle: 'normal',
          fontWeight: 600,
          color: 'primary.main',
          bgcolor: 'action.hover',
          px: 0.25,
          borderRadius: 0.5
        }
      }}
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  )
}

/**
 * Splits the title around any token (case-insensitive) and wraps each
 * matching slice in a styled `<mark>`. Tokens that overlap or appear
 * multiple times are all highlighted; non-matching slices render as
 * plain text. Pure presentation — the actual matching decision is
 * already made by `nodeMatchesTokens` in the parent.
 */
function renderHighlightedLabel(
  label: string,
  tokens: string[]
): JSX.Element {
  if (tokens.length === 0) return <>{label}</>
  const escaped = tokens
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .filter(Boolean)
  if (escaped.length === 0) return <>{label}</>
  const re = new RegExp(`(${escaped.join('|')})`, 'gi')
  const parts = label.split(re)
  return (
    <>
      {parts.map((part, idx) => {
        if (!part) return null
        const isMatch = re.test(part)
        // RegExp with /g is stateful; reset before reusing on the next
        // slice so every check starts from index 0.
        re.lastIndex = 0
        if (!isMatch) return <span key={idx}>{part}</span>
        return (
          <Box
            key={idx}
            component="mark"
            sx={{
              bgcolor: 'warning.light',
              color: 'warning.contrastText',
              px: 0.25,
              borderRadius: 0.5
            }}
          >
            {part}
          </Box>
        )
      })}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* page pane (right side)                                               */
/* ------------------------------------------------------------------ */

function WikiPagePane({
  projectId,
  projectName,
  wikiId,
  wikiName,
  wikiRepositoryId,
  path,
  orgUrl
}: {
  projectId: string
  projectName: string
  wikiId: string
  wikiName: string
  wikiRepositoryId: string
  path: string
  orgUrl: string
}): JSX.Element {
  const pageQ = useGetWikiPageQuery(
    { projectId, wikiId, path },
    { skip: !projectId || !wikiId || !path }
  )

  const breadcrumbs = useMemo(() => {
    return path
      .split('/')
      .map((s) => decodeURIComponent(s).replace(/-/g, ' ').trim())
      .filter(Boolean)
  }, [path])

  const lastBreadcrumb = breadcrumbs[breadcrumbs.length - 1] ?? wikiName

  const externalUrl = useMemo(() => {
    if (!orgUrl || !projectName) return null
    const base = orgUrl.replace(/\/+$/, '')
    return `${base}/${encodeURIComponent(projectName)}/_wiki/wikis/${encodeURIComponent(wikiName)}?pagePath=${encodeURIComponent(path)}`
  }, [orgUrl, projectName, wikiName, path])

  function openInBrowser(): void {
    if (!externalUrl) return
    void window.ado.invoke(IPC.ShellOpenExternal, { url: externalUrl })
  }

  const errorMessage = pageQ.error
    ? ((pageQ.error as { data?: { message?: string } }).data?.message ??
        'Failed to load page.')
    : null

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Box
        sx={{
          px: 3,
          py: 1.5,
          borderBottom: '1px solid',
          borderColor: 'divider',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          flexWrap: 'wrap',
          position: 'sticky',
          top: 0,
          zIndex: 2,
          bgcolor: 'background.paper'
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack
            direction="row"
            spacing={0.5}
            alignItems="center"
            useFlexGap
            flexWrap="wrap"
            sx={{ rowGap: 0.25 }}
          >
            <Chip
              size="small"
              label={wikiName}
              variant="outlined"
              sx={{ height: 22 }}
            />
            {breadcrumbs.length > 0 && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ mx: 0.25 }}
              >
                /
              </Typography>
            )}
            {breadcrumbs.map((segment, idx) => (
              <Stack
                key={`${segment}-${idx}`}
                direction="row"
                alignItems="center"
                spacing={0.5}
              >
                <Typography
                  variant="caption"
                  sx={{
                    fontSize: 12,
                    color:
                      idx === breadcrumbs.length - 1
                        ? 'text.primary'
                        : 'text.secondary',
                    fontWeight: idx === breadcrumbs.length - 1 ? 600 : 400
                  }}
                >
                  {segment}
                </Typography>
                {idx < breadcrumbs.length - 1 && (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                  >
                    /
                  </Typography>
                )}
              </Stack>
            ))}
          </Stack>
          <Typography
            variant="h6"
            sx={{ fontSize: 18, fontWeight: 600, lineHeight: 1.3, mt: 0.25 }}
          >
            {lastBreadcrumb}
          </Typography>
        </Box>
        <FavoriteButton
          kind="wikiPage"
          id={`${wikiId}:${path}`}
          label={lastBreadcrumb}
          projectId={projectId}
          meta={{ wikiId, wikiName, path }}
        />
        {externalUrl && (
          <Button
            size="small"
            variant="outlined"
            endIcon={<LaunchIcon fontSize="small" />}
            onClick={openInBrowser}
          >
            Open in Azure DevOps
          </Button>
        )}
      </Box>

      <Box sx={{ flex: 1, p: 3, minHeight: 0 }}>
        {pageQ.isLoading && (
          <Stack spacing={1.5}>
            <Skeleton variant="text" width="40%" height={32} />
            <Skeleton variant="rectangular" height={20} />
            <Skeleton variant="rectangular" height={20} />
            <Skeleton variant="rectangular" height={20} />
            <Skeleton variant="rectangular" height={20} width="80%" />
          </Stack>
        )}
        {errorMessage && (
          <Alert severity="error">{errorMessage}</Alert>
        )}
        {!pageQ.isLoading && !errorMessage && (
          <MarkdownView
            markdown={pageQ.data?.content ?? ''}
            wikiId={wikiId}
            wikiName={wikiName}
            projectId={projectId}
            wikiRepositoryId={wikiRepositoryId}
            currentPagePath={path}
          />
        )}
      </Box>
    </Box>
  )
}

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */

function lastSegment(path: string): string {
  const cleaned = path.replace(/^\/+|\/+$/g, '')
  if (!cleaned) return '/'
  const parts = cleaned.split('/')
  const last = parts[parts.length - 1]
  return decodeURIComponent(last).replace(/-/g, ' ')
}

function isAncestorPath(ancestor: string, descendant: string): boolean {
  if (!ancestor || !descendant) return false
  if (ancestor === descendant) return true
  const a = ancestor.replace(/\/+$/, '') + '/'
  return descendant.startsWith(a)
}

function pickFirstHighlight(
  hits: { fieldReferenceName: string; highlights: string[] }[] | undefined
): string | null {
  if (!hits || hits.length === 0) return null
  for (const hit of hits) {
    const first = hit.highlights?.[0]
    if (first) return first
  }
  return null
}

/* ------------------------------------------------------------------ */
/* search-tree filtering                                                */
/* ------------------------------------------------------------------ */

/**
 * Lower-cases and whitespace-splits the user's input. Empty / blank
 * input returns an empty array, which is the canonical "search is not
 * active" signal upstream.
 */
function tokenizeQuery(input: string): string[] {
  return input
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

/**
 * Token-AND substring match against a single tree node. A node counts
 * as matching when every token appears (case-insensitive) somewhere in
 * either its rendered title (last path segment, hyphens → spaces) or
 * its raw path. Two-axis matching lets users find pages by either the
 * title they see or the slug ADO stores them under.
 */
function nodeMatchesTokens(node: AdoWikiPage, tokens: string[]): boolean {
  if (tokens.length === 0) return false
  if (!node.path || node.path === '/') return false
  const titleLc = lastSegment(node.path).toLowerCase()
  const pathLc = node.path.toLowerCase()
  return tokens.every((t) => titleLc.includes(t) || pathLc.includes(t))
}

/**
 * Walks the tree once and returns the canonical paths of every node
 * whose title or path matches all of the supplied tokens. The result
 * is later unioned with server-side content matches before pruning.
 */
function collectLocalMatches(
  root: AdoWikiPage | undefined,
  tokens: string[]
): Set<string> {
  const out = new Set<string>()
  if (!root || tokens.length === 0) return out
  function walk(node: AdoWikiPage): void {
    if (nodeMatchesTokens(node, tokens)) out.add(node.path)
    for (const child of node.subPages ?? []) walk(child)
  }
  walk(root)
  return out
}

/**
 * Returns a structurally-equivalent copy of the tree pruned down to
 * just the matching nodes plus their ancestors — children of a match
 * are NOT auto-included unless they themselves match. This mirrors how
 * VSCode's file-explorer search behaves and keeps results focused
 * instead of dumping a folder's entire contents because its own name
 * happened to match. Returns `null` if nothing in the tree matches.
 */
function filterTreeByMatches(
  root: AdoWikiPage | undefined,
  matchedPaths: Set<string>
): AdoWikiPage | null {
  if (!root) return null
  function walk(node: AdoWikiPage): AdoWikiPage | null {
    const filteredChildren: AdoWikiPage[] = []
    for (const child of node.subPages ?? []) {
      const kept = walk(child)
      if (kept) filteredChildren.push(kept)
    }
    const selfMatches = matchedPaths.has(node.path)
    // Root passes through whenever any descendant matches even if its
    // own path is the synthetic '/' (which never matches by token).
    const isSyntheticRoot = !node.path || node.path === '/'
    if (!selfMatches && filteredChildren.length === 0 && !isSyntheticRoot) {
      return null
    }
    if (
      isSyntheticRoot &&
      filteredChildren.length === 0 &&
      !selfMatches
    ) {
      return null
    }
    return { ...node, subPages: filteredChildren }
  }
  return walk(root)
}
