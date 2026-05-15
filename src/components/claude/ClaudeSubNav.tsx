import { NavLink } from 'react-router-dom'
import styled from '@emotion/styled'
import { useAppSelector } from '../../store'
import ClaudeErrorToast from './ClaudeErrorToast'

const Nav = styled.nav`
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
  border-bottom: 1px solid ${({ theme }) => theme.palette.divider};
`

const Tab = styled(NavLink)`
  padding: 8px 16px;
  color: ${({ theme }) => theme.palette.text.secondary};
  text-decoration: none;
  border-bottom: 2px solid transparent;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: color 120ms, border-color 120ms;

  &:hover {
    color: ${({ theme }) => theme.palette.text.primary};
  }

  &.active {
    color: ${({ theme }) => theme.palette.text.primary};
    border-bottom-color: ${({ theme }) => theme.palette.primary.main};
  }
`

const Pulse = styled.span`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${({ theme }) => theme.palette.primary.main};
  display: inline-block;
  animation: pulse 1200ms ease-in-out infinite;
  @keyframes pulse {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 1; }
  }
`

export default function ClaudeSubNav(): JSX.Element {
  const journalGenerating = useAppSelector(
    (s) => s.claude.journalUi.isGenerating
  )
  return (
    <>
      <Nav>
        <Tab to="/claude/sessions">Sessions</Tab>
        <Tab to="/claude/stats">Stats</Tab>
        <Tab to="/claude/journal">
          Daily Summary
          {journalGenerating && <Pulse title="Daily summary is generating" />}
        </Tab>
      </Nav>
      <ClaudeErrorToast />
    </>
  )
}
