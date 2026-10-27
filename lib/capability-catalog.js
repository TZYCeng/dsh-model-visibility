/**
 * Catalog matching and family heuristics.
 *
 * The adapter contract only carries `inputModalities`, and for a custom relay
 * that field is usually the provider's `defaultInput` (text) rather than a fact
 * about the model. This module fills that gap from two places, in order:
 *
 * 1. the pi-ai / models.dev snapshot in `model-catalog.js` (exact id match
 *    after normalizing aggregator prefixes and request suffixes),
 * 2. conservative name rules for model families whose capabilities are common
 *    knowledge (Claude, GPT-4o+, Gemini, Grok 4+, VL/vision variants).
 *
 * Everything returned here is *inferred*: callers must label it as such so the
 * page never presents a guess as an adapter declaration.
 *
 * @module lib/capability-catalog
 */

import { CATALOG_GENERATED_AT, CATALOG_PI_AI_VERSION, MODEL_CATALOG } from './model-catalog.js'

export { CATALOG_GENERATED_AT, CATALOG_PI_AI_VERSION, MODEL_CATALOG }

/** Kinds the page knows how to label. */
export const MODEL_KINDS = Object.freeze([
  'chat',
  'image',
  'video',
  'embedding',
  'rerank',
  'audio',
  'classifier',
  'translation',
])

const IMAGE_WORDS = /(^|[-_./\s])(image|imagen|images|dall-?e|flux|sdxl|stable-?diffusion|midjourney|mj|seedream|ideogram|recraft|nano-?banana|photon|drawing|text2image|txt2img)([-_./\s]|$)/
const VIDEO_WORDS = /(^|[-_./\s])(video|sora|veo|kling|hailuo|seedance|pika|runway|vidu|jimeng|wan2|wanx|ltx|mochi|movie|text2video|txt2video)([-_./\s]|$)/
const EMBED_WORDS = /(^|[-_./\s])(embed|embedding|embeddings|bge|gte|e5|voyage|jina|nv-embed|text-embedding)([-_./\s]|$)/
const RERANK_WORDS = /(^|[-_./\s])(rerank|reranker|reranking)([-_./\s]|$)/
const AUDIO_WORDS = /(^|[-_./\s])(tts|speech|asr|whisper|transcribe|transcription|audio|voice|speech-to-text|text-to-speech)([-_./\s]|$)/
const CLASSIFIER_WORDS = /(^|[-_./\s])(guard|safety|moderation|classifier|censor|content-safety|prompt-guard)([-_./\s]|$)/
const TRANSLATION_WORDS = /(^|[-_./\s])(translate|translation|translator)([-_./\s]|$)/

const VISION_WORDS = /(^|[-_./\s])(vl|vision|visual|omni|multimodal|mm)([-_./\s]|$)|llava|pixtral|internvl|molmo|idefics|qwen[\d.]*-?vl|glm-[\d.]+v|kimi-.*-vl/

/** Strip aggregator namespaces, request suffixes and resolution variants. */
export function normalizeModelId(value) {
  let id = String(value ?? '').trim().toLowerCase()
  if (id === '') return ''
  id = id.replace(/^~/, '')
  id = id.replace(/:(batch|free|extended|thinking|online|nitro)$/g, '')
  id = id.replace(/-(free|batch)$/, '')
  const slash = id.lastIndexOf('/')
  if (slash !== -1) id = id.slice(slash + 1)
  id = id.replace(/^(global|us|eu|apac|jp|au|ca)\./, '')
  id = id.replace(/^(anthropic|openai|google|xai|x-ai|meta|mistralai|moonshotai|minimax|nvidia|qwen|z-ai|zai|deepseek|bytedance-seed)\./, '')
  return id
}

/** Lookup keys for one model id, most specific first. */
export function modelIdVariants(value) {
  const base = normalizeModelId(value)
  if (base === '') return []
  const variants = [base]
  const withoutResolution = base.replace(/-(4k|2k|8k|hd|uhd)$/, '')
  if (withoutResolution !== base) variants.push(withoutResolution)
  const withoutSuffix = withoutResolution.replace(/-(latest|preview|new)$/, '')
  if (!variants.includes(withoutSuffix)) variants.push(withoutSuffix)
  const compact = base.replace(/[^a-z0-9]+/g, '')
  if (compact !== '' && !variants.includes(compact)) variants.push(compact)
  return variants
}

/** Exact/alias index over the generated snapshot. */
const INDEX = (() => {
  const index = new Map()
  for (const [id, entry] of Object.entries(MODEL_CATALOG)) {
    for (const variant of modelIdVariants(id)) {
      if (!index.has(variant)) index.set(variant, { id, ...entry })
    }
  }
  return index
})()

/**
 * Find the snapshot entry for one model id.
 * @param value - model id as any provider spells it.
 * @returns `{ id, type, input?, output?, reasoning?, contextWindow?, maxTokens?, provider? }` or undefined.
 */
export function lookupCatalogModel(value) {
  for (const variant of modelIdVariants(value)) {
    const found = INDEX.get(variant)
    if (found !== undefined) return found
  }
  return undefined
}

/** Coarse kind from the id/name alone. */
export function inferModelKind(id, name = '') {
  const text = `${String(id ?? '')} ${String(name ?? '')}`.toLowerCase()
  if (text.trim() === '') return undefined
  if (VIDEO_WORDS.test(text)) return 'video'
  if (IMAGE_WORDS.test(text)) return 'image'
  if (RERANK_WORDS.test(text)) return 'rerank'
  if (EMBED_WORDS.test(text)) return 'embedding'
  if (AUDIO_WORDS.test(text)) return 'audio'
  if (CLASSIFIER_WORDS.test(text)) return 'classifier'
  if (TRANSLATION_WORDS.test(text)) return 'translation'
  return 'chat'
}

/** Modalities inferred from a chat model family; never claims text-only. */
export function inferInputModalities(id, name = '') {
  const text = `${String(id ?? '')} ${String(name ?? '')}`.toLowerCase()
  if (VISION_WORDS.test(text)) return ['text', 'image']
  if (/claude|fable|opus|sonnet|haiku/.test(text)) return ['text', 'image']
  if (/gpt-4o|gpt-4\.1|gpt-5|gpt-6|chatgpt/.test(text)) return ['text', 'image']
  if (/gemini/.test(text)) return ['text', 'image']
  if (/grok-[3-9]/.test(text)) return ['text', 'image']
  if (/llama-4|llama-3\.2-vision/.test(text)) return ['text', 'image']
  return undefined
}

/** Kinds that produce assets instead of conversation turns. */
export function isGenerationKind(kind) {
  return kind === 'image' || kind === 'video' || kind === 'audio'
}

/** True when the kind should hide reasoning/context/text tags. */
export function isNonChatKind(kind) {
  return kind !== undefined && kind !== 'chat'
}
