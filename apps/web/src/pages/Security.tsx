import { useState } from 'react';
import { ShieldCheck, UserPlus } from 'lucide-react';
import { patch, post, type User } from '../lib/api';
import { useSession } from '../lib/session';
import {
  Badge,
  Empty,
  ErrorBox,
  JsonView,
  Modal,
  PageTitle,
  Pagination,
  Spinner,
  date,
  useAction,
  useResource,
} from '../components/ui';
interface ManagedUser extends User {
  isActive: boolean;
  lastLoginAt: string | null;
}
interface Campaign {
  id: string;
  name: string;
  authorizationRef: string;
  status: string;
  recipients: number;
  clicks: number;
  reports: number;
}
interface Audit {
  id: string;
  seq: number;
  action: string;
  resource: string | null;
  ip: string | null;
  createdAt: string;
}
export default function Security() {
  const { user: current } = useSession(),
    action = useAction();
  const [tab, setTab] = useState('users'),
    [createUser, setCreateUser] = useState(false),
    [campaignModal, setCampaignModal] = useState(false),
    [detail, setDetail] = useState<unknown>(null),
    [page, setPage] = useState(1),
    [targetIds, setTargetIds] = useState<string[]>([]);
  const users = useResource<ManagedUser[]>('users'),
    campaigns = useResource<Campaign[]>('security/campaigns'),
    audit = useResource<{ items: Audit[]; total: number }>(`security/audit?page=${page}`);
  function manageable(u: ManagedUser) {
    return current?.role === 'OWNER' || !['ADMIN', 'OWNER'].includes(u.role);
  }
  return (
    <>
      <PageTitle
        eyebrow="SECURITY CENTER"
        title="Confianza en cada acción"
        description="Administra accesos, verifica la auditoría y prepara simulaciones educativas autorizadas."
        actions={
          <button
            disabled={action.busy}
            onClick={() =>
              action.run(
                async () => setDetail(await post('security/audit/verify')),
                'Cadena de auditoría comprobada',
              )
            }
          >
            <ShieldCheck size={16} /> Verificar auditoría
          </button>
        }
      />
      <div className="tabs">
        {[
          ['users', 'Usuarios y permisos'],
          ['audit', 'Auditoría'],
          ['campaigns', 'Concientización'],
        ].map(([key, label]) => (
          <button key={key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'users' && (
        <section className="panel">
          <div className="panel-heading">
            <h2>Equipo de tu organización</h2>
            <button className="primary" onClick={() => setCreateUser(true)}>
              <UserPlus size={16} /> Agregar usuario
            </button>
          </div>
          {users.loading ? (
            <Spinner />
          ) : users.error ? (
            <ErrorBox error={users.error} retry={users.reload} />
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Persona</th>
                    <th>Rol</th>
                    <th>Cuenta</th>
                    <th>Último acceso</th>
                    <th>Sesiones</th>
                  </tr>
                </thead>
                <tbody>
                  {users.data?.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <strong>{u.name}</strong>
                        <small>{u.email}</small>
                      </td>
                      <td>
                        <select
                          aria-label={`Rol de ${u.name}`}
                          disabled={action.busy || !manageable(u) || current?.id === u.id}
                          value={u.role}
                          onChange={(e) =>
                            action.run(async () => {
                              await patch(`users/${u.id}`, { role: e.target.value });
                              users.reload();
                            })
                          }
                        >
                          {(current?.role === 'OWNER'
                            ? ['VIEWER', 'ANALYST', 'ADMIN', 'OWNER']
                            : [
                                'VIEWER',
                                'ANALYST',
                                ...(u.role === 'ADMIN' || u.role === 'OWNER' ? [u.role] : []),
                              ]
                          ).map((r) => (
                            <option key={r}>{r}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <button
                          disabled={action.busy || !manageable(u) || current?.id === u.id}
                          onClick={() =>
                            action.run(async () => {
                              await patch(`users/${u.id}`, { isActive: !u.isActive });
                              users.reload();
                            })
                          }
                        >
                          {u.isActive ? 'Desactivar' : 'Activar'}
                        </button>
                      </td>
                      <td>{date(u.lastLoginAt)}</td>
                      <td>
                        <button
                          disabled={action.busy || !manageable(u)}
                          onClick={() =>
                            action.run(async () => {
                              await post(`users/${u.id}/revoke-sessions`);
                              if (u.id === current?.id) window.dispatchEvent(new Event('session-expired'));
                            }, 'Sesiones revocadas')
                          }
                        >
                          Revocar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="footnote">
            VIEWER consulta · ANALYST importa y automatiza · ADMIN administra roles inferiores · OWNER
            administra la organización.
          </p>
        </section>
      )}
      {tab === 'audit' && (
        <section className="panel">
          <h2>Registro de actividades</h2>
          {audit.loading ? (
            <Spinner />
          ) : audit.error ? (
            <ErrorBox error={audit.error} retry={audit.reload} />
          ) : !audit.data?.items.length ? (
            <Empty>No hay eventos.</Empty>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Secuencia</th>
                    <th>Acción</th>
                    <th>Recurso</th>
                    <th>IP</th>
                    <th>Fecha</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data.items.map((a) => (
                    <tr key={a.id}>
                      <td>#{a.seq}</td>
                      <td>
                        <code>{a.action}</code>
                      </td>
                      <td>{a.resource ?? '—'}</td>
                      <td>{a.ip ?? '—'}</td>
                      <td>{date(a.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pagination page={page} total={audit.data?.total ?? 0} onPage={setPage} />
        </section>
      )}
      {tab === 'campaigns' && (
        <>
          <div className="notice">
            Simulaciones educativas con referencia de autorización. Los enlaces se entregan manualmente; no se
            envían correos ni se solicitan contraseñas. Caducan a los 30 días.
          </div>
          <section className="panel">
            <div className="panel-heading">
              <h2>Campañas de concientización</h2>
              <button className="primary" onClick={() => setCampaignModal(true)}>
                Nueva campaña
              </button>
            </div>
            {campaigns.loading ? (
              <Spinner />
            ) : campaigns.error ? (
              <ErrorBox error={campaigns.error} retry={campaigns.reload} />
            ) : !campaigns.data?.length ? (
              <Empty>No hay campañas creadas.</Empty>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Campaña</th>
                      <th>Estado</th>
                      <th>Participantes</th>
                      <th>Clics</th>
                      <th>Reportes</th>
                      <th>Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.data.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <strong>{c.name}</strong>
                          <small>{c.authorizationRef}</small>
                        </td>
                        <td>
                          <Badge>{c.status}</Badge>
                        </td>
                        <td>{c.recipients}</td>
                        <td>{c.clicks}</td>
                        <td>{c.reports}</td>
                        <td>
                          <button
                            disabled={action.busy || c.status === 'CLOSED'}
                            onClick={() =>
                              action.run(async () => {
                                await post(`security/campaigns/${c.id}/close`);
                                campaigns.reload();
                              })
                            }
                          >
                            Cerrar
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
      {createUser && (
        <Modal title="Agregar usuario" onClose={() => setCreateUser(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const values = Object.fromEntries(new FormData(e.currentTarget));
              void action.run(async () => {
                await post('users', values);
                users.reload();
                setCreateUser(false);
              }, 'Usuario creado');
            }}
          >
            <label>
              Nombre
              <input name="name" minLength={2} maxLength={100} required />
            </label>
            <label>
              Correo
              <input name="email" type="email" required />
            </label>
            <label>
              Contraseña temporal
              <input
                name="password"
                type="password"
                minLength={12}
                maxLength={128}
                required
                autoComplete="new-password"
              />
            </label>
            <small>Usa 12 caracteres y 3 tipos: mayúsculas, minúsculas, números o símbolos.</small>
            <label>
              Rol
              <select name="role">
                {(current?.role === 'OWNER'
                  ? ['VIEWER', 'ANALYST', 'ADMIN', 'OWNER']
                  : ['VIEWER', 'ANALYST']
                ).map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <button className="primary" disabled={action.busy}>
              Crear usuario
            </button>
          </form>
        </Modal>
      )}
      {campaignModal && (
        <Modal title="Crear simulación autorizada" onClose={() => setCampaignModal(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const values = Object.fromEntries(new FormData(e.currentTarget));
              void action.run(async () => {
                setDetail(await post('security/campaigns', { ...values, userIds: targetIds }));
                campaigns.reload();
                setCampaignModal(false);
              }, 'Guarda los enlaces; se muestran una sola vez');
            }}
          >
            <label>
              Nombre de la campaña
              <input name="name" required minLength={3} maxLength={100} />
            </label>
            <label>
              Referencia de autorización
              <input
                name="authorizationRef"
                required
                minLength={5}
                maxLength={200}
                placeholder="Ticket o documento de autorización"
              />
            </label>
            <fieldset>
              <legend>Destinatarios autorizados</legend>
              {users.data
                ?.filter((u) => u.isActive)
                .map((u) => (
                  <label className="checkbox" key={u.id}>
                    <input
                      type="checkbox"
                      checked={targetIds.includes(u.id)}
                      onChange={(e) =>
                        setTargetIds(
                          e.target.checked ? [...targetIds, u.id] : targetIds.filter((id) => id !== u.id),
                        )
                      }
                    />
                    {u.name}
                  </label>
                ))}
            </fieldset>
            <button className="primary" disabled={action.busy || !targetIds.length}>
              Crear y mostrar enlaces
            </button>
          </form>
        </Modal>
      )}
      {detail != null && (
        <Modal title="Resultado" onClose={() => setDetail(null)}>
          <JsonView value={detail} />
        </Modal>
      )}
    </>
  );
}

export function Settings() {
  const action = useAction(),
    { user } = useSession();
  return (
    <>
      <PageTitle eyebrow="MI CUENTA" title="Cuida tu acceso" description={`${user?.name} · ${user?.email}`} />
      <section className="panel narrow">
        <h2>Cambiar contraseña</h2>
        <p>Al cambiarla se cerrarán todas tus sesiones, incluida esta.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const values = Object.fromEntries(new FormData(e.currentTarget));
            void action.run(async () => {
              await post('auth/change-password', values);
              window.dispatchEvent(new Event('session-expired'));
            }, 'Contraseña actualizada. Inicia sesión nuevamente.');
          }}
        >
          <label>
            Contraseña actual
            <input name="currentPassword" type="password" required autoComplete="current-password" />
          </label>
          <label>
            Nueva contraseña
            <input
              name="newPassword"
              type="password"
              required
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
            />
          </label>
          <small>Al menos 12 caracteres y 3 tipos: mayúsculas, minúsculas, números o símbolos.</small>
          <button className="primary" disabled={action.busy}>
            Actualizar contraseña
          </button>
        </form>
      </section>
    </>
  );
}

export function Training() {
  const action = useAction(),
    [recorded, setRecorded] = useState(false);
  const token = window.location.hash.slice(1);
  return (
    <main className="training panel">
      <ShieldCheck size={40} />
      <div className="eyebrow">CONCIENTIZACIÓN DE SEGURIDAD</div>
      <h1>Reconoce las señales.</h1>
      <p>
        Este enlace pertenece a una simulación educativa autorizada por tu organización. Revisa el dominio,
        confirma quién envía el mensaje y reporta solicitudes sospechosas.
      </p>
      <p>Nunca entregues tu contraseña ni códigos de verificación desde un enlace recibido.</p>
      <div className="actions">
        <button
          disabled={action.busy || recorded}
          onClick={() =>
            action.run(async () => {
              await post('security/training/event', { token, event: 'clicked' });
              setRecorded(true);
            }, 'Participación registrada')
          }
        >
          Registrar participación
        </button>
        <button
          className="primary"
          disabled={action.busy}
          onClick={() =>
            action.run(
              () => post('security/training/event', { token, event: 'reported' }),
              'Reporte registrado',
            )
          }
        >
          Reportar enlace sospechoso
        </button>
      </div>
    </main>
  );
}
