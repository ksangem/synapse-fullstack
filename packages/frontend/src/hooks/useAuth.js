import { createContext, useContext } from 'react';

// Context object + hook live together (a non-component module) so the provider file can export
// only its component — satisfies react-refresh/only-export-components.
export const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);
