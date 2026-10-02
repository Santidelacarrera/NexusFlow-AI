import { Link } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowUpRight, GitBranch, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import {
  Badge,
  Empty,
  ErrorBox,
  Metric,
  PageTitle,
  Spinner,
  date,
  money,
  number,
  useResource,
} from '../components/ui';

interface Overview {
  revenue: number;
  orders: number;
  customers: number;
  avgTicket: number;
  repeatRate: number;
  currency: string;
  monthly: { month: string; revenue: number }[];
}
interface Stats {
  runs: number;
  successRate: number | null;
  automatedActions: number;
  estimatedMinutesSaved: number;
  failed: number;
}
interface Alert {
  id: string;
  title: string;
  message: string;
  severity: string;
  createdAt: string;
}
export default function Dashboard() {
  const { user } = useSession();
  const overview = useResource<Overview>('analytics/overview'),
    stats = useResource<Stats>('workflows/stats'),
    alerts = useResource<{ items: Alert[] }>('alerts?pageSize=5');
  if (overview.loading) return <Spinner />;
  if (overview.error) return <ErrorBox error={overview.error} retry={overview.reload} />;
  const d = overview.data!;
  return (
    <>
      <PageTitle
        eyebrow="VISTA GENERAL"
        title={`Hola, ${user?.name.split(' ')[0]}`}
        description="Lo que está pasando en tu empresa, en un solo lugar."
        actions={
          <Link className="button primary" to="/imports">
            <Upload size={16} /> Importar datos
          </Link>
        }
      />
      <div className="metrics">
        <Metric
          label="Ingresos totales"
          value={money(d.revenue, d.currency)}
          hint="Historial de transacciones importadas"
        />
        <Metric
          label="Clientes"
          value={number(d.customers)}
          hint={`${number(d.orders)} transacciones registradas`}
        />
        <Metric
          label="Ticket promedio"
          value={money(d.avgTicket, d.currency)}
          hint="Ingreso por transacción"
        />
        <Metric
          label="Compra recurrente"
          value={`${number(d.repeatRate)}%`}
          hint="Clientes con más de una compra"
        />
      </div>
      <div className="dashboard-grid">
        <section className="panel revenue">
          <div className="panel-heading">
            <div>
              <h2>Evolución de ingresos</h2>
              <p>Últimos 12 meses con datos · {d.currency}</p>
            </div>
            <span className="badge good">Datos de tu organización</span>
          </div>
          {d.monthly.length ? (
            <div className="chart">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={d.monthly}>
                  <defs>
                    <linearGradient id="revenue-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#37d6b4" stopOpacity={0.28} />
                      <stop offset="100%" stopColor="#37d6b4" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#23313d" vertical={false} />
                  <XAxis dataKey="month" stroke="#7e94a4" fontSize={11} />
                  <YAxis stroke="#7e94a4" fontSize={11} width={65} />
                  <Tooltip
                    contentStyle={{ background: '#14212c', border: '1px solid #30424f', borderRadius: 10 }}
                    formatter={(v) => money(Number(v), d.currency)}
                  />
                  <Area
                    dataKey="revenue"
                    name="Ingresos"
                    stroke="#37d6b4"
                    strokeWidth={2.5}
                    fill="url(#revenue-fill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <Empty />
          )}
        </section>
        <section className="panel automation">
          <div className="panel-heading">
            <div>
              <h2>Tu motor de automatización</h2>
              <p>Actividad de los últimos 30 días</p>
            </div>
            <GitBranch size={21} />
          </div>
          {stats.error ? (
            <ErrorBox error={stats.error} retry={stats.reload} />
          ) : (
            <>
              <div className="big-stat">
                {number(stats.data?.automatedActions ?? 0)}
                <span>acciones automatizadas</span>
              </div>
              <div className="stat-row">
                <span>Ejecuciones</span>
                <strong>{number(stats.data?.runs ?? 0)}</strong>
              </div>
              <div className="stat-row">
                <span>Tasa de éxito</span>
                <strong>{stats.data?.successRate == null ? '—' : `${stats.data.successRate}%`}</strong>
              </div>
              <div className="stat-row">
                <span>Tiempo ahorrado estimado</span>
                <strong>{number(stats.data?.estimatedMinutesSaved ?? 0)} min</strong>
              </div>
              <small>Estimación: 5 minutos por acción completada.</small>
            </>
          )}
          <Link className="button full" to="/workflows">
            Abrir Flow Engine
            <ArrowUpRight size={16} />
          </Link>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Actividad y alertas</h2>
              <p>Los eventos más recientes</p>
            </div>
            <Link to="/inbox">
              Ver todas <ArrowUpRight size={14} />
            </Link>
          </div>
          {alerts.error ? (
            <ErrorBox error={alerts.error} />
          ) : alerts.data?.items.length ? (
            alerts.data.items.map((a) => (
              <div className="activity" key={a.id}>
                <span className={`activity-dot ${a.severity.toLowerCase()}`} />
                <div>
                  <strong>{a.title}</strong>
                  <p>{a.message}</p>
                </div>
                <time>{date(a.createdAt)}</time>
              </div>
            ))
          ) : (
            <Empty>No hay alertas todavía.</Empty>
          )}
        </section>
        <section className="panel next-step">
          <div className="eyebrow">TU SIGUIENTE PASO</div>
          <h2>
            Convierte tus datos
            <br />
            en decisiones.
          </h2>
          <p>Segmenta clientes y encuentra oportunidades de retención.</p>
          <Link className="button" to="/customers">
            Explorar clientes <ArrowUpRight size={16} />
          </Link>
        </section>
      </div>
    </>
  );
}
