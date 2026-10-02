/**
 * Mitiga CSV/Formula Injection (OWASP): las celdas que empiezan por = + - @ TAB o CR
 * se prefijan con una comilla simple para que Excel/Sheets no las interpreten como fórmulas.
 * También elimina caracteres de control.
 */
export function sanitizeCell(value: string): string {
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}
