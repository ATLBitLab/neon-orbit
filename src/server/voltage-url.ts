/** Join an OpenAPI path beneath the configured API prefix (normally /v1). */
export function voltageUrl(baseUrl: string, path: string): string {
  if (path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error('Voltage API path must be relative')
  }
  const base = new URL(baseUrl)
  if (base.search || base.hash) throw new Error('Voltage API base URL cannot have a query or fragment')
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`
  return new URL(path, base).toString()
}
