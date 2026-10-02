import { useState } from 'react';
import { Plug, Plus } from 'lucide-react';
import { api, post } from '../lib/api';
import { isAdmin, useSession } from '../lib/session';
import { Empty, ErrorBox, Modal, PageTitle, Spinner, date, useAction, useResource } from '../components/ui';
interface Integration {
  id: string;
  name: string;
  baseUrl: string;
  createdAt: string;
}
export default function Integrations() {
  const { user } = useSession(),
    action = useAction(),
    resource = useResource<Integration[]>('integrations');
  const [create, setCreate] = useState(false),
    [headers, setHeaders] = useState('{}');
  return (
    <>
      <PageTitle
        eyebrow="AUTOOPS / INTEGRACIONES"
        title="Conecta tus herramientas"
        description="Guarda credenciales cifradas para usarlas en acciones HTTP de tus workflows."
        actions={
          isAdmin(user) && (
            <button className="primary" onClick={() => setCreate(true)}>
              <Plus size={16} /> Nueva integración
            </button>
          )
        }
      />
      <div className="notice">
        <Plug size={18} />
        El operador debe habilitar los dominios en HTTP_ACTION_ALLOWLIST. Solo se permiten destinos HTTPS
        públicos, sin redirecciones.
      </div>
      <section className="panel">
        {resource.loading ? (
          <Spinner />
        ) : resource.error ? (
          <ErrorBox error={resource.error} retry={resource.reload} />
        ) : !resource.data?.length ? (
          <Empty>No hay integraciones configuradas.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Integración</th>
                  <th>Destino</th>
                  <th>ID para el nodo HTTP</th>
                  <th>Fecha</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody>
                {resource.data.map((i) => (
                  <tr key={i.id}>
                    <td>{i.name}</td>
                    <td>{i.baseUrl}</td>
                    <td>
                      <code>{i.id}</code>
                    </td>
                    <td>{date(i.createdAt)}</td>
                    <td>
                      <button
                        disabled={!isAdmin(user) || action.busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              `¿Eliminar la integración ${i.name}? Los workflows que la usen fallarán hasta actualizarse.`,
                            )
                          )
                            void action.run(async () => {
                              await api(`integrations/${i.id}`, { method: 'DELETE' });
                              resource.reload();
                            }, 'Integración eliminada');
                        }}
                      >
                        Eliminar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="footnote">
        En el nodo «Llamar API», agrega el campo integrationId con el ID de esta tabla. La URL del nodo debe
        tener el mismo dominio y puerto que la integración. Las cabeceras secretas se agregan durante la
        ejecución y nunca se devuelven al navegador.
      </p>
      {create && (
        <Modal
          title="Nueva integración"
          onClose={() => {
            setCreate(false);
            setHeaders('{}');
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const values = Object.fromEntries(new FormData(e.currentTarget));
              void action.run(async () => {
                await post('integrations', { ...values, headers: JSON.parse(headers) });
                setCreate(false);
                setHeaders('{}');
                resource.reload();
              }, 'Credenciales cifradas y guardadas');
            }}
          >
            <label>
              Nombre
              <input name="name" required minLength={2} maxLength={100} />
            </label>
            <label>
              URL base
              <input name="baseUrl" type="url" required placeholder="https://api.empresa.com" />
            </label>
            <label>
              Cabeceras de autenticación (JSON)
              <textarea
                value={headers}
                rows={6}
                onChange={(e) => setHeaders(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                placeholder={'{"Authorization":"Bearer …"}'}
              />
            </label>
            <p className="footnote">
              Se guardan cifradas con AES-256-GCM. Para rotar credenciales, crea una nueva integración y
              actualiza el nodo.
            </p>
            <button className="primary" disabled={action.busy}>
              Guardar integración
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
