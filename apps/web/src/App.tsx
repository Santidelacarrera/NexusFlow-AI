import { lazy, Suspense, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import {
  Activity,
  Bell,
  BrainCircuit,
  ChevronRight,
  FileSpreadsheet,
  GitBranch,
  LayoutDashboard,
  Layers,
  LogOut,
  Menu,
  Plug,
  Settings as SettingsIcon,
  ShieldCheck,
  Truck,
  Users,
  X,
} from 'lucide-react';
import { useSession, isAdmin } from './lib/session';
import { ErrorBox, Spinner, useAction } from './components/ui';
import Auth from './pages/Auth';
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Customers = lazy(() => import('./pages/Customers'));
const Imports = lazy(() => import('./pages/Imports'));
const Integrations = lazy(() => import('./pages/Integrations'));
const Predictive = lazy(() => import('./pages/Predictive'));
const Workflows = lazy(() => import('./pages/Workflows').then((m) => ({ default: m.Workflows })));
const Editor = lazy(() => import('./pages/Workflows').then((m) => ({ default: m.WorkflowEditor })));
const Runs = lazy(() => import('./pages/Workflows').then((m) => ({ default: m.Runs })));
const Operations = lazy(() => import('./pages/Operations'));
const Inbox = lazy(() => import('./pages/Inbox'));
const Security = lazy(() => import('./pages/Security'));
const Settings = lazy(() => import('./pages/Security').then((m) => ({ default: m.Settings })));
const Training = lazy(() => import('./pages/Security').then((m) => ({ default: m.Training })));
const navigation = [
  { path: '/', label: 'Vista general', icon: LayoutDashboard },
  { path: '/workflows', label: 'Flow Engine', icon: GitBranch },
  { path: '/customers', label: 'Customer Intelligence', icon: Users },
  { path: '/predictive', label: 'Predictive AI', icon: BrainCircuit },
  { path: '/imports', label: 'AutoOps', icon: FileSpreadsheet },
  { path: '/operations', label: 'Operations Intelligence', icon: Truck },
  { path: '/security', label: 'Security Center', icon: ShieldCheck, admin: true },
];
export default function App() {
  const { user, loading, logout } = useSession(),
    location = useLocation(),
    action = useAction();
  const [menu, setMenu] = useState(false);
  if (location.pathname === '/training')
    return (
      <Suspense fallback={<Spinner />}>
        <Training />
      </Suspense>
    );
  if (loading)
    return (
      <div className="boot">
        <Layers size={32} />
        <Spinner />
      </div>
    );
  if (!user) return <Auth />;
  return (
    <div className="app-shell">
      {menu && <button className="menu-backdrop" aria-label="Cerrar menú" onClick={() => setMenu(false)} />}
      <aside className={`sidebar ${menu ? 'open' : ''}`}>
        <NavLink to="/" className="brand">
          <Layers size={26} />
          <span>
            NexusFlow <b>AI</b>
          </span>
        </NavLink>
        <div className="workspace">
          <div className="workspace-icon">{user.orgName.slice(0, 1).toUpperCase()}</div>
          <div>
            <strong>{user.orgName}</strong>
            <small>Espacio de trabajo</small>
          </div>
          <ChevronRight size={14} />
        </div>
        <div className="nav-label">PLATAFORMA</div>
        <nav>
          {navigation
            .filter((n) => !n.admin || isAdmin(user))
            .map((n) => (
              <NavLink end={n.path === '/'} key={n.path} to={n.path} onClick={() => setMenu(false)}>
                <n.icon size={18} />
                <span>{n.label}</span>
              </NavLink>
            ))}
        </nav>
        <div className="nav-label second">ACTIVIDAD</div>
        <nav>
          <NavLink to="/runs" onClick={() => setMenu(false)}>
            <Activity size={18} /> Ejecuciones
          </NavLink>
          <NavLink to="/inbox" onClick={() => setMenu(false)}>
            <Bell size={18} /> Alertas y tareas
          </NavLink>
          <NavLink to="/integrations" onClick={() => setMenu(false)}>
            <Plug size={18} /> Integraciones
          </NavLink>
          <NavLink to="/settings" onClick={() => setMenu(false)}>
            <SettingsIcon size={18} /> Mi cuenta
          </NavLink>
        </nav>
        <div className="sidebar-bottom">
          <div className="system-label">
            <span /> Organización conectada
          </div>
          <div className="user-card">
            <div className="avatar">{user.name.slice(0, 1)}</div>
            <div>
              <strong>{user.name}</strong>
              <small>{user.role}</small>
            </div>
            <button
              aria-label="Cerrar sesión"
              disabled={action.busy}
              onClick={() => action.run(logout, 'Sesión cerrada')}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <button className="mobile-menu" aria-label="Abrir menú" onClick={() => setMenu(!menu)}>
              {menu ? <X size={21} /> : <Menu size={21} />}
            </button>
            <span className="breadcrumb">
              Plataforma <ChevronRight size={13} />
              <strong>
                {navigation.find((n) => n.path !== '/' && location.pathname.startsWith(n.path))?.label ??
                  (location.pathname === '/runs'
                    ? 'Ejecuciones'
                    : location.pathname === '/inbox'
                      ? 'Alertas y tareas'
                      : location.pathname === '/settings'
                        ? 'Mi cuenta'
                        : 'Vista general')}
              </strong>
            </span>
          </div>
          <div className="topbar-right">
            <span className="workspace-date">
              {new Date().toLocaleDateString('es-CL', { day: 'numeric', month: 'short', year: 'numeric' })}
            </span>
            <NavLink to="/inbox" aria-label="Abrir alertas">
              <Bell size={19} />
            </NavLink>
            <div className="avatar small">{user.name.slice(0, 1)}</div>
          </div>
        </header>
        <main className="page-content">
          <Suspense fallback={<Spinner />}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/customers" element={<Customers />} />
              <Route path="/imports" element={<Imports />} />
              <Route path="/integrations" element={<Integrations />} />
              <Route path="/predictive" element={<Predictive />} />
              <Route path="/workflows" element={<Workflows />} />
              <Route path="/workflows/:id" element={<Editor />} />
              <Route path="/runs" element={<Runs />} />
              <Route path="/operations" element={<Operations />} />
              <Route path="/inbox" element={<Inbox />} />
              <Route
                path="/security"
                element={
                  isAdmin(user) ? <Security /> : <ErrorBox error="Se requieren permisos de administrador." />
                }
              />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </main>
        <footer className="app-footer">
          <span>NexusFlow AI</span>
          <span>Conecta. Comprende. Automatiza.</span>
        </footer>
      </div>
    </div>
  );
}
