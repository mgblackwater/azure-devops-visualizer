import { useMemo, useState } from 'react'
import styled from '@emotion/styled'
import { Button, Chip, TextField } from '@mui/material'
import { alpha } from '@mui/material/styles'
import ReactMarkdown from 'react-markdown'
import type { AdoItemRef } from '@shared/claudeTypes'
import {
  useBatchGetWorkItemsQuery,
  useGetConnectionQuery,
  useRunWiqlQuery
} from '../store/api/adoApi'
import { useAppDispatch, useAppSelector } from '../store'
import { generateJournal } from '../store/claudeSlice'
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

const Scroll = styled.div`
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
`

const StatsRow = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
`

const StatCard = styled.div`
  padding: 12px 14px;
  background: ${({ theme }) => theme.palette.background.paper};
  border: 1px solid ${({ theme }) => theme.palette.divider};
  border-radius: 8px;
`

const StatLabel = styled.div`
  font-size: 10px;
  color: ${({ theme }) => theme.palette.text.secondary};
  text-transform: uppercase;
  letter-spacing: 0.5px;
`

const StatValue = styled.div`
  font-size: 20px;
  margin-top: 4px;
  color: ${({ theme }) => theme.palette.text.primary};
`

const StatSub = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.palette.text.secondary};
  margin-top: 4px;
`

const AdoPanel = styled.div`
  padding: 12px 14px;
  background: ${({ theme }) => theme.palette.background.paper};
  border: 1px solid ${({ theme }) => theme.palette.divider};
  border-radius: 8px;
  margin-bottom: 16px;
  font-size: 13px;
  color: ${({ theme }) => theme.palette.text.primary};
`

const AdoItem = styled.div`
  margin: 4px 0;
  display: flex;
  gap: 8px;
  align-items: center;
`

const AdoId = styled.span`
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: ${({ theme }) => theme.palette.primary.main};
`

const Card = styled.div`
  background: ${({ theme }) => theme.palette.background.paper};
  border: 1px solid ${({ theme }) => theme.palette.divider};
  padding: 20px 24px;
  border-radius: 8px;
  width: 100%;
  box-sizing: border-box;
  color: ${({ theme }) => theme.palette.text.primary};
`

const Banner = styled.div`
  background: ${({ theme }) => alpha(theme.palette.primary.main, 0.12)};
  border: 1px solid ${({ theme }) => alpha(theme.palette.primary.main, 0.4)};
  color: ${({ theme }) => theme.palette.primary.main};
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
`

const Spinner = styled.span`
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-top-color: #4a90e2;
  border-radius: 50%;
  display: inline-block;
  animation: spin 800ms linear infinite;
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
`

function todayLocalISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function nextDayLocalISO(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(y, m - 1, d + 1)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

function buildChangedTodayWiql(date: string): string {
  const next = nextDayLocalISO(date)
  return `SELECT [System.Id] FROM WorkItems WHERE [System.ChangedBy] = @Me AND [System.ChangedDate] >= '${date}' AND [System.ChangedDate] < '${next}' ORDER BY [System.ChangedDate] DESC`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function shortModel(model: string): string {
  const parts = model.split('-')
  return parts.slice(1, 3).join('-') || model
}

export default function ClaudeJournalPage(): JSX.Element {
  const dispatch = useAppDispatch()
  const [date, setDate] = useState(todayLocalISO())
  const generating = useAppSelector((s) => s.claude.journalUi.isGenerating)
  const markdown = useAppSelector((s) => s.claude.journals[date])
  const cliAvailable = useAppSelector((s) => s.claude.cliAvailable)

  //* Per-day stats from indexed sessions ---
  const sessions = useAppSelector((s) => s.claude.sessions)
  const stats = useMemo(() => {
    const inDay = sessions.filter((sess) => {
      const d = new Date(sess.startedAt)
      const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      return local === date
    })
    const t = {
      sessions: inDay.length,
      turns: 0,
      output: 0,
      cacheRead: 0,
      cost: 0,
      models: new Set<string>(),
      projects: new Set<string>(),
      firstAt: '' as string,
      lastAt: '' as string
    }
    for (const s of inDay) {
      t.turns += s.turnCount
      t.output += s.usage.outputTokens
      t.cacheRead += s.usage.cacheReadTokens
      t.cost += s.usage.apiEquivalentUsd
      s.models.forEach((m) => t.models.add(m))
      if (s.projectKey) t.projects.add(s.projectKey)
      if (!t.firstAt || s.startedAt < t.firstAt) t.firstAt = s.startedAt
      const end = s.endedAt || s.startedAt
      if (!t.lastAt || end > t.lastAt) t.lastAt = end
    }
    return t
  }, [sessions, date])

  const activeWindow = useMemo(() => {
    if (!stats.firstAt || !stats.lastAt) return null
    const first = new Date(stats.firstAt)
    const last = new Date(stats.lastAt)
    const fmt = (d: Date): string =>
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const spanMs = last.getTime() - first.getTime()
    const hours = Math.floor(spanMs / 3_600_000)
    const minutes = Math.floor((spanMs % 3_600_000) / 60_000)
    const span = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
    return { range: `${fmt(first)} → ${fmt(last)}`, span }
  }, [stats.firstAt, stats.lastAt])

  //* ADO correlation — items the current user changed on the selected date ---
  const projectId = useAppSelector((s) => s.workspace.projectId)
  const { data: connection } = useGetConnectionQuery()
  const wiql = useMemo(() => buildChangedTodayWiql(date), [date])
  const wiqlQ = useRunWiqlQuery(
    { projectId: projectId ?? '', wiql },
    { skip: !projectId || !connection?.hasToken }
  )
  const ids = wiqlQ.data?.workItems?.map((w) => w.id) ?? []
  const batchQ = useBatchGetWorkItemsQuery(
    {
      projectId: projectId ?? undefined,
      ids,
      fields: [
        'System.Title',
        'System.WorkItemType',
        'System.State',
        'System.ChangedDate'
      ]
    },
    { skip: ids.length === 0 }
  )
  const adoItems: AdoItemRef[] = useMemo(() => {
    if (!batchQ.data) return []
    return batchQ.data.map((w) => ({
      id: w.id,
      title: w.fields['System.Title'] ?? '(no title)',
      workItemType: w.fields['System.WorkItemType'] ?? 'Unknown',
      state: w.fields['System.State'] ?? '?',
      lastUpdated: w.fields['System.ChangedDate'] ?? ''
    }))
  }, [batchQ.data])

  const adoLoading = wiqlQ.isFetching || batchQ.isFetching
  const adoError = wiqlQ.error || batchQ.error

  function onGenerate(): void {
    void dispatch(generateJournal({ date, adoItems, force: !!markdown }))
  }

  return (
    <Container>
      <ClaudeSubNav />
      <h2 style={{ margin: '0 0 12px' }}>Daily Summary</h2>

      {generating && (
        <Banner>
          <Spinner /> Generating daily summary for{' '}
          <strong>{date}</strong> in the background — feel free to switch tabs.
        </Banner>
      )}

      <Toolbar>
        <TextField
          type="date"
          size="small"
          label="Date"
          InputLabelProps={{ shrink: true }}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <Button
          variant="contained"
          disabled={generating || cliAvailable === false}
          title={cliAvailable === false ? 'Claude CLI not found on PATH' : undefined}
          onClick={onGenerate}
        >
          {generating
            ? 'Generating…'
            : markdown
              ? 'Regenerate Summary'
              : 'Generate Summary'}
        </Button>
        <Button
          variant="outlined"
          disabled={!markdown}
          onClick={() => markdown && navigator.clipboard.writeText(markdown)}
        >
          Copy markdown
        </Button>
      </Toolbar>

      <StatsRow>
        <StatCard>
          <StatLabel>Sessions</StatLabel>
          <StatValue>{stats.sessions}</StatValue>
          <StatSub>
            {[...stats.projects].slice(0, 2).join(', ')}
            {stats.projects.size > 2 ? ` +${stats.projects.size - 2}` : ''}
          </StatSub>
        </StatCard>
        <StatCard>
          <StatLabel>Turns</StatLabel>
          <StatValue>{stats.turns}</StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>Output tokens</StatLabel>
          <StatValue>{formatTokens(stats.output)}</StatValue>
          <StatSub>cache reads {formatTokens(stats.cacheRead)}</StatSub>
        </StatCard>
        <StatCard>
          <StatLabel>API-equivalent</StatLabel>
          <StatValue>${stats.cost.toFixed(2)}</StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>Models</StatLabel>
          <StatValue style={{ fontSize: 13, marginTop: 8 }}>
            {[...stats.models].map((m) => (
              <Chip
                key={m}
                label={shortModel(m)}
                size="small"
                sx={{ mr: 0.5, mb: 0.5 }}
              />
            ))}
            {stats.models.size === 0 && '—'}
          </StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>Active window</StatLabel>
          <StatValue style={{ fontSize: 16 }}>
            {activeWindow ? activeWindow.range : '—'}
          </StatValue>
          <StatSub>{activeWindow ? `${activeWindow.span} span` : ''}</StatSub>
        </StatCard>
      </StatsRow>

      <AdoPanel>
        <strong>ADO context for this day:</strong>{' '}
        {!projectId
          ? '(no workspace project selected — pick one on Home to enable correlation)'
          : adoError
            ? '(failed to load — check ADO connection)'
            : adoLoading
              ? 'Loading…'
              : adoItems.length === 0
                ? 'No work items you changed on this date.'
                : `${adoItems.length} item${adoItems.length === 1 ? '' : 's'} will be included in the summary.`}
        {adoItems.length > 0 && (
          <div style={{ marginTop: 8 }}>
            {adoItems.slice(0, 5).map((it) => (
              <AdoItem key={it.id}>
                <AdoId>#{it.id}</AdoId>
                <span style={{ color: '#888' }}>{it.workItemType}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {it.title}
                </span>
                <span style={{ color: '#888', fontSize: 11, marginLeft: 'auto' }}>
                  {it.state}
                </span>
              </AdoItem>
            ))}
            {adoItems.length > 5 && (
              <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
                + {adoItems.length - 5} more
              </div>
            )}
          </div>
        )}
      </AdoPanel>

      <Scroll>
        {markdown ? (
          <Card>
            <ReactMarkdown>{markdown}</ReactMarkdown>
          </Card>
        ) : (
          <p style={{ color: '#888' }}>
            {generating ? (
              <>Working… each session is summarized in parallel, then merged into a single narrative.</>
            ) : (
              <>
                No summary for this date yet. Click <strong>Generate Summary</strong> to summarize all your Claude sessions from {date}.
              </>
            )}
          </p>
        )}
      </Scroll>
    </Container>
  )
}
