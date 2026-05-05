import { memo } from 'react'
import { useTheme } from '@mui/material'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { colorForState, colorForType, readableTextColor } from '@/utils/adoColors'

export interface WorkItemNodeData extends Record<string, unknown> {
  id: number
  title: string
  type: string
  state: string
  assignee?: string
  priority?: number | null
  childCount?: number
  collapsed?: boolean
  /** When true, draw the node with a thicker border / glow to mark it as the focused root. */
  isFocused?: boolean
}

const TYPE_INITIAL: Record<string, string> = {
  Epic: 'E',
  Feature: 'F',
  'User Story': 'S',
  'Product Backlog Item': 'P',
  Task: 'T',
  Bug: 'B',
  Defect: 'D',
  Issue: 'I',
  Impediment: 'I',
  'Test Case': 'T',
  Requirement: 'R'
}

function initials(name?: string): string {
  if (!name) return '?'
  const parts = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function priorityColor(priority?: number | null): string {
  switch (priority) {
    case 1:
      return '#D93025'
    case 2:
      return '#F29900'
    case 3:
      return '#188038'
    case 4:
      return '#5F6368'
    default:
      return '#9AA0A6'
  }
}

function WorkItemNodeImpl(props: NodeProps): JSX.Element {
  const data = props.data as unknown as WorkItemNodeData
  const muiTheme = useTheme()
  const isDark = muiTheme.palette.mode === 'dark'

  const typeColor = colorForType(data.type)
  const stateColor = colorForState(data.state)
  const accentFg = readableTextColor(typeColor)
  const initial = TYPE_INITIAL[data.type] ?? data.type.slice(0, 1).toUpperCase()

  // The work-item card is rendered with inline styles so it lives outside
  // the MUI sx system; resolve every surface, border, and text colour from
  // the active theme so the node looks at home on both light and dark
  // ReactFlow panes.
  const surface = muiTheme.palette.background.paper
  const subtleBorder = isDark ? 'rgba(255,255,255,0.12)' : '#E0E3E7'
  const titleColor = muiTheme.palette.text.primary
  const metaColor = muiTheme.palette.text.secondary
  const childChipBg = data.collapsed
    ? isDark
      ? '#5C4A1F'
      : '#FFE082'
    : isDark
      ? 'rgba(255,255,255,0.10)'
      : '#E8EAED'
  const childChipFg = data.collapsed
    ? isDark
      ? '#FFE082'
      : '#3C4043'
    : muiTheme.palette.text.primary
  const stateRingBorder = isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.08)'
  const avatarUnassignedBg = isDark ? 'rgba(255,255,255,0.12)' : '#E0E3E7'
  const avatarUnassignedFg = metaColor
  const focusShadow = isDark
    ? `0 0 0 3px ${typeColor}55, 0 4px 14px rgba(0,0,0,0.6)`
    : `0 0 0 3px ${typeColor}33, 0 4px 12px rgba(0,0,0,0.12)`
  const restingShadow = isDark
    ? '0 1px 2px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.5)'
    : '0 1px 2px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.06)'

  return (
    <div
      style={{
        position: 'relative',
        background: surface,
        border: data.isFocused ? `2px solid ${typeColor}` : `1px solid ${subtleBorder}`,
        borderLeft: `4px solid ${typeColor}`,
        borderRadius: 8,
        width: 240,
        fontFamily: 'inherit',
        fontSize: 12,
        boxShadow: data.isFocused ? focusShadow : restingShadow,
        overflow: 'hidden',
        userSelect: 'none'
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        style={{ background: typeColor, border: 'none', width: 6, height: 6 }}
      />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 8px 0 8px'
        }}
      >
        <span
          aria-label={data.type}
          title={data.type}
          style={{
            background: typeColor,
            color: accentFg,
            width: 18,
            height: 18,
            borderRadius: 4,
            fontWeight: 700,
            fontSize: 11,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0
          }}
        >
          {initial}
        </span>
        <span style={{ color: metaColor, fontWeight: 600, fontSize: 11 }}>
          #{data.id}
        </span>
        <span
          style={{
            color: metaColor,
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: 0.4,
            flex: 1,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis'
          }}
        >
          {data.type}
        </span>
        {data.childCount && data.childCount > 0 ? (
          <span
            title={`${data.childCount} child item${data.childCount === 1 ? '' : 's'}${
              data.collapsed ? ' (collapsed)' : ''
            }`}
            style={{
              background: childChipBg,
              color: childChipFg,
              fontSize: 10,
              fontWeight: 700,
              padding: '0 5px',
              borderRadius: 8,
              minWidth: 18,
              textAlign: 'center',
              lineHeight: '14px'
            }}
          >
            {data.collapsed ? `+${data.childCount}` : data.childCount}
          </span>
        ) : null}
      </div>

      <div
        style={{
          padding: '4px 8px 8px 8px',
          fontWeight: 600,
          color: titleColor,
          lineHeight: 1.3,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden'
        }}
      >
        {data.title}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 8px 8px 8px',
          color: metaColor
        }}
      >
        <span
          aria-label={`State: ${data.state}`}
          title={`State: ${data.state}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            fontWeight: 500
          }}
        >
          <span
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: stateColor,
              border: `1px solid ${stateRingBorder}`
            }}
          />
          {data.state}
        </span>
        {data.priority != null ? (
          <span
            title={`Priority ${data.priority}`}
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: 'white',
              background: priorityColor(data.priority),
              borderRadius: 4,
              padding: '1px 5px'
            }}
          >
            P{data.priority}
          </span>
        ) : null}
        <span
          title={data.assignee ?? 'Unassigned'}
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: '50%',
            background: data.assignee ? '#1A73E8' : avatarUnassignedBg,
            color: data.assignee ? 'white' : avatarUnassignedFg,
            fontSize: 10,
            fontWeight: 700
          }}
        >
          {initials(data.assignee)}
        </span>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        style={{ background: typeColor, border: 'none', width: 6, height: 6 }}
      />
    </div>
  )
}

export const WorkItemNode = memo(WorkItemNodeImpl)
