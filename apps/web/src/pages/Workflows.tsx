import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type NodeProps,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { GitBranch, Plus, Save, Play, ArrowLeft, Trash2 } from 'lucide-react';
import { api, post, put } from '../lib/api';
import { canEdit, isAdmin, useSession } from '../lib/session';
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
  number,
  useAction,
  useResource,
  useToast,
} from '../components/ui';
interface GraphNode {
  id: string;
  type: string;
  data: Record<string, unknown>;
  position?: { x: number; y: number };
}
interface Graph {
  nodes: GraphNode[];
  edges: Edge[];
}
interface Workflow {
  id: string;
  name: string;
  description: string;
  status: string;
  triggerType: string;
  version: number;
  graph: Graph;
  webhookSecret?: string;
  webhookPath?: string;
}
const catalog: Record<string, { label: string; data: Record<string, unknown> }> = {
  'trigger.manual': { label: 'Inicio manual', data: {} },
  'trigger.webhook': { label: 'Webhook entrante', data: {} },
  'trigger.schedule': { label: 'Programación', data: { cron: '0 9 * * *' } },
  'trigger.churn': { label: 'Riesgo de abandono', data: { minProbability: 0.7 } },
  'trigger.late_order': { label: 'Pedido atrasado', data: {} },
  condition: { label: 'Condición', data: { field: 'trigger.probability', op: 'gte', value: 0.7 } },
  transform: { label: 'Transformar datos', data: { assignments: { customer: '{{trigger.customerId}}' } } },
  'action.notify': {
    label: 'Crear alerta',
    data: { severity: 'INFO', title: 'Nueva actividad', message: 'El workflow se ejecutó correctamente.' },
  },
  'action.task': {
    label: 'Crear tarea',
    data: { title: 'Revisar cliente', description: '{{trigger.customerId}}' },
  },
  'action.report': { label: 'Generar reporte', data: { title: 'Reporte operativo' } },
  'action.http': {
    label: 'Llamar API',
    data: { url: 'https://api.example.com/events', method: 'POST', body: '{}' },
  },
};
const starter: Graph = {
  nodes: [
    { id: 'start', type: 'trigger.manual', data: {}, position: { x: 100, y: 180 } },
    { id: 'alert', type: 'action.notify', data: catalog['action.notify'].data, position: { x: 410, y: 180 } },
  ],
  edges: [{ id: 'start-alert', source: 'start', target: 'alert' }],
};
function FlowNode({ data, selected }: NodeProps<Node<{ kind: string; config: Record<string, unknown> }>>) {
  const kind = data.kind;
  return (
    <div
      className={`flow-node ${selected ? 'selected' : ''} ${kind.startsWith('trigger.') ? 'trigger' : ''}`}
    >
      {!kind.startsWith('trigger.') && <Handle type="target" position={Position.Left} />}
      <small>
        {kind.startsWith('trigger.') ? 'DISPARADOR' : kind.startsWith('action.') ? 'ACCIÓN' : 'LÓGICA'}
      </small>
      <strong>{catalog[kind]?.label ?? kind}</strong>
      <span>{String(data.config.title ?? data.config.cron ?? data.config.field ?? 'Configurable')}</span>
      {kind === 'condition' ? (
        <>
          <Handle
            type="source"
            id="true"
            position={Position.Right}
            style={{ top: '35%', background: '#37d6b4' }}
          />
          <Handle
            type="source"
            id="false"
            position={Position.Right}
            style={{ top: '75%', background: '#f47f86' }}
          />
        </>
      ) : (
        <Handle type="source" position={Position.Right} />
      )}
    </div>
  );
}
const nodeTypes = { flow: FlowNode };

