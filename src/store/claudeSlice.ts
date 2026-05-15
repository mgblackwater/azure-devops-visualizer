import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { IPC } from '@shared/contract'
import type {
  ListSessionsArgs,
  SessionDetail,
  SessionMeta,
  StatsBucket
} from '@shared/claudeTypes'

type LoadingFlags = {
  index: boolean
  detail: boolean
  summary: boolean
  journal: boolean
  stats: boolean
}

export type ClaudeState = {
  sessions: SessionMeta[]
  selectedSessionId: string | null
  selectedSession: SessionDetail | null
  summaries: Record<string, string>
  stats: StatsBucket[]
  journals: Record<string, string>
  journalUi: { selectedDate: string; isGenerating: boolean }
  cliAvailable: boolean | null
  loading: LoadingFlags
  error: string | null
}

function todayLocalISO(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const initialState: ClaudeState = {
  sessions: [],
  selectedSessionId: null,
  selectedSession: null,
  summaries: {},
  stats: [],
  journals: {},
  journalUi: { selectedDate: todayLocalISO(), isGenerating: false },
  cliAvailable: null,
  loading: {
    index: false,
    detail: false,
    summary: false,
    journal: false,
    stats: false
  },
  error: null
}

export const rescanIndex = createAsyncThunk('claude/rescanIndex', async () => {
  return window.ado.invoke(IPC.ClaudeRescanIndex, {})
})

export const fetchSessions = createAsyncThunk(
  'claude/fetchSessions',
  async (args: ListSessionsArgs) => {
    return window.ado.invoke(IPC.ClaudeListSessions, args)
  }
)

export const checkCliAvailable = createAsyncThunk(
  'claude/checkCliAvailable',
  async () => window.ado.invoke(IPC.ClaudeCliAvailable, {})
)

export const fetchSessionDetail = createAsyncThunk(
  'claude/fetchSessionDetail',
  async (id: string) => window.ado.invoke(IPC.ClaudeGetSession, { id })
)

export const fetchStats = createAsyncThunk(
  'claude/fetchStats',
  async (args: { rangeStart: string; rangeEnd: string }) =>
    window.ado.invoke(IPC.ClaudeGetStats, args)
)

export const summarizeSession = createAsyncThunk(
  'claude/summarizeSession',
  async (args: { id: string; force?: boolean }) =>
    window.ado.invoke(IPC.ClaudeSummarizeSession, args)
)

export const generateJournal = createAsyncThunk(
  'claude/generateJournal',
  async (args: {
    date: string
    adoItems: import('@shared/claudeTypes').AdoItemRef[]
    force?: boolean
  }) => window.ado.invoke(IPC.ClaudeGenerateJournal, args)
)

const slice = createSlice({
  name: 'claude',
  initialState,
  reducers: {
    setSessions(state, a: PayloadAction<SessionMeta[]>) {
      state.sessions = a.payload
    },
    setSelectedSession(state, a: PayloadAction<SessionDetail | null>) {
      state.selectedSession = a.payload
      state.selectedSessionId = a.payload?.meta.id ?? null
    },
    setSummary(
      state,
      a: PayloadAction<{ sessionId: string; markdown: string }>
    ) {
      state.summaries[a.payload.sessionId] = a.payload.markdown
    },
    setStats(state, a: PayloadAction<StatsBucket[]>) {
      state.stats = a.payload
    },
    setJournal(state, a: PayloadAction<{ date: string; markdown: string }>) {
      state.journals[a.payload.date] = a.payload.markdown
    },
    setSelectedDate(state, a: PayloadAction<string>) {
      state.journalUi.selectedDate = a.payload
    },
    setLoading(state, a: PayloadAction<Partial<LoadingFlags>>) {
      state.loading = { ...state.loading, ...a.payload }
    },
    setCliAvailable(state, a: PayloadAction<boolean>) {
      state.cliAvailable = a.payload
    },
    setError(state, a: PayloadAction<string | null>) {
      state.error = a.payload
    }
  },
  extraReducers: (builder) => {
    builder
      .addCase(rescanIndex.pending, (s) => {
        s.loading.index = true
      })
      .addCase(rescanIndex.fulfilled, (s) => {
        s.loading.index = false
      })
      .addCase(rescanIndex.rejected, (s, a) => {
        s.loading.index = false
        s.error = a.error.message ?? 'Rescan failed'
      })
      .addCase(fetchSessions.pending, (s) => {
        s.loading.index = true
      })
      .addCase(fetchSessions.fulfilled, (s, a) => {
        s.loading.index = false
        s.sessions = a.payload
      })
      .addCase(fetchSessions.rejected, (s, a) => {
        s.loading.index = false
        s.error = a.error.message ?? 'List failed'
      })
      .addCase(checkCliAvailable.fulfilled, (s, a) => {
        s.cliAvailable = a.payload.available
      })
      .addCase(fetchSessionDetail.pending, (s) => {
        s.loading.detail = true
        s.selectedSession = null
      })
      .addCase(fetchSessionDetail.fulfilled, (s, a) => {
        s.loading.detail = false
        s.selectedSession = a.payload
        s.selectedSessionId = a.payload.meta.id
      })
      .addCase(fetchSessionDetail.rejected, (s, a) => {
        s.loading.detail = false
        s.error = a.error.message ?? 'Load failed'
      })
      .addCase(fetchStats.pending, (s) => {
        s.loading.stats = true
      })
      .addCase(fetchStats.fulfilled, (s, a) => {
        s.loading.stats = false
        s.stats = a.payload
      })
      .addCase(fetchStats.rejected, (s, a) => {
        s.loading.stats = false
        s.error = a.error.message ?? 'Stats failed'
      })
      .addCase(summarizeSession.pending, (s) => {
        s.loading.summary = true
      })
      .addCase(summarizeSession.fulfilled, (s, a) => {
        s.loading.summary = false
        const id = (a.meta.arg as { id: string }).id
        s.summaries[id] = a.payload.markdown
      })
      .addCase(summarizeSession.rejected, (s, a) => {
        s.loading.summary = false
        s.error = a.error.message ?? 'Summarize failed'
      })
      .addCase(generateJournal.pending, (s) => {
        s.journalUi.isGenerating = true
        s.loading.journal = true
      })
      .addCase(generateJournal.fulfilled, (s, a) => {
        s.journalUi.isGenerating = false
        s.loading.journal = false
        const date = (a.meta.arg as { date: string }).date
        s.journals[date] = a.payload.markdown
      })
      .addCase(generateJournal.rejected, (s, a) => {
        s.journalUi.isGenerating = false
        s.loading.journal = false
        s.error = a.error.message ?? 'Journal generation failed'
      })
  }
})

export const claudeActions = slice.actions
export default slice.reducer
