import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import styled from '@emotion/styled'
import { Button, Chip, ToggleButton, ToggleButtonGroup } from '@mui/material'
import { alpha } from '@mui/material/styles'
import ReactMarkdown from 'react-markdown'
import { useAppDispatch, useAppSelector } from '../store'
import { fetchSessionDetail, summarizeSession } from '../store/claudeSlice'

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

const Scroll = styled.div`
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding-right: 8px;
`

const Inner = styled.div`
  width: 100%;
`

const BackLink = styled(Link)`
  color: ${({ theme }) => theme.palette.text.secondary};
  text-decoration: none;
  font-size: 13px;
  &:hover {
    color: ${({ theme }) => theme.palette.text.primary};
    text-decoration: underline;
  }
`

const Header = styled.div`
  margin: 12px 0 16px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
`

const HeaderText = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
`

const HeaderActions = styled.div`
  display: flex;
  gap: 8px;
  margin-left: auto;
  flex-shrink: 0;
`

const SubMeta = styled.span`
  color: ${({ theme }) => theme.palette.text.secondary};
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
`

const StatsRow = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 20px;
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
  font-size: 18px;
  margin-top: 4px;
  color: ${({ theme }) => theme.palette.text.primary};
`

const StatSub = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.palette.text.secondary};
  margin-top: 4px;
`

const SummaryCard = styled.div`
  background: ${({ theme }) => theme.palette.background.paper};
  border: 1px solid ${({ theme }) => theme.palette.divider};
  padding: 16px;
  border-radius: 8px;
  margin-bottom: 24px;
  color: ${({ theme }) => theme.palette.text.primary};
`

const SummaryHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
  flex-wrap: wrap;
`

const RawBlock = styled.pre`
  background: ${({ theme }) =>
    theme.palette.mode === 'dark'
      ? 'rgba(0, 0, 0, 0.3)'
      : 'rgba(0, 0, 0, 0.04)'};
  color: ${({ theme }) => theme.palette.text.primary};
  padding: 12px;
  border-radius: 6px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
`

const TranscriptDetails = styled.details`
  margin-top: 8px;

  > summary {
    cursor: pointer;
    user-select: none;
    padding: 10px 14px;
    background: ${({ theme }) => theme.palette.background.paper};
    border: 1px solid ${({ theme }) => theme.palette.divider};
    border-radius: 8px;
    color: ${({ theme }) => theme.palette.text.primary};
    font-size: 13px;
    list-style: none;
  }
  > summary::-webkit-details-marker {
    display: none;
  }
  > summary::before {
    content: '▶ ';
    display: inline-block;
    margin-right: 6px;
    transition: transform 120ms;
  }
  &[open] > summary::before {
    content: '▼ ';
  }
`

const TurnList = styled.div`
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
`

const TurnRow = styled.div<{ role: 'user' | 'assistant' }>`
  display: flex;
  justify-content: ${(p) => (p.role === 'user' ? 'flex-end' : 'flex-start')};
`

const Bubble = styled.div<{ role: 'user' | 'assistant' }>`
  max-width: 75%;
  min-width: 0;
  padding: 10px 14px;
  border-radius: 14px;
  background: ${({ role, theme }) =>
    role === 'user'
      ? alpha(theme.palette.primary.main, 0.14)
      : theme.palette.background.paper};
  border: 1px solid
    ${({ role, theme }) =>
      role === 'user'
        ? alpha(theme.palette.primary.main, 0.4)
        : theme.palette.divider};
  color: ${({ theme }) => theme.palette.text.primary};
  border-${({ role }) => (role === 'user' ? 'top-right' : 'top-left')}-radius: 4px;
`

const Role = styled.div`
  font-size: 10px;
  color: ${({ theme }) => theme.palette.text.secondary};
  margin-bottom: 4px;
  letter-spacing: 0.4px;
`

const TextBlock = styled.div`
  white-space: pre-wrap;
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
`

