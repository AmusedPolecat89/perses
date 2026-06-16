// Copyright OBSESC Authors
//
// OBSESC design tokens, pulled from obsesc.com's compiled palette.
// Wrapped into a ThemeOptions override that we hand to Perses'
// `getTheme(mode, options)` so the host-app theme picks up OBSESC
// branding without modifying upstream @perses-dev/components.

import type { PaletteMode, ThemeOptions } from '@mui/material';

// Ink — dark surfaces and text on light.
export const ink = {
  950: '#07101f',
  900: '#0e1729',
  850: '#131e34',
  800: '#182338',
  700: '#243047',
  600: '#364361',
} as const;

// Paper — light surfaces and text on dark.
export const paper = {
  base: '#f7f6f2',
  mute: '#ecebe5',
} as const;

// Amber — brand accent. Amber-400 is reserved for dark mode where
// amber-500 sits a touch too warm against ink-900; light mode keeps
// the more saturated amber-500 to match obsesc.com's hero.
export const amber = {
  500: '#f59e0b',
  400: '#fbbf24',
  300: '#fcd34d',
  cream: '#fef3c7',
} as const;

export const status = {
  green: '#10b981',
  red: '#ef4444',
  blue: '#3b82f6',
} as const;

export const fontStack = {
  sans: '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

export function buildObsescThemeOptions(mode: PaletteMode): ThemeOptions {
  const isDark = mode === 'dark';
  return {
    palette: {
      mode,
      primary: {
        main: isDark ? amber[400] : amber[500],
        contrastText: ink[950],
      },
      // Map MUI semantic colors to the brand status palette so MUI
      // primitives (Alert, Chip, etc.) pick them up automatically.
      success: { main: status.green },
      error: { main: status.red },
      warning: { main: amber[500] },
      info: { main: status.blue },
      background: {
        default: isDark ? ink[900] : paper.base,
        paper: isDark ? ink[850] : paper.mute,
        // Perses' TypeBackground extensions (set by @perses-dev/components).
        // The header / SignWrapper / config sidebar consume these via
        // theme.palette.background.navigation / lighter / border.
        navigation: isDark ? ink[950] : ink[900],
        tooltip: isDark ? ink[800] : ink[700],
        overlay: isDark ? `${ink[950]}cc` : `${ink[900]}33`,
        border: isDark ? ink[700] : '#d6d4cc',
        lighter: isDark ? ink[800] : paper.mute,
        code: isDark ? ink[850] : '#ebe9e1',
      } as ThemeOptions['palette'] extends infer P
        ? P extends { background?: infer B }
          ? B
          : never
        : never,
      text: {
        primary: isDark ? paper.base : ink[950],
        secondary: isDark ? paper.mute : ink[600],
        // Perses extensions.
        navigation: paper.base,
        accent: isDark ? amber[400] : amber[500],
        link: isDark ? amber[400] : amber[500],
        linkHover: isDark ? amber[300] : '#c97d05',
      } as ThemeOptions['palette'] extends infer P
        ? P extends { text?: infer T }
          ? T
          : never
        : never,
      divider: isDark ? ink[700] : '#d6d4cc',
    },
    typography: {
      fontFamily: fontStack.sans,
      // Slight bump up from MUI's default 14px / Perses' 12px so the
      // operator can read dashboards on a real monitor without squinting
      // (per the brief's Bloomberg-terminal direction).
      fontSize: 14,
      h1: { fontFamily: fontStack.sans, fontWeight: 700 },
      h2: { fontFamily: fontStack.sans, fontWeight: 700 },
      h3: { fontFamily: fontStack.sans, fontWeight: 600 },
      h4: { fontFamily: fontStack.sans, fontWeight: 600 },
      h5: { fontFamily: fontStack.sans, fontWeight: 600 },
      h6: { fontFamily: fontStack.sans, fontWeight: 600, letterSpacing: '0.02em' },
      button: { textTransform: 'none', fontWeight: 500 },
    },
    shape: {
      borderRadius: 6,
    },
  } as ThemeOptions;
}
