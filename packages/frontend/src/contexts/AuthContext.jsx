import { createContext, useContext, useState, useCallback } from 'react';
import { api, ACCESS_TOKEN_KEY } from '../services/api';

/* Auth session (BRD §7.8). Holds the logged-in user + tokens in localStorage and
   exposes login/logout. The access token is mirrored to ACCESS_TOKEN_KEY so the
   plain fetch wrapper in services/api.js can attach it as a Bearer. */

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

const SESSION_KEY = 'synapse_auth';

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; }
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(loadSession); // { accessToken, refreshToken, user } | null

  const login = useCallback(async (email, password) => {
    const res = await api.login(email, password);
    if (res.ok && res.data?.success) {
      const data = res.data.data;
      localStorage.setItem(SESSION_KEY, JSON.stringify(data));
      localStorage.setItem(ACCESS_TOKEN_KEY, data.accessToken);
      setSession(data);
      return { ok: true };
    }
    return { ok: false, error: res.data?.error || 'Login failed' };
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    setSession(null);
  }, []);

  const value = {
    isAuthed: !!session,
    user: session?.user || null,
    role: session?.user?.role || null,
    login,
    logout,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
