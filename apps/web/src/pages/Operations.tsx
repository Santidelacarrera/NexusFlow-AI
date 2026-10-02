import { useState } from 'react';
import { Radar, Truck } from 'lucide-react';
import { post } from '../lib/api';
import { useSession, canEdit } from '../lib/session';
import {
  Badge,
  Empty,
  ErrorBox,
  Metric,
  PageTitle,
  Pagination,
  Spinner,
  date,
  number,
  useResource,
  useAction,
} from '../components/ui';
interface Kpis {
  total: number;
  delivered: number;
  inTransit: number;
  late: number;
  onTimeRate: number | null;
  avgDeliveryHours: number | null;
  byCarrier: { carrier: string; total: number; late: number; onTimeRate: number | null }[];
}
interface Order {
  id: string;
  externalId: string;
  carrier: string;
  route: string;
  status: string;
  promisedAt: string;
  late: boolean;
  delayHours: number;
}
export default function Operations() {
  const { user } = useSession(),
    action = useAction();
  const [page, setPage] = useState(1),
    [lateOnly, setLateOnly] = useState(false);
  const kpis = useResource<Kpis>('operations/kpis'),
    orders = useResource<{ items: Order[]; total: number }>(
      `operations/orders?page=${page}${lateOnly ? '&late=true' : ''}`,
    );
  function reload() {
    kpis.reload();
    orders.reload();
  }
  return (
    <>
      <PageTitle
        eyebrow="OPERATIONS INTELLIGENCE"
        title="Tu operación en movimiento"
        description="Supervisa entregas, identifica retrasos y reacciona a tiempo."
        actions={
          <>
            <button
              disabled={action.busy || !canEdit(user)}
              onClick={() =>
                action.run(async () => {
                  await post('operations/simulate', { count: 100 });
                  reload();
                }, '100 pedidos de simulación generados')
              }
            >
              <Truck size={16} /> Simular pedidos
            </button>
            <button
              className="primary"
              disabled={action.busy || !canEdit(user)}
              onClick={() =>
                action.run(async () => {
                  await post('operations/detect');
                  reload();
                }, 'Detección de retrasos completada')
              }
            >
              <Radar size={16} /> Detectar retrasos
            </button>
          </>
        }
      />
      <div className="notice">
        Este módulo usa pedidos de simulación identificados con el prefijo SIM. Puedes probar alertas y
        workflows sin conectar un transportista.
      </div>
      {kpis.error ? (
        <ErrorBox error={kpis.error} />
      ) : (
        <div className="metrics">
          <Metric
            label="Pedidos"
            value={number(kpis.data?.total ?? 0)}
            hint={`${number(kpis.data?.inTransit ?? 0)} en tránsito`}
          />
          <Metric label="Entregados" value={number(kpis.data?.delivered ?? 0)} />
          <Metric label="Con retraso" value={number(kpis.data?.late ?? 0)} />
          <Metric
            label="Entregas a tiempo"
            value={kpis.data?.onTimeRate == null ? '—' : `${kpis.data.onTimeRate}%`}
            hint="Sobre pedidos entregados"
          />
        </div>
      )}
      <section className="panel">
        <div className="panel-heading">
          <h2>Seguimiento de pedidos</h2>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={lateOnly}
              onChange={(e) => {
                setLateOnly(e.target.checked);
                setPage(1);
              }}
            />{' '}
            Solo atrasados
          </label>
        </div>
        {orders.loading ? (
          <Spinner />
        ) : orders.error ? (
          <ErrorBox error={orders.error} retry={orders.reload} />
        ) : !orders.data?.items.length ? (
          <Empty>No hay pedidos que mostrar. Genera una simulación para comenzar.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Pedido</th>
                  <th>Transportista</th>
                  <th>Ruta</th>
                  <th>Estado</th>
                  <th>Entrega prometida</th>
                  <th>Retraso</th>
                </tr>
              </thead>
              <tbody>
                {orders.data.items.map((o) => (
                  <tr key={o.id}>
                    <td>{o.externalId}</td>
                    <td>{o.carrier}</td>
                    <td>{o.route}</td>
                    <td>
                      <Badge>{o.status}</Badge>
                    </td>
                    <td>{date(o.promisedAt)}</td>
                    <td>{o.late ? <span className="error-text">{o.delayHours} h</span> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} total={orders.data?.total ?? 0} onPage={setPage} />
      </section>
      {!!kpis.data?.byCarrier.length && (
        <section className="panel">
          <h2>Rendimiento por transportista</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Transportista</th>
                  <th>Pedidos</th>
                  <th>Atrasados</th>
                  <th>A tiempo</th>
                </tr>
              </thead>
              <tbody>
                {kpis.data.byCarrier.map((c) => (
                  <tr key={c.carrier}>
                    <td>{c.carrier}</td>
                    <td>{c.total}</td>
                    <td>{c.late}</td>
                    <td>{c.onTimeRate == null ? '—' : `${c.onTimeRate}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
