import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
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
import type { AdoWiki, AdoWikiPage, AdoWikiSearchHit } from '@shared/adoTypes'
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

      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', py: 0.5 }}>
        {searchInput.trim().length > 0 ? (
          <SearchResultsPanel
            // Local fuzzy filter runs from the first character so the
            // user gets feedback before they hit the server-search
            // threshold.
            inputTerm={searchInput.trim()}
            debouncedTerm={debouncedTerm}
            wantServerSearch={wantSearch}
            tree={treeQ.data}
            isFetching={searchQ.isFetching}
            results={searchQ.data?.results}
            serverUnavailable={searchUnavailable}
            activePath={activePath}
            onNavigate={onNavigateToPath}
          />
        ) : (
          <PageTreePanel
            tree={treeQ.data}
            loading={treeQ.isLoading}
            error={treeQ.error}
            activePath={activePath}
            onNavigate={onNavigateToPath}
          />
        )}
      </Box>
    </Box>
  )
}

/* ------------------------------------------------------------------ */
/* page tree                                                            */
/* ------------------------------------------------------------------ */

function PageTreePanel({
  tree,
  loading,
  error,
  activePath,
  onNavigate
}: {
  tree: AdoWikiPage | undefined
  loading: boolean
  error: unknown
  activePath: string
  onNavigate: (path: string) => void
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
        No pages in this wiki yet.
      </Typography>
    )
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
        />
      ))}
    </Box>
  )
}

function TreeNode({
  node,
  depth,
  activePath,
  onNavigate
}: {
  node: AdoWikiPage
  depth: number
  activePath: string
  onNavigate: (path: string) => void
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
          fontWeight: isActive ? 600 : 400,
          '&:hover': { bgcolor: 'action.hover' }
        })}
      >
        {hasChildren ? (
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
          {label}
        </Typography>
      </Box>
      {hasChildren && expanded && (
        <Box>
          {node.subPages!.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onNavigate={onNavigate}
            />
          ))}
        </Box>
      )}
    </Box>
  )
}

/* ------------------------------------------------------------------ */
/* search results                                                       */
/* ------------------------------------------------------------------ */

/**
 * Hybrid search results: an instant local "Page matches" subsection
 * driven off the already-loaded page tree, plus a "Content matches"
 * subsection backed by the ADO wiki search API. The local pass runs
 * from the first typed character; the server pass requires
 * {@link SEARCH_MIN_CHARS} so we don't hammer the search service on
 * single-letter inputs.
 *
 * If the server search returns an error (most commonly NOT_FOUND when
 * the wiki search extension isn't installed), we hide the content
 * subsection and show a small inline note — the local "Page matches"
 * subsection remains useful on its own.
 */
function SearchResultsPanel({
  inputTerm,
  debouncedTerm,
  wantServerSearch,
  tree,
  isFetching,
  results,
  serverUnavailable,
  activePath,
  onNavigate
}: {
  inputTerm: string
  debouncedTerm: string
  wantServerSearch: boolean
  tree: AdoWikiPage | undefined
  isFetching: boolean
  results: AdoWikiSearchHit[] | undefined
  serverUnavailable: boolean
  activePath: string
  onNavigate: (path: string) => void
}): JSX.Element {
  // Flatten the page tree once per data change. Each entry carries its
  // human-readable title alongside the canonical path, so we can score
  // title and path matches independently.
  const allPages = useMemo(() => flattenPages(tree), [tree])
  // Use the live input term (not the debounced one) so the local list
  // updates on every keystroke — the whole point of the local pass is
  // that it has zero latency.
  const pageMatches = useMemo(
    () => fuzzyMatchPages(inputTerm, allPages),
    [inputTerm, allPages]
  )

  const showContentSection = wantServerSearch && !serverUnavailable

  return (
    <Box sx={{ px: 1, py: 0.5 }}>
      <SectionHeader title="Page matches" count={pageMatches.length} />
      {pageMatches.length === 0 ? (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', px: 0.75, py: 0.5 }}
        >
          No page-name matches.
        </Typography>
      ) : (
        <Stack spacing={0.5}>
          {pageMatches.map((m) => (
            <SearchHitRow
              key={`page:${m.path}`}
              fileName={m.title}
              path={m.path}
              snippetHtml={null}
              isActive={m.path === activePath}
              onClick={() => onNavigate(m.path)}
            />
          ))}
        </Stack>
      )}

      {serverUnavailable && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{
            display: 'block',
            mt: 1.5,
            px: 0.75,
            fontStyle: 'italic'
          }}
        >
          Content search unavailable — showing page-name matches.
        </Typography>
      )}

      {showContentSection && (
        <Box sx={{ mt: 1.5 }}>
          <SectionHeader
            title="Content matches"
            count={isFetching ? null : results?.length ?? 0}
          />
          {isFetching ? (
            <Box sx={{ px: 0.5 }}>
              {Array.from({ length: 3 }).map((_, idx) => (
                <Skeleton key={idx} height={36} sx={{ my: 0.5 }} />
              ))}
            </Box>
          ) : !results || results.length === 0 ? (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: 'block', px: 0.75, py: 0.5 }}
            >
              No content matches for &ldquo;{debouncedTerm}&rdquo;.
            </Typography>
          ) : (
            <Stack spacing={0.5}>
              {results.map((hit) => {
                const path = hit.path
                const snippet = pickFirstHighlight(hit.hits)
                return (
                  <SearchHitRow
                    key={`content:${hit.wiki?.id ?? ''}:${path}`}
                    fileName={hit.fileName || lastSegment(path)}
                    path={path}
                    snippetHtml={snippet}
                    isActive={path === activePath}
                    onClick={() => onNavigate(path)}
                  />
                )
              })}
            </Stack>
          )}
        </Box>
      )}
    </Box>
  )
}