export function Workflows() {
  const resource = useResource<Workflow[]>('workflows'),
    action = useAction(),
    { user } = useSession();
  const [secret, setSecret] = useState<unknown>(null),
    [payload, setPayload] = useState<Workflow | null>(null),
    [payloadText, setPayloadText] = useState('{}');
  return (
    <>
      <PageTitle
        eyebrow="FLOW ENGINE"
        title="De procesos a posibilidades"
        description="Diseña automatizaciones visuales y sigue cada ejecución de principio a fin."
        actions={
          <Link className={`button primary ${!canEdit(user) ? 'disabled' : ''}`} to="/workflows/new">
            <Plus size={16} /> Nuevo workflow
          </Link>
        }
      />
      {resource.loading ? (
        <Spinner />
      ) : resource.error ? (
        <ErrorBox error={resource.error} retry={resource.reload} />
      ) : !resource.data?.length ? (
        <section className="panel">
          <Empty>Crea tu primer workflow para automatizar una alerta, tarea o reporte.</Empty>
        </section>
      ) : (
        <div className="workflow-grid">
          {resource.data.map((w) => (
            <section className="panel workflow-card" key={w.id}>
              <div className="workflow-icon">
                <GitBranch size={25} />
              </div>
              <div className="workflow-top">
                <Badge>{w.status}</Badge>
                <small>v{w.version}</small>
              </div>
              <h2>{w.name}</h2>
              <p>{w.description || 'Automatización de tu organización'}</p>
              <div className="workflow-meta">
                <span>{catalog[w.triggerType]?.label}</span>
                <span>{w.graph.nodes.length} nodos</span>
              </div>
              <div className="actions">
                <Link className="button" to={`/workflows/${w.id}`}>
                  Abrir editor
                </Link>
                <button
                  aria-label={`Ejecutar ${w.name}`}
                  disabled={!canEdit(user) || action.busy}
                  onClick={() => setPayload(w)}
                >
                  <Play size={16} />
                </button>
                <button
                  disabled={!canEdit(user) || action.busy}
                  onClick={() =>
                    action.run(async () => {
                      await post(`workflows/${w.id}/${w.status === 'ACTIVE' ? 'pause' : 'activate'}`);
                      resource.reload();
                    })
                  }
                >
                  {w.status === 'ACTIVE' ? 'Pausar' : 'Activar'}
                </button>
              </div>
              {isAdmin(user) && (
                <div className="actions subtle-actions">
                  {w.webhookPath && (
                    <button
                      disabled={action.busy}
                      onClick={() =>
                        action.run(
                          async () => setSecret(await post(`workflows/${w.id}/webhook-secret`)),
                          'Secreto renovado',
                        )
                      }
                    >
                      Renovar secreto
                    </button>
                  )}
                  <button
                    className="danger"
                    disabled={action.busy}
                    onClick={() => {
                      if (window.confirm(`¿Eliminar "${w.name}" y su historial de ejecuciones?`))
                        void action.run(async () => {
                          await api(`workflows/${w.id}`, { method: 'DELETE' });
                          resource.reload();
                        }, 'Workflow eliminado');
                    }}
                  >
                    <Trash2 size={14} /> Eliminar
                  </button>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
      {payload && (
        <Modal title={`Ejecutar ${payload.name}`} onClose={() => setPayload(null)}>
          <label>
            Datos de entrada (objeto JSON)
            <textarea rows={7} value={payloadText} onChange={(e) => setPayloadText(e.target.value)} />
          </label>
          <button
            className="primary"
            disabled={action.busy}
            onClick={() =>
              action.run(async () => {
                const p: unknown = JSON.parse(payloadText);
                if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Usa un objeto JSON');
                await post(`workflows/${payload.id}/run`, { payload: p });
                setPayload(null);
              }, 'Ejecución encolada; consulta el historial')
            }
          >
            Ejecutar
          </button>
        </Modal>
      )}
      {secret != null && (
        <Modal title="Secreto de webhook" onClose={() => setSecret(null)}>
          <p>Guarda el secreto en un lugar seguro. Se muestra una sola vez.</p>
          <JsonView value={secret} />
        </Modal>
      )}
    </>
  );
}

function EditorInner() {
  const { id } = useParams(),
    navigate = useNavigate(),
    { user } = useSession(),
    toast = useToast(),
    action = useAction();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]),
    [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [name, setName] = useState('Nueva automatización'),
    [description, setDescription] = useState(''),
    [selected, setSelected] = useState<string | null>(null),
    [config, setConfig] = useState('{}'),
    [kind, setKind] = useState('action.task'),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [secret, setSecret] = useState<unknown>(null),
    [savedId, setSavedId] = useState<string | null>(id === 'new' ? null : (id ?? null));
  const editable = canEdit(user);
  const loadGraph = useCallback(
    (graph: Graph) => {
      setNodes(
        graph.nodes.map((n) => ({
          id: n.id,
          type: 'flow',
          position: n.position ?? { x: 100, y: 100 },
          data: { kind: n.type, config: n.data },
        })),
      );
      setEdges(graph.edges);
    },
    [setNodes, setEdges],
  );
  useEffect(() => {
    let alive = true;
    if (id === 'new') {
      loadGraph(starter);
      setLoading(false);
    } else
      api<Workflow>(`workflows/${id}`)
        .then((w) => {
          if (alive) {
            setName(w.name);
            setDescription(w.description ?? '');
            loadGraph(w.graph);
          }
        })
        .catch((e: Error) => {
          if (alive) setError(e.message);
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    return () => {
      alive = false;
    };
  }, [id, loadGraph]);
  const selectNode = (_: unknown, node: Node) => {
    setSelected(node.id);
    setConfig(JSON.stringify(node.data.config, null, 2));
  };
  function applyConfig() {
    try {
      const parsed: unknown = JSON.parse(config);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Usa un objeto JSON');
      setNodes((ns) =>
        ns.map((n) => (n.id === selected ? { ...n, data: { ...n.data, config: parsed } } : n)),
      );
      toast('Configuración aplicada. Guarda el workflow para persistirla.');
    } catch (e) {
      toast((e as Error).message, true);
    }
  }
  async function save() {
    await action.run(async () => {
      const graph = {
        nodes: nodes.map((n) => ({ id: n.id, type: n.data.kind, data: n.data.config, position: n.position })),
        edges: edges.map(({ id, source, target, sourceHandle }) => ({ id, source, target, sourceHandle })),
      };
      const body = { name, description, graph };
      const w = savedId
        ? await put<Workflow>(`workflows/${savedId}`, body)
        : await post<Workflow>('workflows', body);
      setSavedId(w.id);
      if (w.webhookSecret) setSecret({ webhookPath: w.webhookPath, webhookSecret: w.webhookSecret });
      if (id === 'new') navigate(`/workflows/${w.id}`, { replace: true });
    });
  }
  if (loading) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  return (
    <>
      <PageTitle
        eyebrow="FLOW ENGINE / EDITOR"
        title={name}
        description="Conecta nodos arrastrando sus puntos de salida. Las condiciones tienen ramas verdadera y falsa."
        actions={
          <>
            <Link className="button" to="/workflows">
              <ArrowLeft size={16} /> Volver
            </Link>
            <button className="primary" disabled={!editable || action.busy} onClick={save}>
              <Save size={16} /> Guardar workflow
            </button>
          </>
        }
      />
      <div className="editor-meta">
        <label>
          Nombre
          <input
            maxLength={100}
            minLength={2}
            value={name}
            disabled={!editable}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Descripción
          <input
            maxLength={500}
            value={description}
            disabled={!editable}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      </div>
      <div className="editor">
        <div className="canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={editable ? onNodesChange : undefined}
            onEdgesChange={editable ? onEdgesChange : undefined}
            onConnect={(c: Connection) => {
              if (editable) setEdges((es) => addEdge(c, es));
            }}
            onNodeClick={selectNode}
            nodesDraggable={editable}
            nodesConnectable={editable}
            deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
            fitView
          >
            <Background color="#2a3a48" gap={24} />
            <Controls />
          </ReactFlow>
        </div>
        <aside className="node-panel">
          <h2>Construye tu flujo</h2>
          <label>
            Tipo de nodo
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(catalog).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="full"
            disabled={!editable || nodes.length >= 50}
            onClick={() =>
              setNodes((ns) => [
                ...ns,
                {
                  id: crypto.randomUUID(),
                  type: 'flow',
                  position: { x: 180 + ns.length * 35, y: 100 + ns.length * 40 },
                  data: { kind, config: structuredClone(catalog[kind].data) },
                },
              ])
            }
          >
            <Plus size={16} /> Agregar nodo
          </button>
          <hr />
          {selected ? (
            <>
              <h3>Configuración del nodo</h3>
              <label>
                Campos (JSON)
                <textarea
                  rows={13}
                  value={config}
                  disabled={!editable}
                  onChange={(e) => setConfig(e.target.value)}
                />
              </label>
              <button className="full" disabled={!editable} onClick={applyConfig}>
                Aplicar configuración
              </button>
              <button
                className="danger full"
                disabled={!editable}
                onClick={() => {
                  setNodes((ns) => ns.filter((n) => n.id !== selected));
                  setEdges((es) => es.filter((e) => e.source !== selected && e.target !== selected));
                  setSelected(null);
                }}
              >
                Eliminar nodo
              </button>
              <p className="footnote">
                Usa {'{{trigger.customerId}}'} o {'{{trigger.probability}}'} en textos. Cron usa UTC y cinco
                campos.
              </p>
            </>
          ) : (
            <p>Selecciona un nodo para editar sus campos.</p>
          )}
          <small>Un solo disparador por flujo. Máximo 50 nodos. No se permiten ciclos.</small>
        </aside>
      </div>
      {secret != null && (
        <Modal title="Guarda tu secreto de webhook" onClose={() => setSecret(null)}>
          <JsonView value={secret} />
        </Modal>
      )}
    </>
  );
}
export function WorkflowEditor() {
  return (
    <ReactFlowProvider>
      <EditorInner />
    </ReactFlowProvider>
  );
}

interface Run {
  id: string;
  workflow: { name: string };
  status: string;
  attempts: number;
  durationMs: number | null;
  createdAt: string;
  error: string | null;
}
export function Runs() {
  const [page, setPage] = useState(1),
    [detail, setDetail] = useState<unknown>(null);
  const resource = useResource<{ items: Run[]; total: number }>(`runs?page=${page}`),
    action = useAction();
  useEffect(() => {
    const timer = setInterval(resource.reload, 10000);
    return () => clearInterval(timer);
  }, [resource.reload]);
  return (
    <>
      <PageTitle
        eyebrow="FLOW ENGINE / EJECUCIONES"
        title="Cada paso, visible"
        description="Consulta resultados, duración y errores de tus automatizaciones."
        actions={<button onClick={resource.reload}>Actualizar</button>}
      />
      <section className="panel">
        {resource.loading && !resource.data ? (
          <Spinner />
        ) : resource.error ? (
          <ErrorBox error={resource.error} retry={resource.reload} />
        ) : !resource.data?.items.length ? (
          <Empty>No hay ejecuciones registradas.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Estado</th>
                  <th>Duración</th>
                  <th>Intentos</th>
                  <th>Inicio</th>
                  <th>Detalle</th>
                </tr>
              </thead>
              <tbody>
                {resource.data.items.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.workflow.name}</strong>
                      {r.error && <small className="error-text">{r.error}</small>}
                    </td>
                    <td>
                      <Badge>{r.status}</Badge>
                    </td>
                    <td>{number(r.durationMs)} ms</td>
                    <td>{r.attempts}</td>
                    <td>{date(r.createdAt)}</td>
                    <td>
                      <button
                        disabled={action.busy}
                        onClick={() =>
                          action.run(async () => setDetail(await api(`runs/${r.id}`)), 'Ejecución cargada')
                        }
                      >
                        Ver pasos
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
      {detail != null && (
        <Modal title="Detalle de ejecución" onClose={() => setDetail(null)}>
          <JsonView value={detail} />
        </Modal>
      )}
    </>
  );
}
