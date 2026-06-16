// Copyright The Perses Authors
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import React, { createContext, ReactElement, useContext, useMemo } from 'react';
import { createTheme, CssBaseline, ThemeProvider } from '@mui/material';
import {
  ChartsProvider,
  generateChartsTheme,
  PersesChartsTheme,
  getTheme,
  useLocalStorage,
} from '@perses-dev/components';
import { buildObsescThemeOptions } from '../theme/obsesc';

// app specific echarts option overrides, empty since perses uses default
// https://apache.github.io/echarts-handbook/en/concepts/style/#theme
const ECHARTS_THEME_OVERRIDES = {};

// Operator UI ships dark-first — dashboards live on production monitors
// under load, not phones in bright rooms. Browser pref is ignored on
// purpose so a fresh AMI always boots dark; the user can still toggle
// it via the header switch and the choice survives via localStorage.
const DARK_MODE_PREFERENCE_KEY = 'PERSES_ENABLE_DARK_MODE';

interface DarkModeContext {
  isDarkModeEnabled: boolean;
  setDarkMode: (pref: boolean) => void;
}

export const DarkModeContext = createContext<DarkModeContext | undefined>(undefined);

/**
 * Acts as theme provider for MUI and allows switching to dark mode.
 */
export function DarkModeContextProvider(props: { children: React.ReactNode }): ReactElement {
  const [isDarkModeEnabled, setDarkMode] = useLocalStorage<boolean>(DARK_MODE_PREFERENCE_KEY, true);

  // store the dark mode preference in local storage
  const darkModeContext: DarkModeContext = useMemo(
    () => ({
      isDarkModeEnabled,
      setDarkMode,
    }),
    [isDarkModeEnabled, setDarkMode]
  );

  // OBSESC theme override: deep-merge the brand palette + typography
  // on top of Perses' base theme. `getTheme(mode, options)` does a
  // shallow spread which clobbers `palette.designSystem` (used by
  // Perses' modal-background helper), so we go in two passes:
  // build the upstream theme, then layer our overrides via MUI's
  // `createTheme(baseTheme, overrides)` which deep-merges.
  const theme = useMemo(() => {
    const mode = isDarkModeEnabled ? 'dark' : 'light';
    const base = getTheme(mode);
    return createTheme(base, buildObsescThemeOptions(mode));
  }, [isDarkModeEnabled]);
  const chartsTheme: PersesChartsTheme = useMemo(() => {
    return generateChartsTheme(theme, { echartsTheme: ECHARTS_THEME_OVERRIDES });
  }, [theme]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline enableColorScheme={true} />
      <ChartsProvider chartsTheme={chartsTheme} enablePinning={true}>
        <DarkModeContext.Provider value={darkModeContext}>{props.children}</DarkModeContext.Provider>
      </ChartsProvider>
    </ThemeProvider>
  );
}

export function useDarkMode(): DarkModeContext {
  const ctx = useContext(DarkModeContext);
  if (ctx === undefined) {
    throw new Error('No DarkModeContext found. Did you forget a Provider?');
  }
  return ctx;
}
