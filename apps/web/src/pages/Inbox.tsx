import { useState } from 'react';
import { patch } from '../lib/api';
import { useSession, canEdit } from '../lib/session';
import {
  Badge,
  Empty,
  ErrorBox,
  PageTitle,
  Pagination,
  Spinner,
  date,
  useAction,
  useResource,
} from '../components/ui';
interface Item {
  id: string;
  title: string;
  message?: string;
  description?: string;
  status: string;
  severity?: string;
  source: string;
  createdAt: string;
}
export default function Inbox() {
  const [tab, setTab] = useState('alerts'),
    [page, setPage] = useState(1);
  const resource = useResource<{ items: Item[]; total: number }>(`${tab}?page=${page}`),
    action = useAction(),
    { user } = useSession();
  return (
    <>
      <PageTitle
        eyebrow="CENTRO DE ACTIVIDAD"
        title="Lo que necesita tu atención"
        description="Gestiona las alertas y tareas que generan tus procesos."
      />
      <div className="tabs">
        {['alerts', 'tasks'].map((t) => (
          <button
            key={t}
            className={t === tab ? 'selected' : ''}
            onClick={() => {
              setTab(t);
              setPage(1);
            }}
          >
            {t === 'alerts' ? 'Alertas' : 'Tareas'}
          </button>
        ))}
      </div>
      <section className="panel">
        {resource.loading ? (
          <Spinner />
        ) : resource.error ? (
          <ErrorBox error={resource.error} retry={resource.reload} />
        ) : !resource.data?.items.length ? (
          <Empty>Tu bandeja está vacía.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Evento</th>
                  <th>Origen</th>
                  <th>Estado</th>
                  <th>Fecha</th>
                  <th>Actualizar</th>
                </tr>
              </thead>
              <tbody>
                {resource.data.items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <strong>{i.title}</strong>
                      <small>{i.message ?? i.description}</small>
                      {i.severity && <Badge>{i.severity}</Badge>}
                    </td>
                    <td>{i.source.startsWith('workflow:') ? 'Workflow' : i.source}</td>
                    <td>
                      <Badge>{i.status}</Badge>
                    </td>
                    <td>{date(i.createdAt)}</td>
                    <td>
                      <select
                        aria-label={`Estado de ${i.title}`}
                        disabled={!canEdit(user) || action.busy}
                        value={i.status}
                        onChange={(e) =>
                          action.run(async () => {
                            await patch(`${tab}/${i.id}`, { status: e.target.value });
                            resource.reload();
                          })
                        }
                      >
                        {(tab === 'alerts'
                          ? ['OPEN', 'ACKNOWLEDGED', 'RESOLVED']
                          : ['OPEN', 'IN_PROGRESS', 'DONE']
                        ).map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} total={resource.data?.total ?? 0} onPage={setPage} />
      </section>
    </>
  );
}
