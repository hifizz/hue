/** 可序列化的值。core 里所有会进事件日志的东西都必须是 Json。 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type JsonObject = { [key: string]: Json }

/** JSON Schema（2020-12）。core 不带校验器，只当数据传。 */
export type JsonSchema = JsonObject

/**
 * 不透明的 provider 元数据，必须原样回传给同一个 provider。
 * 例：Anthropic thinking 的 signature、OpenAI reasoning 的 encrypted id。
 * 外层 key 是 provider 名，避免多 provider 互相覆盖。
 */
export type ProviderMetadata = Record<string, JsonObject>
