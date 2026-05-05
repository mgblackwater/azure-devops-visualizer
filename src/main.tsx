import React, { useEffect, useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { Provider } from 'react-redux'
import { HashRouter } from 'react-router-dom'
import {
  CssBaseline,
  ThemeProvider as MuiThemeProvider,
  type Theme
} from '@mui/material'
import { ThemeProvider as ScThemeProvider } from 'styled-components'
import { store, useAppSelector } from './store'
import { selectThemeMode, type ThemeMode } from './store/preferencesSlice'
import { darkTheme, theme as lightTheme } from './theme'
import App from './App'
import 'vis-timeline/styles/vis-timeline-graph2d.css'
import './styles/vis-timeline-overrides.css'
import './styles/fullcalendar-overrides.css'
import '@xyflow/react/dist/style.css'
import './styles/reactflow-overrides.css'

/**
 * Resolves the user's themeMode preference into the actual MUI theme to
 * install. When `'system'` is selected we listen to the OS color-scheme
 * media query so the app re-themes live as the user toggles their OS
 * setting (no relaunch needed).
 */
function useResolvedTheme(): Theme {
  const mode: ThemeMode = useAppSelector(selectThemeMode)
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent): void => {
      setSystemPrefersDark(e.matches)
    }
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  return useMemo(() => {
    const resolved =
      mode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : mode
    return resolved === 'dark' ? darkTheme : lightTheme
  }, [mode, systemPrefersDark])
}

function ThemedApp(): JSX.Element {
  const activeTheme = useResolvedTheme()

  // Mirror the active mode onto the <html> element as a data attribute so
  // plain CSS files (vis-timeline, FullCalendar, ReactFlow overrides) can
  // key off `[data-theme="dark"]` without needing access to React state.
  useEffect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.setAttribute(
      'data-theme',
      activeTheme.palette.mode
    )
  }, [activeTheme])

  return (
    <MuiThemeProvider theme={activeTheme}>
      <ScThemeProvider theme={activeTheme}>
        <CssBaseline />
        <HashRouter>
          <App />
        </HashRouter>
      </ScThemeProvider>
    </MuiThemeProvider>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('#root element missing in index.html')

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Provider store={store}>
      <ThemedApp />
    </Provider>
  </React.StrictMode>
)
