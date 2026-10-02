import { useState } from 'react';
import { FileSpreadsheet, Upload, Download } from 'lucide-react';
import { api, post } from '../lib/api';
import { useSession, canEdit } from '../lib/session';
import {
  Badge,
  Empty,
  ErrorBox,
  JsonView,
  PageTitle,
  Spinner,
  date,
  useResource,
  useAction,
} from '../components/ui';
interface ImportJob {
  id: string;
  filename: string;
  status: string;
  importedRows: number;
  rejectedRows: number;
  totalRows: number;
  createdAt: string;
}
interface Report {
  fatal?: string;
  dryRun: boolean;
  totalRows: number;
  validRows: number;
  importedRows: number;
  rejectedRows: number;
  errors: unknown[];
}
export default function Imports() {
  const { user } = useSession();
  const imports = useResource<ImportJob[]>('imports');
  const [file, setFile] = useState<File | null>(null),
    [report, setReport] = useState<Report | null>(null),
    [summary, setSummary] = useState<unknown>(null);
  const action = useAction();
  async function upload(dryRun: boolean) {
    if (!file) return;
    await action.run(
      async () => {
        const body = new FormData();
        body.append('file', file);
        const r = await api<Report>(`imports/transactions?dryRun=${dryRun}`, { method: 'POST', body });
        setReport(r);
        if (!dryRun) imports.reload();
        if (r.fatal) throw new Error(r.fatal);
      },
      dryRun ? 'Validación completada' : 'Importación completada',
    );
  }
  function sample() {
    const today = new Date().toISOString().slice(0, 10);
    const content = `customer_id,customer_name,email,transaction_id,amount,currency,date\nC001,Cliente ejemplo,cliente@example.com,T001,25000,${user?.currency ?? 'USD'},${today}\n`;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([content], { type: 'text/csv' }));
    link.download = 'plantilla-transacciones.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  }
  return (
    <>
      <PageTitle
        eyebrow="AUTOOPS"
        title="Tus datos, conectados"
        description="Importa transacciones, revisa su calidad y consolida reportes de tu operación."
        actions={
          <button onClick={sample}>
            <Download size={16} /> Descargar plantilla
          </button>
        }
      />
      <div className="import-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Importar transacciones</h2>
              <p>CSV · Máximo 5 MB y 50.000 filas · {user?.currency}</p>
            </div>
            <FileSpreadsheet size={24} />
          </div>
          <label className="dropzone">
            <Upload size={32} />
            <strong>{file?.name ?? 'Selecciona un archivo CSV'}</strong>
            <span>Comprueba los datos antes de importarlos</span>
            <input
              aria-label="Archivo de transacciones CSV"
              type="file"
              accept=".csv,text/csv"
              disabled={!canEdit(user) || action.busy}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setReport(null);
              }}
            />
          </label>
          <div className="actions">
            <button disabled={!file || action.busy || !canEdit(user)} onClick={() => upload(true)}>
              Validar archivo
            </button>
            <button
              className="primary"
              disabled={!file || action.busy || !canEdit(user) || !report?.dryRun || !!report?.fatal}
              onClick={() => upload(false)}
            >
              Importar datos
            </button>
          </div>
          <p className="footnote">
            Los IDs de transacción existentes se omiten. Las filas inválidas se rechazan y aparecen en el
            reporte. Todos los importes deben estar en la moneda de la organización.
          </p>
        </section>
        <section className="panel">
          <div className="eyebrow">REPORTE CONSOLIDADO</div>
          <h2>Una visión de toda la operación</h2>
          <p>
            Reúne indicadores comerciales, logística, calidad de datos y alertas abiertas. El resultado se
            guarda en tu bandeja de alertas.
          </p>
          <button
            disabled={action.busy || !canEdit(user)}
            onClick={() =>
              action.run(async () => setSummary(await post('reports/generate')), 'Reporte generado')
            }
          >
            Generar reporte
          </button>
          {summary != null && <JsonView value={summary} />}
        </section>
      </div>
      {report && (
        <section className="panel">
          <h2>Resultado de {report.dryRun ? 'validación' : 'importación'}</h2>
          {report.fatal && <ErrorBox error={report.fatal} />}
          <JsonView value={report} />
        </section>
      )}
      <section className="panel">
        <div className="panel-heading">
          <h2>Historial de importaciones</h2>
          <button onClick={imports.reload}>Actualizar</button>
        </div>
        {imports.loading ? (
          <Spinner />
        ) : imports.error ? (
          <ErrorBox error={imports.error} retry={imports.reload} />
        ) : !imports.data?.length ? (
          <Empty>No se han importado archivos.</Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Archivo</th>
                  <th>Estado</th>
                  <th>Filas</th>
                  <th>Importadas</th>
                  <th>Rechazadas</th>
                  <th>Fecha</th>
                </tr>
              </thead>
              <tbody>
                {imports.data.map((i) => (
                  <tr key={i.id}>
                    <td>{i.filename}</td>
                    <td>
                      <Badge>{i.status}</Badge>
                    </td>
                    <td>{i.totalRows}</td>
                    <td>{i.importedRows}</td>
                    <td>{i.rejectedRows}</td>
                    <td>{date(i.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
