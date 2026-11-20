/**
 * Model-kind matching and family heuristics.
 *
 * The adapter contract only carries `inputModalities`, and for a custom relay
 * that field is usually the provider's `defaultInput` (text) rather than a fact
 * about the model. When neither the adapter nor a verified learned fact knows
 * better, this module answers from conservative name rules for model families
 * whose capabilities are common knowledge (Claude, GPT-4o+, Gemini, Grok 4+,
 * VL/vision variants).
 *
 * Everything returned here is *inferred*: callers must label it as such so the
 * page never presents a guess as an adapter declaration.
 *
 * @module lib/capability-catalog
 */

import { normalizeModelId } from './model-id.js'

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

function nonChatKindOfName(text) {
  // The task matters more than the media it processes (e.g. bge-reranker,
  // image-embedding, or video-classification).
  if (RERANK_WORDS.test(text)) return 'rerank'
  if (EMBED_WORDS.test(text)) return 'embedding'
  if (CLASSIFIER_WORDS.test(text)) return 'classifier'
  if (TRANSLATION_WORDS.test(text)) return 'translation'
  if (VIDEO_WORDS.test(text)) return 'video'
  if (IMAGE_WORDS.test(text)) return 'image'
  if (AUDIO_WORDS.test(text)) return 'audio'
  return undefined
}

/** Coarse non-chat kind from the model ID, excluding the provider namespace. */
export function inferIdentifierKind(id) {
  return nonChatKindOfName(normalizeModelId(id).split(':', 1)[0])
}

/** Coarse kind from the ID first and the display name as a fallback. */
export function inferModelKind(id, name = '') {
  return inferIdentifierKind(id) ?? nonChatKindOfName(String(name ?? '').toLowerCase()) ??
    (String(id ?? '').trim() || String(name ?? '').trim() ? 'chat' : undefined)
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

/** Map a recognized model task declaration to the catalog vocabulary. */
export function kindOfType(type) {
  if (typeof type !== 'string') return undefined
  switch (type.trim().toLowerCase()) {
    case 'chat': case 'text': case 'completion': case 'language': return 'chat'
    case 'image': case 'image-generation': case 'imagegeneration': return 'image'
    case 'video': case 'video-generation': case 'videogeneration': return 'video'
    case 'embedding': case 'embeddings': case 'embed': return 'embedding'
    case 'rerank': case 'reranker': case 'reranking': return 'rerank'
    case 'audio': case 'speech': case 'tts': case 'transcription': return 'audio'
    case 'classifier': case 'moderation': case 'guard': case 'safety': return 'classifier'
    case 'translation': case 'translate': return 'translation'
    default: return undefined
  }
}

/** Kinds that produce assets instead of conversation turns. */
export function isGenerationKind(kind) {
  return kind === 'image' || kind === 'video' || kind === 'audio'
}

/** True when the kind should hide reasoning/context/text tags. */
export function isNonChatKind(kind) {
  return kind !== undefined && kind !== 'chat'
}
