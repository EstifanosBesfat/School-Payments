/** Read at call time so a production image does not bake the build machine's API URL. */
export function serverApiUrl(): string {
  const configured = process.env['API_URL'];
  if (typeof configured !== 'string') return 'http://localhost:4000';
  const trimmed = configured.trim();
  return trimmed.length > 0 ? trimmed : 'http://localhost:4000';
}
