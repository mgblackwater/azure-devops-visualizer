import { useEffect, useMemo, useState } from 'react'
import styled from '@emotion/styled'
import { Alert, TextField } from '@mui/material'
import { useAppDispatch, useAppSelector } from '../store'
import { fetchStats } from '../store/claudeSlice'
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
  overflow-y: auto;
`

const Toolbar = styled.div`
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
`

const Cards = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin: 16px 0 24px;
`

const Card = styled.div`
  padding: 16px;
  background: ${({ theme }) => theme.palette.background.paper};
  border: 1px solid ${({ theme }) => theme.palette.divider};
  border-radius: 8px;
`

const CardLabel = styled.div`
  font-size: 11px;
  color: ${({ theme }) => theme.palette.text.secondary};
  text-transform: uppercase;
  letter-spacing: 0.5px;
`

const CardValue = styled.div`
  font-size: 22px;
  margin-top: 6px;
  color: ${({ theme }) => theme.palette.text.primary};
`

const BarRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0;
`

const DateLabel = styled.span`
  width: 100px;
  color: ${({ theme }) => theme.palette.text.secondary};
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
`

const Bar = styled.div<{ width: number; color: string }>`
  width: ${(p) => p.width}px;
  height: 18px;
  background: ${(p) => p.color};
  display: inline-block;
`

const MODEL_COLORS: Record<string, string> = {
  opus: '#a070ff',
  sonnet: '#5ca0ff',
  haiku: '#5cc8c8'
}

function colorFor(model: string): string {
  if (model.includes('opus')) return MODEL_COLORS.opus
  if (model.includes('sonnet')) return MODEL_COLORS.sonnet
  if (model.includes('haiku')) return MODEL_COLORS.haiku
  return '#888'
}

function localISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function ClaudeStatsPage(): JSX.Element {
  const dispatch = useAppDispatch()
  const buckets = useAppSelector((s) => s.claude.stats)
  const loading = useAppSelector((s) => s.claude.loading.stats)

  const today = new Date()
  const monthAgo = new Date(today.getTime() - 30 * 86400000)
  const [rangeStart, setRangeStart] = useState(localISO(monthAgo))
  const [rangeEnd, setRangeEnd] = useState(localISO(today))

  useEffect(() => {
    void dispatch(fetchStats({ rangeStart, rangeEnd }))
  }, [dispatch, rangeStart, rangeEnd])

  const totals = useMemo(() => {
    const t = {
      sessions: 0,
      turns: 0,
      output: 0,
      input: 0,
      cacheR: 0,
      cacheW: 0,
      cost: 0
    }
    for (const b of buckets) {
      t.sessions += b.sessions
      t.turns += b.turns
      t.output += b.usage.outputTokens
      t.input += b.usage.inputTokens
      t.cacheR += b.usage.cacheReadTokens
      t.cacheW += b.usage.cacheCreateTokens
      t.cost += b.usage.apiEquivalentUsd
    }
    return t
  }, [buckets])

  // Cache hit ratio: of all input-side tokens (fresh input + cache writes +
  // cache reads), what fraction was served from cache? Higher = better
  // prompt-cache reuse. Above ~80% is excellent.
  const cacheHitRatio = useMemo(() => {
    const inputSide = totals.input + totals.cacheR + totals.cacheW
    if (inputSide === 0) return null
    return totals.cacheR / inputSide
  }, [totals])

  const byDate = useMemo(() => {
    const m = new Map<
      string,
      { date: string; segs: { model: string; cost: number }[] }
    >()
    for (const b of buckets) {
      let row = m.get(b.date)
      if (!row) {
        row = { date: b.date, segs: [] }
        m.set(b.date, row)
      }
      row.segs.push({ model: b.model, cost: b.usage.apiEquivalentUsd })
    }
    return [...m.values()].sort((a, b) => a.date.localeCompare(b.date))
  }, [buckets])

  // 320px is the max bar width; everything else is proportional.
  const maxCost = Math.max(
    0.0001,
    ...byDate.map((r) => r.segs.reduce((s, x) => s + x.cost, 0))
  )

  return (
    <Container>
      <ClaudeSubNav />
      <h2 style={{ margin: '0 0 12px' }}>Stats</h2>
      <Alert severity="info" sx={{ mb: 2 }}>
        $ figures are <strong>API-equivalent cost</strong> — what these tokens would cost on the pure API, not your actual subscription bill.
      </Alert>

      <Toolbar>
        <TextField
          type="date"
          size="small"
          label="From"
          InputLabelProps={{ shrink: true }}
          value={rangeStart}
          onChange={(e) => setRangeStart(e.target.value)}
        />
        <TextField
          type="date"
          size="small"
          label="To"
          InputLabelProps={{ shrink: true }}
          value={rangeEnd}
          onChange={(e) => setRangeEnd(e.target.value)}
        />
        {loading && <span style={{ color: '#888' }}>Loading…</span>}
      </Toolbar>

      <Cards>
        <Card>
          <CardLabel>Sessions</CardLabel>
          <CardValue>{totals.sessions}</CardValue>
        </Card>
        <Card>
          <CardLabel>Turns</CardLabel>
          <CardValue>{totals.turns}</CardValue>
        </Card>
        <Card>
          <CardLabel>Output tokens</CardLabel>
          <CardValue>{(totals.output / 1_000_000).toFixed(1)}M</CardValue>
        </Card>
        <Card>
          <CardLabel>API-equivalent $</CardLabel>
          <CardValue>${totals.cost.toFixed(2)}</CardValue>
        </Card>
        <Card>
          <CardLabel>Cache hit ratio</CardLabel>
          <CardValue>
            {cacheHitRatio === null ? '—' : `${(cacheHitRatio * 100).toFixed(1)}%`}
          </CardValue>
          <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
            of input-side tokens
          </div>
        </Card>
      </Cards>

      <h3>Daily cost by model</h3>
      {byDate.length === 0 && !loading && (
        <p style={{ color: '#888' }}>
          No data in this range. Refresh the index on the Sessions page if you haven't yet.
        </p>
      )}
      {byDate.map((row) => {
        const total = row.segs.reduce((s, x) => s + x.cost, 0)
        return (
          <BarRow key={row.date}>
            <DateLabel>{row.date}</DateLabel>
            {row.segs.map((s, i) => (
              <Bar
                key={i}
                width={Math.max(2, (s.cost / maxCost) * 320)}
                color={colorFor(s.model)}
                title={`${s.model}: $${s.cost.toFixed(2)}`}
              />
            ))}
            <span style={{ color: '#888', fontSize: 12, marginLeft: 8 }}>
              ${total.toFixed(2)}
            </span>
          </BarRow>
        )
      })}

      <div style={{ marginTop: 24, display: 'flex', gap: 16, fontSize: 12, color: '#888' }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: MODEL_COLORS.opus, marginRight: 6 }} />Opus</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: MODEL_COLORS.sonnet, marginRight: 6 }} />Sonnet</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, background: MODEL_COLORS.haiku, marginRight: 6 }} />Haiku</span>
      </div>
    </Container>
  )
}
