import { createTheme } from '@mui/material/styles'

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#0078D4' },
    secondary: { main: '#5C2D91' },
    background: { default: '#F4F6F8', paper: '#FFFFFF' }
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: [
      '-apple-system',
      'BlinkMacSystemFont',
      'Segoe UI',
      'Roboto',
      'Helvetica',
      'Arial',
      'sans-serif'
    ].join(',')
  },
  components: {
    MuiAppBar: {
      defaultProps: { color: 'inherit', elevation: 0 },
      styleOverrides: {
        root: {
          borderBottom: '1px solid rgba(0,0,0,0.08)'
        }
      }
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: { root: { textTransform: 'none' } }
    }
  }
})

export const darkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#4DA8FF' },
    secondary: { main: '#B59CE0' },
    background: { default: '#0F1115', paper: '#161A22' }
  },
  shape: { borderRadius: 8 },
  components: {
    MuiAppBar: {
      defaultProps: { color: 'inherit', elevation: 0 }
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: { root: { textTransform: 'none' } }
    }
  }
})
