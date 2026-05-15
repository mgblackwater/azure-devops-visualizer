import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import styled from '@emotion/styled'
import {
  Button,
  Checkbox,
  Divider,
  FormControlLabel,
  IconButton,
  Menu,
  MenuItem,
  Select,
  TextField
} from '@mui/material'
import { alpha } from '@mui/material/styles'
import MoreVertIcon from '@mui/icons-material/MoreVert'
import type { SessionMeta } from '@shared/claudeTypes'
import { useAppDispatch, useAppSelector } from '../store'
import { fetchSessions, openInTerminal, rescanIndex } from '../store/claudeSlice'
import ClaudeSubNav from '../components/claude/ClaudeSubNav'

const Container = styled.div`
  padding: 24px;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  box-sizing: border-box;
`

const Toolbar = styled.div`
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
`

const ListWrapper = styled.div`
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  border: 1px solid ${({ theme }) => theme.palette.divider};
  border-radius: 6px;
  background: ${({ theme }) => theme.palette.background.paper};
`

const GRID = '160px minmax(0, 1fr) 70px 80px 80px 110px 40px'

const HeaderRow = styled.div`
  display: grid;
  grid-template-columns: ${GRID};
  gap: 12px;
  padding: 10px 12px;
  /* Opaque so scrolled rows don't bleed through under sticky header */
  background: ${({ theme }) => theme.palette.background.paper};
  border-bottom: 1px solid ${({ theme }) => theme.palette.divider};
  position: sticky;
  top: 0;
  z-index: 2;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: ${({ theme }) => theme.palette.text.secondary};
`

const SortHeader = styled.button<{ active: boolean }>`
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: ${({ active, theme }) =>
    active ? theme.palette.text.primary : theme.palette.text.secondary};
  cursor: pointer;
  text-align: left;
  text-transform: inherit;
  letter-spacing: inherit;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  &:hover {
    color: ${({ theme }) => theme.palette.text.primary};
  }
`

const Row = styled(Link)`
  display: grid;
  grid-template-columns: ${GRID};
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid ${({ theme }) => theme.palette.divider};
  color: ${({ theme }) => theme.palette.text.primary};
  text-decoration: none;
  align-items: center;
  &:hover {
    background: ${({ theme }) => theme.palette.action.hover};
  }
  &:last-child {
    border-bottom: none;
  }
`

const StartedCell = styled.div`
  display: flex;
  flex-direction: column;
  min-width: 0;
`

const StartedTime = styled.span`
  font-size: 13px;
`

const Duration = styled.span`
  font-size: 11px;
  color: ${({ theme }) => theme.palette.text.secondary};
`

const Project = styled.span`
  color: ${({ theme }) => theme.palette.primary.main};
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
`

const Preview = styled.span`
  color: ${({ theme }) => theme.palette.text.primary};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
`

const Right = styled.span`
  margin-left: auto;
  color: ${({ theme }) => theme.palette.text.secondary};
`

const Empty = styled.div`
  padding: 32px;
  color: ${({ theme }) => theme.palette.text.secondary};
  text-align: center;
`

function formatTime(iso: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString()
}

