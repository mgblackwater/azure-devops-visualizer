import 'styled-components'
import type { Theme as MuiTheme } from '@mui/material/styles'

/**
 * Tell styled-components that the theme it receives at runtime is the same
 * MUI theme we install via MuiThemeProvider. Without this augmentation,
 * `({ theme }) => theme.palette.*` would be typed as `unknown`.
 */
declare module 'styled-components' {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  export interface DefaultTheme extends MuiTheme {}
}

/**
 * Same idea for @emotion/styled — MuiThemeProvider internally uses emotion's
 * ThemeContext, so emotion-styled components automatically receive the MUI
 * theme via `props.theme`. Augment Emotion's Theme so TypeScript knows.
 */
declare module '@emotion/react' {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  export interface Theme extends MuiTheme {}
}
