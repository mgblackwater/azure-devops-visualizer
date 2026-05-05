import { createTheme, type ThemeOptions } from '@mui/material/styles'

const FONT_STACK = [
  '-apple-system',
  'BlinkMacSystemFont',
  'Segoe UI',
  'Roboto',
  'Helvetica',
  'Arial',
  'sans-serif'
].join(',')

const SHARED: Pick<ThemeOptions, 'shape' | 'typography'> = {
  shape: { borderRadius: 8 },
  typography: { fontFamily: FONT_STACK }
}

export const theme = createTheme({
  ...SHARED,
  palette: {
    mode: 'light',
    primary: { main: '#0078D4' },
    secondary: { main: '#5C2D91' },
    background: { default: '#F4F6F8', paper: '#FFFFFF' }
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
    },
    // MUI applies a subtle white-tinted gradient to Paper at higher
    // elevations in dark mode, which clashes with our chosen surface
    // colours and makes drawers / popovers look washed-out. Disabling
    // backgroundImage globally keeps Paper backgrounds flat in both modes.
    MuiPaper: {
      styleOverrides: { root: { backgroundImage: 'none' } }
    }
  }
})

export const darkTheme = createTheme({
  ...SHARED,
  palette: {
    mode: 'dark',
    primary: { main: '#4DA8FF' },
    secondary: { main: '#B59CE0' },
    background: { default: '#0F1115', paper: '#161A22' },
    divider: 'rgba(255,255,255,0.08)'
  },
  components: {
    MuiAppBar: {
      defaultProps: { color: 'inherit', elevation: 0 },
      styleOverrides: {
        root: {
          borderBottom: '1px solid rgba(255,255,255,0.08)'
        }
      }
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: { root: { textTransform: 'none' } }
    },
    MuiPaper: {
      styleOverrides: { root: { backgroundImage: 'none' } }
    }
  }
})
