import { createContext, useContext } from 'react';

// The context object lives with its hook (a non-component module) so the provider file can
// export only its component — satisfies react-refresh/only-export-components without churn.
export const ThemeContext = createContext();

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