const ToolBlock = styled.details`
  margin: 6px 0;
  padding: 4px 8px;
  background: ${({ theme }) =>
    theme.palette.mode === 'dark'
      ? 'rgba(0, 0, 0, 0.3)'
      : 'rgba(0, 0, 0, 0.05)'};
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  color: ${({ theme }) => theme.palette.text.secondary};

  summary {
    cursor: pointer;
    user-select: none;
  }

  pre {
    margin: 6px 0 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
`

type ViewMode = 'rendered' | 'raw'

function hasVisibleContent(turn: {
  content: { type: string; text?: string }[]
}): boolean {
  return turn.content.some((b) => {
    if (b.type === 'text') return (b.text ?? '').trim().length > 0
    return true // tool_use / tool_result always counted as visible
  })
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function shortModel(m: string): string {
  const p = m.split('-')
  return p.slice(1, 3).join('-') || m
}

function formatSpan(startedAt: string, endedAt: string): string {
  if (!startedAt || !endedAt) return ''
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime()
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export default function ClaudeSessionDetailPage(): JSX.Element {
  const { id } = useParams()
  const dispatch = useAppDispatch()
  const detail = useAppSelector((s) => s.claude.selectedSession)
  const loading = useAppSelector((s) => s.claude.loading.detail)
  const summarizing = useAppSelector((s) => s.claude.loading.summary)
  const cliAvailable = useAppSelector((s) => s.claude.cliAvailable)
  const summary = useAppSelector((s) => (id ? s.claude.summaries[id] : undefined))
  const [summaryView, setSummaryView] = useState<ViewMode>('rendered')

  useEffect(() => {
    if (id) void dispatch(fetchSessionDetail(id))
  }, [dispatch, id])

  if (loading) {
    return (
      <Container>
        <BackLink to="/claude/sessions">← All sessions</BackLink>
        <p style={{ marginTop: 16 }}>Loading…</p>
      </Container>
    )
  }

  if (!detail) {
    return (
      <Container>
        <BackLink to="/claude/sessions">← All sessions</BackLink>
        <p style={{ marginTop: 16 }}>Session not found.</p>
      </Container>
    )
  }

  const visibleTurns = detail.turns.filter(hasVisibleContent)

  const m = detail.meta
  const inputSide =
    m.usage.inputTokens + m.usage.cacheReadTokens + m.usage.cacheCreateTokens
  const cacheHitPct =
    inputSide > 0 ? ((m.usage.cacheReadTokens / inputSide) * 100).toFixed(1) : null
  const span = formatSpan(m.startedAt, m.endedAt)
  const resumeCmd = `cd "${m.cwd}" && claude --resume ${m.id}`

  return (
    <Container>
      <BackLink to="/claude/sessions">← All sessions</BackLink>
      <Header>
        <HeaderText>
          <h2 style={{ margin: '6px 0 0' }}>{m.projectKey}</h2>
          <SubMeta>
            {m.cwd}
            {m.gitBranch ? `  ·  branch: ${m.gitBranch}` : ''}
          </SubMeta>
        </HeaderText>
        <HeaderActions>
          <Button
            size="small"
            variant="outlined"
            onClick={() => navigator.clipboard.writeText(resumeCmd)}
            title={resumeCmd}
          >
            Copy resume command
          </Button>
          <Button
            size="small"
            variant="text"
            onClick={() => navigator.clipboard.writeText(m.id)}
          >
            Copy session ID
          </Button>
        </HeaderActions>
      </Header>

      <StatsRow>
        <StatCard>
          <StatLabel>Started</StatLabel>
          <StatValue style={{ fontSize: 14 }}>
            {new Date(m.startedAt).toLocaleString()}
          </StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>Last activity</StatLabel>
          <StatValue style={{ fontSize: 14 }}>
            {m.endedAt ? new Date(m.endedAt).toLocaleString() : '—'}
          </StatValue>
          {span && <StatSub>{span} span</StatSub>}
        </StatCard>
        <StatCard>
          <StatLabel>Turns</StatLabel>
          <StatValue>{m.turnCount}</StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>Output tokens</StatLabel>
          <StatValue>{formatTokens(m.usage.outputTokens)}</StatValue>
          <StatSub>cache reads {formatTokens(m.usage.cacheReadTokens)}</StatSub>
        </StatCard>
        <StatCard>
          <StatLabel>API-equivalent</StatLabel>
          <StatValue>${m.usage.apiEquivalentUsd.toFixed(2)}</StatValue>
        </StatCard>
        <StatCard>
          <StatLabel>Cache hit ratio</StatLabel>
          <StatValue>{cacheHitPct === null ? '—' : `${cacheHitPct}%`}</StatValue>
          <StatSub>of input-side</StatSub>
        </StatCard>
        <StatCard>
          <StatLabel>Models</StatLabel>
          <StatValue style={{ fontSize: 13, marginTop: 8 }}>
            {m.models.map((mm) => (
              <Chip
                key={mm}
                label={shortModel(mm)}
                size="small"
                sx={{ mr: 0.5, mb: 0.5 }}
              />
            ))}
            {m.models.length === 0 && '—'}
          </StatValue>
        </StatCard>
      </StatsRow>

      <Scroll>
        <Inner>
          <SummaryCard>
            <SummaryHeader>
              <strong>Summary</strong>
              <Button
                size="small"
                variant="outlined"
                disabled={summarizing || cliAvailable === false}
                title={
                  cliAvailable === false
                    ? 'Claude CLI not found on PATH'
                    : undefined
                }
                onClick={() => {
                  if (!id) return
                  void dispatch(summarizeSession({ id, force: !!summary }))
                }}
              >
                {summarizing
                  ? 'Summarizing…'
                  : summary
                    ? 'Regenerate'
                    : 'Summarize'}
              </Button>
              {summary && (
                <>
                  <Button
                    size="small"
                    variant="text"
                    onClick={() => navigator.clipboard.writeText(summary)}
                  >
                    Copy
                  </Button>
                  <ToggleButtonGroup
                    size="small"
                    exclusive
                    value={summaryView}
                    onChange={(_, v) => v && setSummaryView(v as ViewMode)}
                    sx={{ marginLeft: 'auto' }}
                  >
                    <ToggleButton value="rendered">Rendered</ToggleButton>
                    <ToggleButton value="raw">Raw</ToggleButton>
                  </ToggleButtonGroup>
                </>
              )}
            </SummaryHeader>
            {summary ? (
              summaryView === 'rendered' ? (
                <ReactMarkdown>{summary}</ReactMarkdown>
              ) : (
                <RawBlock>{summary}</RawBlock>
              )
            ) : (
              <p style={{ color: '#888', margin: 0 }}>
                No summary yet. Click <strong>Summarize</strong> to generate one.
              </p>
            )}
          </SummaryCard>

          <TranscriptDetails>
            <summary>
              Show conversation ({visibleTurns.length}
              {visibleTurns.length === 1 ? ' turn' : ' turns'})
            </summary>
            <TurnList>
              {visibleTurns.map((t, i) => (
                <TurnRow key={i} role={t.role}>
                  <Bubble role={t.role}>
                    <Role>
                      {t.role.toUpperCase()}
                      {t.timestamp ? ` · ${new Date(t.timestamp).toLocaleTimeString()}` : ''}
                    </Role>
                    {t.content.map((b, j) => {
                      if (b.type === 'text') {
                        return <TextBlock key={j}>{b.text}</TextBlock>
                      }
                      if (b.type === 'tool_use') {
                        return (
                          <ToolBlock key={j}>
                            <summary>🔧 {b.name}</summary>
                            <pre>{JSON.stringify(b.input, null, 2)}</pre>
                          </ToolBlock>
                        )
                      }
                      if (b.type === 'tool_result') {
                        return (
                          <ToolBlock key={j}>
                            <summary>↳ tool result{b.is_error ? ' (error)' : ''}</summary>
                            <pre>{b.content}</pre>
                          </ToolBlock>
                        )
                      }
                      return null
                    })}
                  </Bubble>
                </TurnRow>
              ))}
            </TurnList>
          </TranscriptDetails>
        </Inner>
      </Scroll>
    </Container>
  )
}
