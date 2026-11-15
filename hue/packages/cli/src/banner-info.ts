/** 启动横幅要显示的环境信息，从 recipe 和命令行参数里取。 */
import { basename } from 'node:path'
import type { BannerInfo } from './tui/banner.js'
import { formatCwd, formatTokens } from './tui/theme.js'
import type { Recipe } from './recipe.js'

export function bannerInfo(o: { recipe: Recipe, version: string, branch?: string, session: string }): BannerInfo {
  const { recipe, version, branch, session } = o
  const { args } = recipe
  const model = recipe.getModel()
  const docker = args.sandbox === 'docker'
  const on = (v?: string) => (v ? '开' : '关')
  return {
    version,
    cwd: `${formatCwd(recipe.workdir)}${branch ? ` (${branch})` : ''}`,
    hasTask: recipe.tools.some(t => t.name === 'task'),
    rows: [
      ['模型', model.id, formatTokens(model.info.contextWindow)],
      ['沙箱', args.sandbox, docker ? `副本 ${recipe.copy}` : '当前目录'],
      ['策略', docker || args.yes ? 'yolo' : 'coding', docker || args.yes ? '不再询问' : '写入和命令先确认'],
      ['上下文', `技能 ${on(process.env.HUE_SKILLS)}`, `记忆 ${on(process.env.HUE_MEMORY)}`],
      ['会话', session, basename(recipe.dbPath)],
    ],
  }
}