/**
 * Visual divider between the two search subsections. `count === null`
 * is reserved for the "loading" state of a section so we don't flash
 * a "0" while results are still in flight.
 */
function SectionHeader({
  title,
  count
}: {
  title: string
  count: number | null
}): JSX.Element {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 0.75,
        px: 0.5,
        py: 0.5
      }}
    >
      <Typography
        variant="overline"
        sx={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: 0.6,
          lineHeight: 1.2,
          color: 'text.secondary'
        }}
      >
        {title}
        {count !== null ? ` · ${count}` : ''}
      </Typography>
    </Box>
  )
}

function SearchHitRow({
  fileName,
  path,
  snippetHtml,
  isActive,
  onClick
}: {
  fileName: string
  path: string
  snippetHtml: string | null
  isActive: boolean
  onClick: () => void
}): JSX.Element {
  // Highlight markup from ADO uses `<em>...</em>` to mark matched
  // tokens — sanitise so we can render it without exposing arbitrary
  // markup from search payloads.
  const safeHtml = useMemo(() => {
    if (!snippetHtml) return ''
    return DOMPurify.sanitize(snippetHtml, {
      ALLOWED_TAGS: ['em', 'strong', 'b', 'i', 'span'],
      ALLOWED_ATTR: []
    })
  }, [snippetHtml])
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick()
      }}
      sx={(theme) => ({
        display: 'flex',
        flexDirection: 'column',
        gap: 0.25,
        p: 0.75,
        borderRadius: 1,
        cursor: 'pointer',
        bgcolor: isActive
          ? theme.palette.mode === 'dark'
            ? 'rgba(99, 167, 255, 0.10)'
            : 'rgba(25, 118, 210, 0.08)'
          : 'transparent',
        '&:hover': { bgcolor: 'action.hover' }
      })}
    >
      <Typography
        variant="body2"
        sx={{ fontWeight: 600, fontSize: 13, lineHeight: 1.3 }}
      >
        {fileName}
      </Typography>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{
          fontSize: 11,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {path}
      </Typography>
      {safeHtml && (
        <Box
          sx={{
            fontSize: 11.5,
            color: 'text.secondary',
            mt: 0.25,
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
      )}
    </Box>
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

interface PageEntry {
  /** Canonical wiki path, e.g. `/GPConnect-Track-Timeline`. */
  path: string
  /** Human-readable title — last path segment with hyphens → spaces and
   *  URL-decoded so the local fuzzy filter can match what the user
   *  actually sees in the sidebar. */
  title: string
}

interface PageMatch extends PageEntry {
  score: number
}

function flattenPages(root: AdoWikiPage | undefined): PageEntry[] {
  if (!root) return []
  const out: PageEntry[] = []
  function walk(node: AdoWikiPage): void {
    if (node.path && node.path !== '/') {
      out.push({ path: node.path, title: lastSegment(node.path) })
    }
    for (const child of node.subPages ?? []) walk(child)
  }
  walk(root)
  return out
}

/**
 * Token-AND substring fuzzy match against a flattened page list.
 *
 * Mirrors the model used by {@link WorkItemSearchBox}: tokenise on
 * whitespace, lowercase, and keep candidates where every token appears
 * (as a substring, case-insensitive) somewhere in the title or path.
 * The score nudges exact / prefix title hits above generic substring
 * hits so the most-relevant page bubbles to the top.
 */
function fuzzyMatchPages(term: string, pages: PageEntry[]): PageMatch[] {
  const trimmed = term.trim().toLowerCase()
  if (!trimmed) return []
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0)
  if (tokens.length === 0) return []
  const out: PageMatch[] = []
  for (const page of pages) {
    const titleLc = page.title.toLowerCase()
    const pathLc = page.path.toLowerCase()
    const titleHasAll = tokens.every((t) => titleLc.includes(t))
    const pathHasAll = tokens.every((t) => pathLc.includes(t))
    if (!titleHasAll && !pathHasAll) continue
    let score: number
    if (titleLc === trimmed) score = 100
    else if (titleLc.startsWith(trimmed)) score = 50
    else if (titleHasAll) score = 30
    else score = 10
    out.push({ ...page, score })
  }
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.path.localeCompare(b.path)
  })
  return out.slice(0, 50)
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
