import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, post, refresh, setToken, type Session, type User } from './api';
interface Auth {
  user: User | null;
  loading: boolean;
  login: (body: unknown, register?: boolean) => Promise<void>;
  logout: () => Promise<void>;
}
const Context = createContext<Auth | null>(null);
export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    refresh()
      .then(() => api<User>('auth/me'))
      .then((u) => {
        if (alive) setUser(u);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoading(false);
      });
    const expire = () => {
      setToken(null);
      setUser(null);
    };
    window.addEventListener('session-expired', expire);
    return () => {
      alive = false;
      window.removeEventListener('session-expired', expire);
    };
  }, []);
  const login = async (body: unknown, register = false) => {
    const s = await post<Session>(`auth/${register ? 'register' : 'login'}`, body);
    setToken(s.accessToken);
    setUser(await api<User>('auth/me'));
  };
  const logout = async () => {
    await post('auth/logout');
    setToken(null);
    setUser(null);
  };
  return <Context.Provider value={{ user, loading, login, logout }}>{children}</Context.Provider>;
}
export function useSession() {
  const context = useContext(Context);
  if (!context) throw new Error('Missing session provider');
  return context;
}
export function canEdit(user: User | null) {
  return !!user && user.role !== 'VIEWER';
}
export function isAdmin(user: User | null) {
  return !!user && ['ADMIN', 'OWNER'].includes(user.role);
}