function formatDuration(startedAt: string, endedAt: string): string {
  if (!startedAt || !endedAt) return ''
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime()
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

function shortModel(model: string | undefined): string {
  if (!model) return '—'
  const parts = model.split('-')
  return parts.slice(1, 3).join('-') || model
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

type SortKey =
  | 'lastActivity'
  | 'startedAt'
  | 'projectKey'
  | 'turnCount'
  | 'outputTokens'
  | 'cost'
  | 'model'
type SortDir = 'asc' | 'desc'

const DEFAULT_DIR: Record<SortKey, SortDir> = {
  lastActivity: 'desc',
  startedAt: 'desc',
  projectKey: 'asc',
  turnCount: 'desc',
  outputTokens: 'desc',
  cost: 'desc',
  model: 'asc'
}

function valueFor(s: SessionMeta, key: SortKey): number | string {
  switch (key) {
    case 'lastActivity':
      return s.endedAt || s.startedAt
    case 'startedAt':
      return s.startedAt
    case 'projectKey':
      return s.projectKey.toLowerCase()
    case 'turnCount':
      return s.turnCount
    case 'outputTokens':
      return s.usage.outputTokens
    case 'cost':
      return s.usage.apiEquivalentUsd
    case 'model':
      return (s.models[0] ?? '').toLowerCase()
  }
}

function compare(a: SessionMeta, b: SessionMeta, key: SortKey, dir: SortDir): number {
  const va = valueFor(a, key)
  const vb = valueFor(b, key)
  let cmp: number
  if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb
  else cmp = String(va).localeCompare(String(vb))
  return dir === 'asc' ? cmp : -cmp
}

type MenuTarget = { anchor: HTMLElement; session: SessionMeta }

export default function ClaudeSessionsPage(): JSX.Element {
  const dispatch = useAppDispatch()
  const sessions = useAppSelector((s) => s.claude.sessions)
  const loading = useAppSelector((s) => s.claude.loading.index)
  const [dateFilter, setDateFilter] = useState('')
  const [projectFilter, setProjectFilter] = useState('')
  const [showEmpty, setShowEmpty] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('lastActivity')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [menu, setMenu] = useState<MenuTarget | null>(null)

  useEffect(() => {
    void dispatch(fetchSessions({}))
  }, [dispatch])

  const projectOptions = useMemo(
    () => Array.from(new Set(sessions.map((s) => s.projectKey))).sort(),
    [sessions]
  )

  const filtered = useMemo(() => {
    const out = sessions.filter((s) => {
      if (!showEmpty && s.turnCount === 0) return false
      if (projectFilter && s.projectKey !== projectFilter) return false
      if (dateFilter && !s.startedAt.startsWith(dateFilter)) return false
      return true
    })
    return out.sort((a, b) => compare(a, b, sortKey, sortDir))
  }, [sessions, projectFilter, dateFilter, showEmpty, sortKey, sortDir])

  function toggleSort(next: SortKey): void {
    if (next === sortKey) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(next)
      setSortDir(DEFAULT_DIR[next])
    }
  }

  function arrow(key: SortKey): string {
    if (key !== sortKey) return ''
    return sortDir === 'asc' ? ' ▲' : ' ▼'
  }

  function openMenu(e: MouseEvent, session: SessionMeta): void {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ anchor: e.currentTarget as HTMLElement, session })
  }

  function copy(text: string): void {
    void navigator.clipboard.writeText(text)
    setMenu(null)
  }

  // Reference alpha so it doesn't get tree-shaken if we re-add tinted bg later
  void alpha

  return (
    <Container>
      <ClaudeSubNav />
      <h2 style={{ margin: '0 0 12px' }}>Sessions</h2>
      <Toolbar>
        <TextField
          label="Date"
          type="date"
          size="small"
          value={dateFilter}
          onChange={(e) => setDateFilter(e.target.value)}
          InputLabelProps={{ shrink: true }}
        />
        <Select
          size="small"
          displayEmpty
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          sx={{ minWidth: 220 }}
        >
          <MenuItem value="">All projects</MenuItem>
          {projectOptions.map((p) => (
            <MenuItem key={p} value={p}>
              {p}
            </MenuItem>
          ))}
        </Select>
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={showEmpty}
              onChange={(e) => setShowEmpty(e.target.checked)}
            />
          }
          label="Show empty sessions"
        />
        <Button
          variant="outlined"
          disabled={loading}
          onClick={async () => {
            await dispatch(rescanIndex())
            void dispatch(fetchSessions({}))
          }}
        >
          {loading ? 'Refreshing…' : 'Refresh index'}
        </Button>
        <Right>
          {filtered.length} of {sessions.length}
        </Right>
      </Toolbar>

      <ListWrapper>
        <HeaderRow>
          <SortHeader
            active={sortKey === 'lastActivity' || sortKey === 'startedAt'}
            onClick={() =>
              toggleSort(
                sortKey === 'startedAt'
                  ? 'lastActivity'
                  : sortKey === 'lastActivity'
                    ? 'startedAt'
                    : 'lastActivity'
              )
            }
            title="Click to toggle between Last activity / Started time"
          >
            {sortKey === 'startedAt' ? 'Started' : 'Last activity'}
            {arrow(sortKey === 'startedAt' ? 'startedAt' : 'lastActivity')}
          </SortHeader>
          <SortHeader active={sortKey === 'projectKey'} onClick={() => toggleSort('projectKey')}>
            Project / first prompt{arrow('projectKey')}
          </SortHeader>
          <SortHeader active={sortKey === 'turnCount'} onClick={() => toggleSort('turnCount')}>
            Turns{arrow('turnCount')}
          </SortHeader>
          <SortHeader active={sortKey === 'outputTokens'} onClick={() => toggleSort('outputTokens')}>
            Out tokens{arrow('outputTokens')}
          </SortHeader>
          <SortHeader active={sortKey === 'cost'} onClick={() => toggleSort('cost')}>
            Cost ($){arrow('cost')}
          </SortHeader>
          <SortHeader active={sortKey === 'model'} onClick={() => toggleSort('model')}>
            Model{arrow('model')}
          </SortHeader>
          <span />
        </HeaderRow>

        {filtered.map((s) => {
          const duration = formatDuration(s.startedAt, s.endedAt)
          const primary = sortKey === 'startedAt' ? s.startedAt : s.endedAt || s.startedAt
          return (
            <Row key={s.id} to={`/claude/sessions/${s.id}`}>
              <StartedCell title={`Started ${formatTime(s.startedAt)}\nEnded ${formatTime(s.endedAt)}`}>
                <StartedTime>{formatTime(primary)}</StartedTime>
                {duration && <Duration>{duration} span</Duration>}
              </StartedCell>
              <Preview>
                <Project>{s.projectKey}</Project> — {s.firstUserPrompt || <em>(no prompt)</em>}
              </Preview>
              <span>{s.turnCount}</span>
              <span title={`${s.usage.outputTokens.toLocaleString()} output tokens`}>
                {formatTokens(s.usage.outputTokens)}
              </span>
              <span>${s.usage.apiEquivalentUsd.toFixed(2)}</span>
              <span>{shortModel(s.models[0])}</span>
              <IconButton
                size="small"
                onClick={(e) => openMenu(e, s)}
                sx={{ ml: 'auto' }}
                aria-label="Session actions"
              >
                <MoreVertIcon fontSize="small" />
              </IconButton>
            </Row>
          )
        })}

        {filtered.length === 0 && !loading && (
          <Empty>
            No sessions match these filters. If this is the first run, click <strong>Refresh index</strong>.
          </Empty>
        )}
      </ListWrapper>

      <Menu anchorEl={menu?.anchor} open={!!menu} onClose={() => setMenu(null)}>
        {window.ado.platform === 'win32' && (
          <MenuItem
            onClick={() => {
              if (!menu) return
              void dispatch(
                openInTerminal({ sessionId: menu.session.id, shell: 'wt' })
              )
              setMenu(null)
            }}
          >
            Open in Windows Terminal
          </MenuItem>
        )}
        {window.ado.platform === 'win32' && (
          <MenuItem
            onClick={() => {
              if (!menu) return
              void dispatch(
                openInTerminal({ sessionId: menu.session.id, shell: 'powershell' })
              )
              setMenu(null)
            }}
          >
            Open in PowerShell
          </MenuItem>
        )}
        {window.ado.platform === 'darwin' && (
          <MenuItem
            onClick={() => {
              if (!menu) return
              void dispatch(
                openInTerminal({
                  sessionId: menu.session.id,
                  shell: 'macos-terminal'
                })
              )
              setMenu(null)
            }}
          >
            Open in Terminal
          </MenuItem>
        )}
        {window.ado.platform === 'darwin' && (
          <MenuItem
            onClick={() => {
              if (!menu) return
              void dispatch(
                openInTerminal({ sessionId: menu.session.id, shell: 'iterm2' })
              )
              setMenu(null)
            }}
          >
            Open in iTerm2
          </MenuItem>
        )}
        <Divider />
        <MenuItem onClick={() => menu && copy(menu.session.id)}>
          Copy session ID
        </MenuItem>
        <MenuItem
          onClick={() =>
            menu &&
            copy(`cd "${menu.session.cwd}" && claude --resume ${menu.session.id}`)
          }
        >
          Copy resume command
        </MenuItem>
        <MenuItem onClick={() => menu && copy(menu.session.filePath)}>
          Copy JSONL path
        </MenuItem>
      </Menu>
    </Container>
  )
}
