import { memo } from 'react'
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
  const typeColor = colorForType(data.type)
  const stateColor = colorForState(data.state)
  const accentFg = readableTextColor(typeColor)
  const initial = TYPE_INITIAL[data.type] ?? data.type.slice(0, 1).toUpperCase()

  return (
    <div
      style={{
        position: 'relative',
        background: '#FFFFFF',
        border: data.isFocused ? `2px solid ${typeColor}` : '1px solid #E0E3E7',
        borderLeft: `4px solid ${typeColor}`,
        borderRadius: 8,
        width: 240,
        fontFamily: 'inherit',
        fontSize: 12,
        boxShadow: data.isFocused
          ? `0 0 0 3px ${typeColor}33, 0 4px 12px rgba(0,0,0,0.12)`
          : '0 1px 2px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.06)',
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
        <span style={{ color: '#5F6368', fontWeight: 600, fontSize: 11 }}>
          #{data.id}
        </span>
        <span
          style={{
            color: '#5F6368',
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
              background: data.collapsed ? '#FFE082' : '#E8EAED',
              color: '#3C4043',
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
          color: '#202124',
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
          color: '#5F6368'
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
              border: '1px solid rgba(0,0,0,0.08)'
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
            background: data.assignee ? '#1A73E8' : '#E0E3E7',
            color: data.assignee ? 'white' : '#5F6368',
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
