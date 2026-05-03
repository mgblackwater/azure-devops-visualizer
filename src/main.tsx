import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider } from 'react-redux'
import { HashRouter } from 'react-router-dom'
import { CssBaseline, ThemeProvider as MuiThemeProvider } from '@mui/material'
import { ThemeProvider as ScThemeProvider } from 'styled-components'
import { store } from './store'
import { theme } from './theme'
import App from './App'
import 'vis-timeline/styles/vis-timeline-graph2d.css'
import '@xyflow/react/dist/style.css'
import './styles/reactflow-overrides.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root element missing in index.html')

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Provider store={store}>
      <MuiThemeProvider theme={theme}>
        <ScThemeProvider theme={theme}>
          <CssBaseline />
          <HashRouter>
            <App />
          </HashRouter>
        </ScThemeProvider>
      </MuiThemeProvider>
    </Provider>
  </React.StrictMode>
)
