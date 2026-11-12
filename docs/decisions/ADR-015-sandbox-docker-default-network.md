# ADR-015 docker 沙箱默认联网（`bridge`），不是任务书写的 `none`
- 状态：已接受（用户明确决定，2026-11-12 回填文档）
- 包：@hue/sandbox
- 来源标记：无 `DECIDE:`。出处 sandbox DECISIONS 第 2 条

## 问题
Docker 沙箱默认给不给网络？

## 候选
1. `none`（任务书默认）。
2. `bridge`（联网），`network: 'none'` 一行关掉。

## 各家怎么做（附出处）
没有核实过。

## 决定
选 2。这是用户的明确决定：本地测试优先，先放开。`npm install`、拉依赖、请求本地服务都要网络，`none` 会让大多数真实仓库跑不起来。

## 代价
命令能向外发数据。能被发出去的只有挂载目录里的内容：API key 不在容器环境里（模型调用在宿主上），宿主上别的目录看不到（有测试）。但仓库副本里的代码和 `.env` 之类的文件可以被带出去。

## 何时要改
处理不信任的仓库，或仓库里有密钥时，用 `network: 'none'` 并把依赖预装进镜像。

## 相关
- local 沙箱不隔离，环境变量只给 `PATH / HOME / LANG`（sandbox DECISIONS 第 1 条），所以命令读不到宿主的 API key。
- CLI 默认走 docker，local 要显式 `--sandbox local`（cli DECISIONS 第 3 条）。

## 如何验证（eval / 测试）
- `network: 'none'` 时容器里只剩 `lo`（有测试）；宿主别的目录在容器里不可见（有测试）。
- 只在 macOS + OrbStack 上验证过。Docker 关着时 19 个相关用例被跳过。
