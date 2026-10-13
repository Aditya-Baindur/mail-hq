export function mcpEnvironmentKey(connectionName: string) {
  const name = connectionName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'APP';
  return `${/^\d/.test(name) ? 'APP_' : ''}${name}_MAIL_KEY`;
}
