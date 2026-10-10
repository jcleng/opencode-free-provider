import { getModels, PROVIDER } from './config.js'

// Split "provider/model" → { provider, model }. OpenAI ids are a single
// token, so an id without a slash is treated as a bare model id.
export function splitModelId(id) {
  if (typeof id !== 'string' || !id.trim()) return { provider: PROVIDER, model: '' }
  const idx = id.indexOf('/')
  if (idx < 0) return { provider: PROVIDER, model: id.trim() }
  return { provider: id.slice(0, idx), model: id.slice(idx + 1).trim() }
}

// Build the OpenAI-style model listing. id === `${PROVIDER}/${m.id}` so an
// agent can pass either "opencode-free/hy3-free" or just "hy3-free".
// The registry is populated live from the upstream /models endpoint (see
// getModels/refreshModels in config.js).
export function listModelsPayload() {
  return {
    object: 'list',
    data: getModels().map((m) => ({
      id: `${PROVIDER}/${m.id}`,
      object: 'model',
      created: 0,
      owned_by: 'opencode-zen-free',
      // extra, non-standard but harmless hints for agents that read them
      description: m.description,
      context_window: m.contextWindow,
    })),
  }
}

export function findModel(modelId) {
  const { model } = splitModelId(modelId)
  return getModels().find((m) => m.id === model) || null
}

export function isValidModel(modelId) {
  return findModel(modelId) !== null
}
