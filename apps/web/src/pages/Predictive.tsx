import { useEffect, useState } from 'react';
import { BrainCircuit, Play, Sparkles } from 'lucide-react';
import { post, put } from '../lib/api';
import { useSession, canEdit, isAdmin } from '../lib/session';
import {
  Badge,
  Empty,
  ErrorBox,
  JsonView,
  Metric,
  Modal,
  PageTitle,
  Pagination,
  Spinner,
  number,
  useAction,
  useResource,
} from '../components/ui';
interface Policy {
  enabled: boolean;
  threshold: number;
  action: 'TASK' | 'ALERT';
}
interface Predictions {
  items: {
    id: string;
    customer: { name: string; externalId: string };
    churnProbability: number;
    riskBand: string;
    explanation: unknown;
  }[];
  total: number;
  model: {
    version: string;
    metrics: {
      mode: string;
      precision?: number;
      recall?: number;
      f1?: number;
      prAuc?: number;
      warning?: string;
    };
  } | null;
}
export default function Predictive() {
  const { user } = useSession();
  const [page, setPage] = useState(1),
    [policy, setPolicy] = useState<Policy>({ enabled: false, threshold: 0.7, action: 'TASK' }),
    [detail, setDetail] = useState<unknown>(null);
  const predictions = useResource<Predictions>(`predictive?page=${page}`),
    policyResource = useResource<Policy>('predictive/policy'),
    action = useAction();
  useEffect(() => {
    if (policyResource.data) setPolicy(policyResource.data);
  }, [policyResource.data]);
  const m = predictions.data?.model;
  return (
    <>
      <PageTitle
        eyebrow="PREDICTIVE AI"
        title="Anticipa el abandono"
        description="Identifica señales de riesgo y planifica acciones de retención con explicaciones claras."
        actions={
          <>
            <button
              disabled={action.busy || !isAdmin(user)}
              onClick={() =>
                action.run(async () => setDetail(await post('predictive/train')), 'Entrenamiento evaluado')
              }
            >
              <BrainCircuit size={16} /> Entrenar modelo
            </button>
            <button
              className="primary"
              disabled={action.busy || !canEdit(user)}
              onClick={() =>
                action.run(async () => {
                  await post('predictive/score');
                  predictions.reload();
                }, 'Predicciones generadas')
              }
            >
              <Play size={16} /> Evaluar clientes
            </button>
          </>
        }
      />
      {m?.metrics.mode === 'heuristic' && (
        <div className="notice">
          <Sparkles size={18} />
          <span>
            {m.metrics.warning ??
              'Indicador orientativo de recencia. Entrena un modelo con historial suficiente para activar automatizaciones.'}
          </span>
        </div>
      )}
      {m?.metrics.mode === 'trained' && (
        <div className="metrics">
          {(['precision', 'recall', 'f1', 'prAuc'] as const).map((key) => (
            <Metric
              key={key}
              label={key === 'prAuc' ? 'PR-AUC' : key.toUpperCase()}
              value={m.metrics[key] == null ? '—' : number(m.metrics[key]! * 100) + '%'}
              hint="Validación en clientes no usados al entrenar"
            />
          ))}
        </div>
      )}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Política de retención</h2>
            <p>Solo ejecuta acciones con un modelo entrenado. Requiere permisos de administrador.</p>
          </div>
        </div>
        {policyResource.error && <ErrorBox error={policyResource.error} />}
        <form
          className="policy-form"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await put('predictive/policy', policy);
              policyResource.reload();
            });
          }}
        >
          <label>
            Umbral de riesgo
            <input
              type="number"
              min={0.1}
              max={0.99}
              step={0.01}
              required
              value={policy.threshold}
              disabled={!isAdmin(user)}
              onChange={(e) => setPolicy({ ...policy, threshold: Number(e.target.value) })}
            />
          </label>
          <label>
            Acción
            <select
              disabled={!isAdmin(user)}
              value={policy.action}
              onChange={(e) => setPolicy({ ...policy, action: e.target.value as Policy['action'] })}
            >
              <option value="TASK">Crear tarea comercial</option>
              <option value="ALERT">Generar alerta</option>
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              disabled={!isAdmin(user)}
              checked={policy.enabled}
              onChange={(e) => setPolicy({ ...policy, enabled: e.target.checked })}
            />{' '}
            Activar política
          </label>
          <button disabled={action.busy || !isAdmin(user)}>Guardar política</button>
        </form>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <h2>Clientes por riesgo</h2>
          <small>{m?.version ?? 'Sin evaluaciones'}</small>
        </div>
        {predictions.loading ? (
          <Spinner />
        ) : predictions.error ? (
          <ErrorBox error={predictions.error} retry={predictions.reload} />
        ) : !predictions.data?.items.length ? (
          <Empty>Importa tus datos y evalúa los clientes para ver sus indicadores.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Indicador de abandono</th>
                  <th>Nivel</th>
                  <th>Explicación</th>
                </tr>
              </thead>
              <tbody>
                {predictions.data.items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.customer.name}</strong>
                      <small>{p.customer.externalId}</small>
                    </td>
                    <td>
                      <div className="risk-meter">
                        <div>
                          <span style={{ width: `${p.churnProbability * 100}%` }} />
                        </div>
                        <strong>{number(p.churnProbability * 100)}%</strong>
                      </div>
                    </td>
                    <td>
                      <Badge>{p.riskBand}</Badge>
                    </td>
                    <td>
                      <button onClick={() => setDetail(p.explanation)}>Ver factores</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} total={predictions.data?.total ?? 0} onPage={setPage} />
      </section>
      <p className="footnote">
        El entrenamiento necesita al menos 180 días de historial, 80 clientes y 20 ejemplos por clase.
        Abandono = ausencia de compra en los 90 días posteriores al corte. Las explicaciones no implican
        causalidad.
      </p>
      {detail != null && (
        <Modal title="Explicación y evaluación del modelo" onClose={() => setDetail(null)}>
          <JsonView value={detail} />
        </Modal>
      )}
    </>
  );
}
