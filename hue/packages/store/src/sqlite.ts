import type { DatabaseSync } from 'node:sqlite'
import type { HueEvent } from '@hue/core'
import { checkAppend, parseRow } from './check.js'
import { info } from './memory.js'
import type { ListableStore, SessionInfo } from './types.js'

const PAGE = 500 // 每次从库里取这么多行：大会话不会一次性进内存，也不会在 await 期间长时间占着一个读游标

export interface SqliteStore extends ListableStore { close(): void }

/**
 * 一张表，事件原样存成 JSON（含 v），不存派生的消息快照：快照可以随时由 fold 重算，事件丢了就回不来。
 * type / at 单独成列只是为了不解析 JSON 就能查。
 *
 * 崩溃安全靠两件事：
 * - 一批事件在一个事务里：进程被 kill -9 时，事务要么整个提交要么整个回滚，不会留下半批。
 * - synchronous=FULL：append 返回前已经 fsync。WAL 模式下 NORMAL 也扛得住进程崩溃，但扛不住断电，
 *   而"写前日志"要的就是返回之后数据一定在。
 */
export function sqliteStore(path: string): SqliteStore {
  // 运行时再取：没有 node:sqlite 的 Node（< 22.5）也能 import 这个包，只在真的用 sqlite 时才报错。
  const sqlite = process.getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined
  if (!sqlite) throw new Error(`sqliteStore needs node:sqlite (Node >= 22.5); this is Node ${process.versions.node}. Use memoryStore() or upgrade Node.`)
  const db: DatabaseSync = new sqlite.DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL, body_json TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    ) WITHOUT ROWID;
  `)
  const maxSeq = db.prepare('SELECT MAX(seq) AS m FROM events WHERE session_id = ?')
  const insert = db.prepare('INSERT INTO events (session_id, seq, type, at, body_json) VALUES (?, ?, ?, ?, ?)')
  const page = db.prepare('SELECT seq, body_json FROM events WHERE session_id = ? AND seq >= ? ORDER BY seq LIMIT ?')
  const overview = db.prepare('SELECT session_id AS id, MAX(seq) AS last FROM events GROUP BY session_id')
  const at = db.prepare('SELECT body_json FROM events WHERE session_id = ? AND seq = ?')
  const last = (sid: string) => Number((maxSeq.get(sid) as { m: number | null }).m ?? 0)

  return {
    specVersion: 'hue.store.v1',
    async append(events: HueEvent[]) {
      if (events.length === 0) return
      // BEGIN IMMEDIATE：一开始就拿写锁。先校验后写入之间不会有别的连接插进来，
      // 两个进程同时写同一会话时，后到的会因为 seq 对不上被拒绝，而不是悄悄交错。
      db.exec('BEGIN IMMEDIATE')
      try {
        checkAppend(events, last)
        for (const e of events) insert.run(e.sessionId, e.seq, e.type, e.at, JSON.stringify(e))
        db.exec('COMMIT')
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
    async *read(sessionId, opts) {
      let from = opts?.fromSeq ?? 1
      while (true) {
        const rows = page.all(sessionId, from, PAGE) as Array<{ seq: number; body_json: string }>
        for (const r of rows) yield parseRow(sessionId, r.seq, r.body_json)
        if (rows.length < PAGE) return
        from = rows[rows.length - 1]!.seq + 1
      }
    },
    async lastSeq(sessionId) { return last(sessionId) },
    async *sessions(): AsyncIterable<SessionInfo> {
      for (const r of overview.all() as Array<{ id: string; last: number }>) {
        const body = (seq: number) => parseRow(r.id, seq, (at.get(r.id, seq) as { body_json: string }).body_json)
        yield info(r.id, r.last, body(1), body(r.last))
      }
    },
    close() { db.close() },
  }
}

