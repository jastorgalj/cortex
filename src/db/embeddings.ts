/**
 * Pipeline de embeddings — Decisión 4.
 * Modelo: Xenova/all-mpnet-base-v2 (768 dims, ONNX local).
 * Cache fuera de node_modules para sobrevivir reinstalaciones.
 */
import { join } from 'node:path'

const CACHE_DIR =
  process.env.MODEL_CACHE_DIR ??
  join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.model-cache', 'knowledge-mcp')

const MODEL_ID = 'Xenova/all-mpnet-base-v2'

// Lazy singleton — cargado la primera vez que se llama embed()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pipe: ((text: string, opts: Record<string, unknown>) => Promise<any>) | null = null
let _loading: Promise<void> | null = null

async function loadPipeline(): Promise<void> {
  // Import dinámico para que env.cacheDir se configure antes de descargar
  const { pipeline, env } = await import('@huggingface/transformers')
  env.cacheDir = CACHE_DIR
  const p = await pipeline('feature-extraction', MODEL_ID, { dtype: 'fp32' })
  _pipe = async (text: string, opts: Record<string, unknown>) => p(text, opts)
}

async function getPipeline(): Promise<(text: string, opts: Record<string, unknown>) => Promise<unknown>> {
  if (_pipe) return _pipe
  if (!_loading) _loading = loadPipeline()
  await _loading
  return _pipe!
}

/** Calcula el embedding normalizado (L2) del texto. Devuelve vector de 768 floats. */
export async function embed(text: string): Promise<number[]> {
  const pipe = await getPipeline()
  const output = await pipe(text, { pooling: 'mean', normalize: true })
  // output.data es Float32Array de 768 valores (tras mean pooling de un único input)
  return Array.from((output as { data: Float32Array }).data)
}

/** Indica si el modelo está ya cargado en memoria (útil para /health). */
export function isModelLoaded(): boolean {
  return _pipe !== null
}

/** Precalienta el pipeline cargando el modelo en memoria (llamar en beforeAll de tests). */
export async function warmup(): Promise<void> {
  await embed('warmup')
}

