import type { safeFetch } from './ssrf';

/** Token de inyección del cliente HTTP saliente (siempre `safeFetch` en producción; sustituible en pruebas). */
export const HTTP_CLIENT = Symbol('HTTP_CLIENT');
export type HttpClient = typeof safeFetch;
