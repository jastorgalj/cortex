/**
 * test/compose.test.ts — Task 3.2: Verifica que docker-compose.yml reenvía
 * las variables de entorno documentadas al servicio `server`.
 *
 * No ejecuta docker: lee el archivo con el paquete `yaml` y comprueba la
 * estructura del servicio `server.environment`.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { join } from 'node:path'

const composePath = join(import.meta.dir, '..', 'docker-compose.yml')
const raw = readFileSync(composePath, 'utf-8')
const compose = parse(raw) as {
  services: {
    server: {
      environment: Record<string, string>
    }
  }
}

const env = compose.services.server.environment

describe('docker-compose.yml: variables de entorno del servicio server', () => {
  test('contiene CORTEX_DUPLICATE_THRESHOLD', () => {
    expect(env).toHaveProperty('CORTEX_DUPLICATE_THRESHOLD')
  })

  test('contiene CORTEX_APPS', () => {
    expect(env).toHaveProperty('CORTEX_APPS')
  })

  test('contiene CORTEX_APP_ALIASES', () => {
    expect(env).toHaveProperty('CORTEX_APP_ALIASES')
  })

  test('contiene CORTEX_APP_MODE', () => {
    expect(env).toHaveProperty('CORTEX_APP_MODE')
  })

  test('contiene CORTEX_STRICT_NOTES', () => {
    expect(env).toHaveProperty('CORTEX_STRICT_NOTES')
  })

  test('contiene MCP_SESSION_TTL_MINUTES con defecto 1440', () => {
    expect(env).toHaveProperty('MCP_SESSION_TTL_MINUTES')
    expect(env['MCP_SESSION_TTL_MINUTES']).toBe('${MCP_SESSION_TTL_MINUTES:-1440}')
  })
})
