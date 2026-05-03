import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography
} from '@mui/material'
import { useListSavedQueriesQuery } from '@/store/api/adoApi'
import { useAppDispatch, useAppSelector } from '@/store'
import { setSource } from '@/store/workspaceSlice'
import type { AdoSavedQuery } from '@shared/adoTypes'

interface FlatQueryNode {
  id: string
  name: string
  path: string
  depth: number
}

function flattenQueries(nodes: AdoSavedQuery[] | undefined, depth = 0): FlatQueryNode[] {
  if (!nodes) return []
  const out: FlatQueryNode[] = []
  for (const node of nodes) {
    if (!node.isFolder) {
      out.push({ id: node.id, name: node.name, path: node.path, depth })
    }
    if (node.children && node.children.length > 0) {
      out.push(...flattenQueries(node.children, depth + 1))
    }
  }
  return out
}

const STARTER_WIQLS: { label: string; wiql: string }[] = [
  {
    label: 'Active items in current iteration',
    wiql:
      "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.IterationPath] = @currentIteration AND [System.State] <> 'Removed'"
  },
  {
    label: 'My open work items',
    wiql:
      "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @me AND [System.State] <> 'Closed' AND [System.State] <> 'Done' AND [System.State] <> 'Removed'"
  },
  {
    label: 'Bugs in last 30 days',
    wiql:
      "SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Bug' AND [System.CreatedDate] >= @today - 30"
  },
  {
    label: 'All Features and child items (tree)',
    wiql:
      "SELECT [System.Id] FROM WorkItemLinks WHERE ([Source].[System.WorkItemType] = 'Feature') AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward') MODE (Recursive)"
  }
]

export default function QueryPicker(): JSX.Element {
  const { projectId, source } = useAppSelector((s) => s.workspace)
  const dispatch = useAppDispatch()
  const [mode, setMode] = useState<'savedQuery' | 'wiql'>(
    source?.kind === 'wiql' ? 'wiql' : 'savedQuery'
  )
  const [wiql, setWiql] = useState(
    source?.kind === 'wiql' ? source.wiql : STARTER_WIQLS[0].wiql
  )

  const { data: queries, isLoading, error } = useListSavedQueriesQuery(
    projectId ? { projectId, depth: 2 } : (undefined as never),
    { skip: !projectId }
  )

  const flat = useMemo(() => flattenQueries(queries), [queries])

  if (!projectId) {
    return (
      <Alert severity="info">Select a project first to choose a query source.</Alert>
    )
  }

  return (
    <Stack spacing={2}>
      <ToggleButtonGroup
        size="small"
        exclusive
        value={mode}
        onChange={(_e, value: 'savedQuery' | 'wiql' | null) => value && setMode(value)}
      >
        <ToggleButton value="savedQuery">Saved query</ToggleButton>
        <ToggleButton value="wiql">WIQL</ToggleButton>
      </ToggleButtonGroup>

      {mode === 'savedQuery' && (
        <>
          {isLoading && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={16} />
              <Typography variant="body2">Loading saved queries…</Typography>
            </Box>
          )}
          {error != null && (
            <Alert severity="error">Failed to load saved queries.</Alert>
          )}
          {!isLoading && flat.length === 0 && !error && (
            <Alert severity="warning">No saved queries found in this project.</Alert>
          )}
          {flat.length > 0 && (
            <FormControl fullWidth size="small">
              <InputLabel id="saved-query-label">Saved query</InputLabel>
              <Select
                labelId="saved-query-label"
                label="Saved query"
                value={source?.kind === 'savedQuery' ? source.queryId : ''}
                onChange={(e) => {
                  const q = flat.find((x) => x.id === e.target.value)
                  if (!q) return
                  dispatch(
                    setSource({ kind: 'savedQuery', queryId: q.id, queryName: q.name })
                  )
                }}
              >
                {flat.map((q) => (
                  <MenuItem key={q.id} value={q.id}>
                    {`${'\u00a0'.repeat(q.depth * 2)}${q.name}`}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          )}
        </>
      )}

      {mode === 'wiql' && (
        <>
          <FormControl fullWidth size="small">
            <InputLabel id="starter-wiql-label">Starter WIQL</InputLabel>
            <Select
              labelId="starter-wiql-label"
              label="Starter WIQL"
              value=""
              onChange={(e) => {
                const found = STARTER_WIQLS.find((s) => s.label === e.target.value)
                if (found) setWiql(found.wiql)
              }}
            >
              {STARTER_WIQLS.map((s) => (
                <MenuItem key={s.label} value={s.label}>
                  {s.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            label="WIQL"
            multiline
            minRows={6}
            value={wiql}
            onChange={(e) => setWiql(e.target.value)}
            fullWidth
            slotProps={{
              input: {
                style: { fontFamily: 'Menlo, Consolas, monospace', fontSize: 13 }
              }
            }}
          />
          <Divider />
          <Button
            variant="contained"
            onClick={() =>
              dispatch(setSource({ kind: 'wiql', wiql, label: 'Custom WIQL' }))
            }
            disabled={!wiql.trim()}
          >
            Use this WIQL
          </Button>
        </>
      )}
    </Stack>
  )
}
