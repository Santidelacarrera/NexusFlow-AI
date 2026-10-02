import { useState } from 'react';
import { Search, Users } from 'lucide-react';
import { api } from '../lib/api';
import {
  Badge,
  Empty,
  ErrorBox,
  JsonView,
  Modal,
  PageTitle,
  Pagination,
  Spinner,
  money,
  number,
  date,
  useResource,
  useAction,
} from '../components/ui';
import { useSession } from '../lib/session';
interface Customer {
  id: string;
  name: string;
  email: string | null;
  externalId: string;
  orders: number;
  revenue: number;
  lastPurchaseAt: string | null;
}
interface Rfm {
  customerId: string;
  name: string;
  recencyDays: number;
  frequency: number;
  monetary: number;
  r: number;
  f: number;
  m: number;
  segment: string;
}
interface Page<T> {
  items: T[];
  total: number;
  segments?: { segment: string; count: number }[];
}
const segments = ['Champions', 'Loyal', 'Big Spenders', 'New', 'Promising', 'At Risk', 'Inactive'];
export default function Customers() {
  const [tab, setTab] = useState('customers'),
    [search, setSearch] = useState(''),
    [draft, setDraft] = useState(''),
    [segment, setSegment] = useState(''),
    [page, setPage] = useState(1),
    [detail, setDetail] = useState<unknown>(null);
  const { user } = useSession(),
    action = useAction();
  const query = new URLSearchParams({ page: String(page) });
  if (search && tab === 'customers') query.set('search', search);
  if (segment && tab === 'rfm') query.set('segment', segment);
  const resource = useResource<Page<Customer & Rfm>>(
    `${tab === 'rfm' ? 'analytics/rfm' : 'customers'}?${query}`,
  );
  return (
    <>
      <PageTitle
        eyebrow="CUSTOMER INTELLIGENCE"
        title="Conoce a tus clientes"
        description="Segmentación RFM y comportamiento de compra para tomar mejores decisiones."
      />
      <div className="tabs">
        <button
          className={tab === 'customers' ? 'selected' : ''}
          onClick={() => {
            setTab('customers');
            setPage(1);
          }}
        >
          Todos los clientes
        </button>
        <button
          className={tab === 'rfm' ? 'selected' : ''}
          onClick={() => {
            setTab('rfm');
            setPage(1);
          }}
        >
          Segmentación RFM
        </button>
      </div>
      <section className="panel">
        <div className="table-toolbar">
          {tab === 'customers' ? (
            <form
              className="search"
              onSubmit={(e) => {
                e.preventDefault();
                setSearch(draft);
                setPage(1);
              }}
            >
              <Search size={16} />
              <input
                aria-label="Buscar clientes"
                placeholder="Buscar nombre, correo o ID…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
              <button>Buscar</button>
            </form>
          ) : (
            <label className="inline-label">
              Segmento
              <select
                value={segment}
                onChange={(e) => {
                  setSegment(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">Todos los segmentos</option>
                {segments.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          )}
          <span className="muted">{number(resource.data?.total ?? 0)} clientes</span>
        </div>
        {resource.loading ? (
          <Spinner />
        ) : resource.error ? (
          <ErrorBox error={resource.error} retry={resource.reload} />
        ) : !resource.data?.items.length ? (
          <Empty />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Cliente</th>
                  {tab === 'rfm' ? (
                    <>
                      <th>Recencia</th>
                      <th>Frecuencia</th>
                      <th>Valor monetario</th>
                      <th>R / F / M</th>
                      <th>Segmento</th>
                    </>
                  ) : (
                    <>
                      <th>Correo</th>
                      <th>Compras</th>
                      <th>Ingresos</th>
                      <th>Última compra</th>
                    </>
                  )}
                  <th>Detalle</th>
                </tr>
              </thead>
              <tbody>
                {resource.data.items.map((c) => (
                  <tr key={c.id ?? c.customerId}>
                    <td>
                      <div className="table-person">
                        <div className="avatar">
                          <Users size={16} />
                        </div>
                        <div>
                          <strong>{c.name}</strong>
                          <small>{c.externalId}</small>
                        </div>
                      </div>
                    </td>
                    {tab === 'rfm' ? (
                      <>
                        <td>{number(c.recencyDays)} días</td>
                        <td>{c.frequency}</td>
                        <td>{money(c.monetary, user?.currency)}</td>
                        <td>
                          {c.r} / {c.f} / {c.m}
                        </td>
                        <td>
                          <Badge>{c.segment}</Badge>
                        </td>
                      </>
                    ) : (
                      <>
                        <td>{c.email ?? '—'}</td>
                        <td>{c.orders}</td>
                        <td>{money(c.revenue, user?.currency)}</td>
                        <td>{date(c.lastPurchaseAt)}</td>
                      </>
                    )}
                    <td>
                      <button
                        disabled={action.busy}
                        onClick={() =>
                          action.run(
                            async () => setDetail(await api(`customers/${c.id ?? c.customerId}`)),
                            'Detalle cargado',
                          )
                        }
                      >
                        Ver
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} total={resource.data?.total ?? 0} onPage={setPage} />
      </section>
      {tab === 'rfm' && (
        <p className="footnote">
          R: días desde la última compra · F: cantidad de compras · M: valor acumulado. Las puntuaciones se
          calculan dentro de tu organización.
        </p>
      )}
      {detail != null && (
        <Modal title="Historial del cliente" onClose={() => setDetail(null)}>
          <JsonView value={detail} />
        </Modal>
      )}
    </>
  );
}
