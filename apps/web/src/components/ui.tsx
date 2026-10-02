import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowLeft, ArrowRight, LoaderCircle, X } from 'lucide-react';
import { api } from '../lib/api';

export const number = (v: number | null | undefined) =>
  v == null ? '—' : new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(v);
export const money = (v: number, currency = 'USD') =>
  new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency,
    maximumFractionDigits: currency === 'CLP' ? 0 : 2,
  }).format(v);
export const date = (v: string | null | undefined) => (v ? new Date(v).toLocaleString('es-CL') : '—');
export function Spinner() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={22} /> Cargando información…
    </div>
  );
}
export function Empty({
  children = 'Todavía no hay datos. Comienza importando tus transacciones.',
}: {
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-mark">◇</div>
      {children}
    </div>
  );
}
export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="error" role="alert">
      <AlertCircle size={18} />
      <span>{error}</span>
      {retry && <button onClick={retry}>Reintentar</button>}
    </div>
  );
}
export function Badge({ children }: { children: ReactNode }) {
  const value = String(children);
  return (
    <span
      className={`badge ${['ACTIVE', 'SUCCEEDED', 'COMPLETED', 'DONE', 'LOW', 'DELIVERED'].includes(value) ? 'good' : ['FAILED', 'REJECTED', 'HIGH', 'CRITICAL'].includes(value) ? 'bad' : 'neutral'}`}
    >
      {children}
    </span>
  );
}
export function PageTitle({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="actions">{actions}</div>
    </div>
  );
}
export function Metric({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </div>
  );
}
export function Pagination({
  page,
  total,
  pageSize = 25,
  onPage,
}: {
  page: number;
  total: number;
  pageSize?: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="pagination">
      <span>
        {number(total)} registros · Página {page} de {Math.max(1, Math.ceil(total / pageSize))}
      </span>
      <div>
        <button aria-label="Página anterior" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ArrowLeft size={16} />
        </button>
        <button
          aria-label="Página siguiente"
          disabled={page * pageSize >= total}
          onClick={() => onPage(page + 1)}
        >
          <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}
export function JsonView({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog ref={ref} onCancel={onClose}>
      <div className="modal-header">
        <h2>{title}</h2>
        <button aria-label="Cerrar" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
const ToastContext = createContext<(text: string, bad?: boolean) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; bad: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify = useCallback((text: string, bad = false) => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ text, bad });
    timer.current = setTimeout(() => setToast(null), 7000);
  }, []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      {toast && (
        <div role={toast.bad ? 'alert' : 'status'} className={`toast ${toast.bad ? 'error' : ''}`}>
          <span>{toast.text}</span>
          <button aria-label="Cerrar aviso" onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);
export function useResource<T>(path: string) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api<T>(path)
      .then((d) => {
        if (active) setData(d);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, version]);
  return { data, error, loading, reload };
}
export function useAction() {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const run = async (fn: () => Promise<unknown>, message = 'Cambios guardados') => {
    if (busy) return false;
    setBusy(true);
    try {
      await fn();
      toast(message);
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'No se pudo completar la operación', true);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}
