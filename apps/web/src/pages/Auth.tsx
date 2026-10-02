import { useState, type FormEvent } from 'react';
import { ArrowRight, GitBranch, Layers, ShieldCheck, Sparkles } from 'lucide-react';
import { useSession } from '../lib/session';
import { ErrorBox } from '../components/ui';
export default function Auth() {
  const { login } = useSession();
  const [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError('');
    try {
      await login(body, register);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth">
      <div className="auth-story">
        <div className="brand">
          <Layers size={30} />
          <span>
            NexusFlow <b>AI</b>
          </span>
        </div>
        <div className="auth-copy">
          <div className="eyebrow">DATOS QUE SE CONVIERTEN EN ACCIONES</div>
          <h1>
            Tu empresa.
            <br />
            Más conectada.
            <br />
            <em>Más inteligente.</em>
          </h1>
          <p>Automatiza procesos, entiende a tus clientes y anticipa lo que viene desde un solo lugar.</p>
          <div className="auth-features">
            <span>
              <GitBranch size={18} /> Workflows visuales
            </span>
            <span>
              <Sparkles size={18} /> Inteligencia predictiva
            </span>
            <span>
              <ShieldCheck size={18} /> Control y trazabilidad
            </span>
          </div>
        </div>
        <small>NexusFlow AI · Plataforma de inteligencia empresarial</small>
      </div>
      <div className="auth-form">
        <div className="eyebrow">BIENVENIDO A NEXUSFLOW</div>
        <h2>{register ? 'Crea tu espacio de trabajo' : 'Todo empieza aquí'}</h2>
        <p>
          {register
            ? 'Conecta a tu equipo con una nueva forma de trabajar.'
            : 'Inicia sesión para continuar con tu organización.'}
        </p>
        {error && <ErrorBox error={error} />}
        <form onSubmit={submit}>
          {register && (
            <>
              <label>
                Organización
                <input
                  name="orgName"
                  required
                  minLength={2}
                  maxLength={100}
                  placeholder="Nombre de tu empresa"
                />
              </label>
              <label>
                Tu nombre
                <input name="name" required minLength={2} maxLength={100} autoComplete="name" />
              </label>
              <label>
                Moneda de los datos
                <select name="currency">
                  <option value="USD">USD · Dólar estadounidense</option>
                  <option value="CLP">CLP · Peso chileno</option>
                  <option value="EUR">EUR · Euro</option>
                </select>
              </label>
            </>
          )}
          <label>
            Correo electrónico
            <input name="email" type="email" required autoComplete="username" placeholder="tu@empresa.com" />
          </label>
          <label>
            Contraseña
            <input
              name="password"
              type="password"
              required
              minLength={register ? 12 : 1}
              maxLength={128}
              autoComplete={register ? 'new-password' : 'current-password'}
            />
          </label>
          {register && (
            <small>Al menos 12 caracteres y 3 tipos: mayúsculas, minúsculas, números o símbolos.</small>
          )}
          <button className="primary full" disabled={busy}>
            {busy ? 'Procesando…' : register ? 'Crear organización' : 'Iniciar sesión'}
            <ArrowRight size={17} />
          </button>
        </form>
        <button
          className="text-button"
          onClick={() => {
            setRegister(!register);
            setError('');
          }}
        >
          {register ? 'Ya tengo una cuenta' : 'Crear una organización'}
        </button>
        <div className="auth-note">
          <ShieldCheck size={16} /> Tus datos se mantienen dentro de tu organización.
        </div>
      </div>
    </div>
  );
}
