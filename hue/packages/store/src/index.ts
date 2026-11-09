import type { ListableStore, SessionInfo } from './types.js'

export { memoryStore } from './memory.js'
export { sqliteStore, type SqliteStore } from './sqlite.js'
export type { ListableStore, SessionInfo } from './types.js'

/** 列出所有会话。不在端口里：loop 用不到，只有 runtime / CLI 需要。 */
export const listSessions = (s: ListableStore): AsyncIterable<SessionInfo> => s.sessions()
