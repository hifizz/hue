# sources/ 十个项目的沙箱与安全模型调研

> 状态：证据记录，不是决定。接续 [sandbox-evidence.md](sandbox-evidence.md) §4（那批"未读源码"的外部说法，本文已逐条核实或修正）与 §5 的 ADR 候选。
> 日期：2026-11-15。方法：8 个并行子任务分头读 `sources/` 源码，我抽查了 8 条最承重的结论（§9）；行号凡未亲验的按惯例标「报告称」。

## 0. 一张总表

| 项目 | 安全模型 | 底层技术（按平台） | 沙箱默认 | 网络默认 |
|---|---|---|---|---|
| codex | **按命令 OS 沙箱** + 审批正交 | macOS Seatbelt；Linux bwrap+seccomp（Landlock 仅 legacy）；Windows restricted token / elevated / MXC 三后端 | read-only / workspace-write **自动开**；full-access 不开 | 默认断；MITM 代理按域名放行 |
| grok-build | **进程级 OS 沙箱**（agent 全程）+ 每命令沙箱（v1 仅 macOS） | 进程级：`nono` crate（Landlock/Seatbelt）+ bwrap re-exec 做 read-deny + 手写 seccomp BPF；每命令：sandbox-exec（SBPL 逐字抄 codex） | CLI 进程级默认 **off**；workspace server 默认 workspace；每命令默认 off | 进程级保持开放（要调 LLM）；子进程 seccomp 全断 + loopback egress proxy 归因 |
| dim | **按命令 OS 沙箱**，两个布尔开关 | macOS Seatbelt；Linux bwrap；Windows 无后端（开了就拒绝执行） | **opt-in，默认关**（ADR-010 明确从默认开改成默认关） | 关=unshare-net/全拒；开=**直连，无代理** |
| minimax-code | **按命令 OS 沙箱**，vendor Anthropic sandbox-runtime | 仅接线 macOS（srt-macos）；Linux bwrap + Windows srt-win（WFP/job object）在 vendor 里**完整保留但未接线** | **默认关**（`enabled:false, full_access`） | 产品策略**永不限制网络**（deny-first 代理能力是储备） |
| OpenHands | **容器即边界**（无工具级权限系统） | 部署梯度：裸跑（警告）/ 单容器 / **每会话一容器** / 云沙箱；docker run 在上游 agent-server，本仓库只传参 | 自托管默认依赖单一 session API key | 容器默认 bridge 可出网（文档明说接受） |
| ai（Vercel AI SDK） | **云沙箱 + 凭据不进沙箱** | `@vercel/sandbox`（托管）；just-bash（进程内 JS 解释器+虚拟 FS，非 OS 隔离）；接口在 SDK 本体（experimental） | 不适用（由调用方创建传入） | 云端网络策略（allowlist/denylist CIDR，可挡元数据 IP）+ 请求变换在边界外注入真实凭据 |
| mastra | **沙箱是能力接口，不是运行时** | LocalSandbox（默认零隔离，可选 Seatbelt/bwrap 原生隔离）+ Docker + 云（Daytona/E2B/Blaxel/Railway/…） | LocalSandbox 默认 `isolation:'none'` | 无统一网络策略（文档明说责任下放给 provider） |
| goose | **无沙箱，纯审批** | 本机直接 `bash -c`；Flatpak 下反而 `flatpak-spawn --host` 逃逸到宿主 | GooseMode 默认 **Auto（自动批准一切）** | 不限 |
| kimi-code | **无沙箱，审批 + 命令 AST 分析** | 本机直接 spawn；可选 `[environments.*]` 把整个 agent 挪进 ssh/docker/k8s | 默认 manual（逐条审批） | 不限 |
| ZCode | **无沙箱，审批 + 命令 AST 只读分析** | 本机直接 spawn（登录 shell）；可选远程后端 ssh/wsl/docker | 默认 build（高风险逐条审批，AST 判只读自动放行） | 不限 |

## 1. 先看分类学：五种安全模型

十个项目落到五种模型上，光谱从"内核强制"到"问人"：

1. **按命令 OS 沙箱**（codex、dim、minimax-code、grok 的每命令层）：每条 shell 命令套一层内核强制的文件/网络门禁，工作区还在原地。代价：每平台一套实现 + 一堆边角坑（符号链接、PTY、挂载语义）。
2. **进程级 OS 沙箱**（grok 的 CLI 线）：agent 进程启动时一次性套上、不可逆，覆盖进程内所有 fs 调用和子进程。代价：LLM API 流量必须放行，所以网络这层失效，另用 seccomp 补子进程。
3. **容器即边界**（OpenHands、ZCode/kimi 的远程选项、mastra 的 DockerSandbox）：把"能执行任意代码"接受为前提，用容器/远程机器圈住爆炸半径。代价：环境是副本而非真实目录（我们的 docker 模式踩过的 85% 时间在装依赖就是这类代价），且默认 bridge 网络可出网。
4. **云沙箱 + 凭据外置**（ai/vercel，mastra 的云 provider）：harness 在宿主，代码执行进托管沙箱，网络策略和凭据注入都发生在边界外。代价：experimental、延迟、厂商绑定；本地 OS 隔离不提供。
5. **纯审批**（goose、kimi-code、ZCode）：命令以用户全权限在本机跑，唯一防线是执行前的决策（模式 + 规则 + AST 分析）。三者差异只在默认档位和分析精度（goose 默认放行最多，ZCode 审批粒度最细）。

## 2. codex：自研全家桶，语义对齐优先

**模型**：默认把每条命令包进 OS 沙箱（文件系统只读 + 可写根 + 网络默认断/只走代理），审批只决定"要不要放宽/逃出沙箱"，两者正交组合。

- 分层：`PermissionProfile`（协议层）→ `SandboxManager.transform()` 编译成平台命令行包装（`sandboxing/src/manager.rs:319`【报告称】）→ macOS `sandbox-exec -p` / Linux 帮手二进制 / Windows 三后端。
- **Linux 双轨**：bwrap 是默认管线，Landlock 降级为 `--use-legacy-landlock` 隐藏旗标（`linux-sandbox/src/linux_run_main.rs:85`，已亲验），且 legacy 模式**直接拒绝受限读**（"Restricted read-only access is not supported by the legacy Linux Landlock filesystem backend"）。bwrap 模块头注释明说要 mirror macOS Seatbelt 语义（`bwrap.rs:1-17`【报告称】）。
- **macOS Seatbelt**：base 模板抄 Chrome renderer 策略并附源码链接；写根加 `(deny file-write-unlink ... (vnode-type DIRECTORY))` 防"删掉重建"绕过；堵 `F_MAKECOMPRESSED/F_TRANSFEREXTENTS` 两个能用只读 fd 改文件的 fcntl（`seatbelt.rs:1070-1076`【报告称】）。
- **符号链接（对照我们 §3.1 的坑）**：`nested_symlink_component()` 只归一化**顶层**系统别名（`/tmp → /private/tmp`），深层符号链接组件直接拒绝（`seatbelt.rs:400-409`【报告称】）；scratch 目录直接写物理路径 `/private/tmp`；可写根含符号链接时报错不执行，唯一出口是显式 `allow_symlinked_codex_home = true`。
- **网络**：默认断 = macOS 不加 allow 段 / Linux `--unshare-net` + seccomp deny socket 系调用。按域名放行不靠 OS 过滤，靠**本地 MITM 代理**：进程内生成 CA、按 host 签叶证书终止 TLS（`mitm.rs:158-164`【报告称】）；帮手在 netns 里起 loopback listener、把 fd 传回宿主、**改写 env 里的代理 URL 指向 netns 内端口**（`proxy_routing.rs:131-208`【报告称】），并强制重写全套 `HTTP_PROXY/.../NPM_CONFIG_PROXY/DOCKER_...` 变量。有代理配置却解析不出 loopback 端点则 fail closed。
- **seccomp 细节**：断网时刻意放行 `recvfrom`（cargo clippy 需要 socketpair）；额外 deny `io_uring_*`（"io_uring can create AF_VSOCK sockets without a socket() syscall"）和 `ptrace/process_vm_*`；`PR_SET_NO_NEW_PRIVS` 只在需要时开（很多 bwrap 部署靠 setuid）。
- **escalation**：模型可声明 `RequireEscalated`（出沙箱重试）或 `WithAdditionalPermissions`（沙箱内临时放宽）；沙箱内失败后以 "command failed; retry without sandbox?" 问人，批准后第二次不套沙箱——**审批即失败后的重试，而非静态预检**。
- Windows：restricted token 读限制做不到（"WRITE_RESTRICTED token does not make capability SID deny-read ACEs participate in read access checks"，要 elevated 服务）；网络走 WFP 按用户 SID 断网。
- **动机原话**：Landlock 留不住的原因是 "Proxy-only networking requires bubblewrap's isolated network namespace"（`sandboxing/src/landlock.rs:53-54`【报告称】）。

## 3. dim：最小模型的教科书（ADR 写得最清楚）

**模型**：沙箱是用户侧两个布尔（`sandbox` / `network`，默认全关），审批/预设/模型都**不能**改变沙箱边界，也没有 escalation。ADR-010 开头就交代了为什么从"默认开"改过来：

> "The current defaults — sandbox on, network off, … — gets those restrictive defaults and the agent cannot do ordinary work."（`docs/adr/010-sandbox-opt-in.md`，已亲验）

- 实现 = **argv 改写**：`prepare_isolated_process` 把 `spec.executable` 换成 `/usr/bin/sandbox-exec`（macOS）或 `bwrap --unshare-user --unshare-pid …`（Linux），复用既有 spawn/PTY/进程树/取消路径，"没有新 capability、registry 或 supervisor"（设计文档 §Ablation）。
- macOS profile 是 deny-by-default 手写 SBPL；授权根经 `-D` 参数注入（路径不进 policy 源码）；`~/.gitconfig` **逐文件**授予而 XDG 目录不整树授予（credential store 也在那）；`~/.ssh` 不授予。网络开 = 允许 IP + 系统 DNS，**没有代理层**；关 = 全拒。
- Linux 不挂 home、无 `/tmp`；env 白名单两平台共 10 个变量，其余全丢。
- Windows 开沙箱 = `isolation_unavailable` 拒绝执行，绝不静默降级（"Nothing starts a payload at a weaker boundary"）。
- **方法值得抄**：产品化前先做三个 spike（landlock 裸 syscall、bwrap、Seatbelt 各一）量开销和边界流。spike 得出的三个顾虑直接决定选型：① Landlock ABI4 "covers neither UDP/UNIX sockets nor all read-only metadata operations" → 弃 Landlock 用 bwrap；② bwrap `--new-session` 丢控制终端（job control 假死）→ 不加；③ `--die-with-parent` 和后台任务语义冲突 → 用户手敲命令不进沙箱。
- 沙箱内失败不提权重试，只做**启发式文本匹配**（输出含 `operation not permitted` / `bwrap:` 等 10 条）就给模型附一句"沙箱可能导致失败，请用户改 /settings"。
- 已知限制：Seatbelt 被苹果标 deprecated，"support is limited to OS versions that pass the isolation acceptance flows"；Linux 依赖宿主 PATH 上的 bwrap，无来源校验。

## 4. grok-build：进程级 + 每命令双层，抄作业链的一环

**模型**：双层。(A) 进程级：agent 启动一次性套 Landlock/Seatbelt（经 `nono` v0.53.0，**精确 pin**），不可逆；网络保持开放（"agent needs LLM API"），子进程网络用手写 seccomp BPF 单独封。(B) 每命令：daemon 对每条命令按 `off/observe/enforce` 包 sandbox-exec 并解码违规、发审批卡（v1 仅 macOS）。

- **Linux read-deny 的实现**：Landlock 没有 deny 语义（"Landlock cannot deny a subpath of an allowed tree"），所以 deny 路径用 **bwrap re-exec + 000 权限占位文件 bind-over**（`src/deny/mod.rs:1-4`【报告称】）。缺 bwrap 时**拒绝启动**而非裸跑。
- seccomp 过滤器手写经典 BPF 不引 libseccomp：网络 11 个 syscall 全 EPERM（含 io_uring 三件套）；mount/unshare/setns 命名空间锁死（防 bwrap 内再开 user namespace）；过滤器在父进程预构建、`pre_exec` 里零分配零锁（防 fork 死锁）。
- **SBPL base 逐字抄 codex**（`base.sbpl:15-16`，已亲验："Copied verbatim from the OpenAI Codex CLI … at commit 93b44c3a"）；路径一律走 `(param)` 防 SBPL 元字符注入。
- `nono` 为什么精确 pin：**"the macOS Seatbelt deny precedence depends on nono's observed rule-emission order. A bump can silently change it and re-open the `mv x y && cat y` bypass"**（`Cargo.toml:44-50`【报告称】）——Seatbelt last-match-wins 语义连上游库升级都可能是安全回归。
- 进程级沙箱激活时可配 `auto_allow_bash` 跳过 bash 审批——**沙箱换自动放行**，和 dim 的取向一致。
- 防自我篡改：`workspace`/`strict` profile 下内核写拒 `~/.grok/hooks/`、`sandbox.toml`、`trusted_folders.toml`；项目级 sandbox.toml **只能新增** profile 不能重定义全局同名（"Last-write-wins would let a malicious workspace hollow out a user/enterprise custom profile"）。
- 已知限制：macOS 子进程网络封禁是 no-op（seccomp 仅 Linux）；Linux deny glob 只保启动时存在的文件；bwrap 占位文件并发竞争注释自认"could yield None, silently dropping the bind and failing open"。

## 5. minimax-code：vendor sandbox-runtime 的完整案例

**模型**：把 Anthropic sandbox-runtime **fork 进仓库**（`@minimax/mcode-sandbox-runtime`，pin `0.0.74-mcode.2`，上游锚点记在 `upstream.json`），外面套自有的 backend/service/policy 编译器；产品只在 macOS 接线（唯一后端描述符 `SRT_MACOS, platform:'darwin'`），默认关，**网络在产品策略里永不限制**（"sandbox never restricts network access"，`effective-policy.ts:29-38`【报告称】）。

- 调用链：Bash 工具 → `beginInvocation` 拿 lease → `lease.backend.wrap` → `SandboxManager.wrapWithSandbox`。没有六端口式抽象，对应物是 `SandboxPlatformBackend` 接口 + 按 platform/priority 的选择器，无匹配抛 `SANDBOX_UNSUPPORTED_PLATFORM`。
- **他们对上游的修改清单**（每条都在 vendor 源码里印证过）本身就是"生产化 sandbox-runtime 要补什么"的清单：
  1. `allowSecurityServer` 开关（控制 seatbelt mach-lookup）；
  2. 独立 `unlinkAllowOnly` scope（全局 deny `file-write-unlink` 再对允许根逐个 allow，防 Finder/gio 在 cage 外 unlink）；
  3. deny-first 网络过滤顺序（allow-all 模式仍走代理以便 deny 规则保持权威）；
  4. 每次调用传入清洗过的 baseEnv（而非继承 `process.env`）；
  5. caller 提供临时目录（`sandboxTempDir` 必填，"Never fall back to an ambient or shared product directory"）；
  6. 代理关闭时文件/凭证限制照常生效（MCODE-008）；
  7. 自写 `whichSync`（Node statSync 遍历 PATH，不依赖外部 `which` 进程及其启动超时）；
  8. 删 Bun 分支、CONNECT peek buffer 显式拷进 Node Buffer。
- **上游 Linux"字面 deny 路径静默跳过"的坑**（sandbox-evidence.md §4 提过）：vendored 版已系统性处理——不存在的 deny 路径用 `/dev/null`/空目录 ro-bind 封死，含 git worktree（.git 是文件）边角（`linux-sandbox-utils.ts:1346-1440`【报告称】，含 "Fix 1/Fix 2" 注释）。
- Windows 部分（vendor `srt-win-src`）值得记录：专用低权用户 + 受限 token + ACL；WFP CONNECT 层 4 条过滤器——loopback 端口**区间** PERMIT + 按沙箱用户 SID BLOCK 全部外连。源码自述根源："Linux/macOS 把真实端口烤进 profile，Windows 没有免 admin 的等价物"。
- 为什么 vendor 而非 npm 依赖：README 明说 "Runtime code is not downloaded from a private registry"；9 个原生产物 sha256 校验门（`native-integrity.json`）。

## 6. OpenHands / ai / mastra：三种"非本地 OS"路线

**OpenHands（这个 checkout 是前端 Agent Canvas）**：安全模型一句话在自托管文档里："Agent Canvas drives an agent that can read and write the filesystem … Anyone who can talk to the agent server can do the same"（`docs/SELF_HOSTING.md:7-11`【报告称】）。边界 = agent-server 所在机器/容器 + 单一 session API key；四档部署梯度（裸跑/单容器/每会话一容器/云）；真正 `docker run` 的参数在上游 `software-agent-sdk`，本仓库只传 `OH_CONVERSATION_IMAGE/MEMORY/CPUS/PIDS_LIMIT` 环境变量。容器默认 bridge 可出网、无 cap-drop/read-only rootfs。有前端确认协议（`SecurityRisk` 枚举 + 确认按钮）但规则实现不在本仓库。

**ai（Vercel AI SDK）**：最有意思的是**凭据模型**——"Model and provider credentials must not enter the sandbox"：真实密钥留宿主，沙箱内只见 `aisdkhc_…` 占位符，出站 HTTPS **离开边界后**由"请求变换"覆写真实凭据（`architecture/harness-abstraction.md:201-215`【报告称】；占位符方案在 `credential-forwarding.ts`）。沙箱是 SDK 本体的 experimental 三层：核心接口 `SandboxSession`（`packages/provider-utils/src/types/sandbox.ts:163`，已亲验，注意类型名**不带** Experimental 前缀）→ `experimental_sandbox` 注入通道贯穿 generateText/streamText → 官方适配器 `@ai-sdk/sandbox-vercel`（云）与 just-bash（进程内 JS bash + 虚拟 FS，明说不是 OS 隔离、做不了网络策略）。harness 首选宿主驱动（"keeps the sandbox smaller … makes credentials easier to keep on the host"）；Claude Code/Codex 这类必须碰本地文件的 CLI 走 bridge 进沙箱 + WebSocket。文档诚实提示："Passing an experimental sandbox does not sandbox the tool itself."

**mastra**：沙箱是**能力接口而非运行时**——`WorkspaceSandbox` 接口（必选仅 id/name/provider，其余 executeCommand/processes/networking/computer/… 全可选），各 provider 实现，agent 按后端实际能力自动生成工具。本地有 `LocalSandbox`（默认 `isolation:'none'`，零隔离直跑宿主）+ **可选原生隔离**：macOS Seatbelt（文件头注释 "Based on the approach used by Claude Code's sandbox-runtime"，已亲验；读全放行、`allowSystemBinaries:false` 直接抛错 fail-closed）/ Linux bwrap。云端 provider 十来个（Daytona 能力最全：公网端口 URL、FUSE 挂 S3、桌面；docker 版无 networking/computer/snapshot）。文档明说两个缺口："Mastra doesn't define one network policy that applies to every sandbox backend"、"doesn't provide a backend-neutral credential broker"。另有独立的进程内 Code Mode transport（V8 isolate / WASM QuickJS，"no direct filesystem, network, or process access"）。

## 7. goose / kimi-code / ZCode：无沙箱三兄弟

三者 `rg -i "seatbelt|landlock|bubblewrap|seccomp"` 全部零命中；模型输出的 shell 都以用户全权限在本机 `bash -c` 执行，唯一的墙是执行前的决策。差异在默认档位和分析精度：

| | 默认 | 命令分析 | 可选隔离 |
|---|---|---|---|
| goose | **Auto：自动批准一切**（`#[default] Auto`，已亲验）；permission.yaml 三档按工具名配置；SmartApprove 用 **LLM 判定**工具是否只读 + 出站正则抓 curl/push 目标 | LLM + 正则 | codex provider 的 `--sandbox read-only` 旗标（沙箱属于 codex 进程）；`--docker-ext` 只圈 MCP 扩展；文档自认 "Permission callbacks are not a sandbox" |
| kimi-code | manual 逐条审批 | **自研 tree-sitter-bash**（纯 TS，README 首句 "built for agent-side command permission analysis"）解析 AST：危险命令/提权/嵌套 shell/`$()` 注入向量，守卫默认开（`?? true`，已亲验）；敏感文件模式触发询问 | `[environments.*]` 把整个 agent 挪进 ssh/docker exec/k8s/Apple Container |
| ZCode | build：高风险逐条审批 | 约 25 个文件的 `bash-readonly-policy-*` + 生成式命令注册表，静态判只读自动放行；guarded 模式对危险命令注册表仍强制单次确认；审批支持**用户改输入再批准** | 远程后端 ssh/wsl/docker（agent 部署进容器） |

值得注意的两个取向：
- **开沙箱的敢自动放行，不开沙箱的靠问人**——grok 的 `auto_allow_bash`、dim 的 full-access（"只意味着不弹工具提示，不关沙箱"）与这三家的"严审批"互为镜像。
- ZCode 明确**不硬限制工作区路径**："Current release intentionally does not hard-block paths outside workspaceRoot"（因子 agent 要访问相邻仓库）——和我们 tools 层做路径检查的取舍相反。

## 8. 跨项目共识与分歧（对 Hue ADR 的输入）

1. **本地 OS 沙箱这条路已经收敛到 Seatbelt + bwrap**，且抄作业链清晰：codex 自研 → grok 逐字抄 codex 的 SBPL base；Anthropic sandbox-runtime → minimax 整个 vendor、mastra 照它的做法写。**没有任何一家从零写第三种机制**（Landlock 做主力的没有：codex 降级 legacy、dim 弃用、grok 只用来 allow-tree + bwrap 补 deny）。
2. **Landlock 表达力不足是三家共同的弃用理由**：不能表达受限读（codex）、ABI4 不覆盖 UDP/UNIX socket（dim spike）、无 deny_path（grok）。结论一致：**Linux 上要 workspace-write 语义就要 mount namespace，即 bwrap**。
3. **网络是最难的层，做法分化最大**：codex 自写 MITM 代理（按域名 + env 全套重写 + netns 内 loopback）；grok 写 loopback egress proxy（"credential is attribution, not isolation"）；minimax vendor 了整套 mux proxy 但产品里关掉；dim 干脆不做代理（开=直连）；mastra/文档承认无统一方案；ai 用云边界的网络策略 + 凭据外置。**没有一家在 macOS 上做内核级按域名过滤**（grok 的 seccomp 断网仅 Linux）。
4. **符号链接坑人人处理，方案可借鉴**：codex"顶层别名归一化 + 深层拒绝 + 报错不执行"；grok `/private` firmlink 双覆盖；minimax vendored 版封死不存在的 deny 路径。我们 §3.1 的坑有现成答案。
5. **默认值光谱反映定位**：codex（产品要安全默认）read-only 自动开；dim（个人本地工具）opt-in 两布尔；minimax 桌面端默认关；goose/kimi/ZCode 干脆不做。**"默认开"的前提是沙箱内还能干活**（codex 的 workspace-write + 代理；dim 反例：默认开导致"agent cannot do ordinary work"才改成 opt-in）。
6. **对 §5 ADR 候选的直接含义**：
   - **候选 A（依赖 sandbox-runtime）**：minimax 的 8 条修改清单就是"接它要补什么"的实底（env 清洗、临时目录、unlink scope、Windows 端口区间…）；他们 vendor + sha256 门的做法解决了"预览版 API 会变"的一半风险。
   - **候选 B（自己写）**：可参照的最小实现现在有三份（dim isolation.rs + spike 方法论、mastra seatbelt.ts——TS 写的、和我们要适配 SandboxPort 的语言一致、且就是按 sandbox-runtime 的做法写的）。Seatbelt last-match-wins 的规则顺序脆弱性（grok 对 nono 的 pin 理由）是自写路线最尖的风险。
   - **候选 C（docker 挂缓存）**：与本文正交，但 OpenHands/mastra 的"容器即边界 + 网络不管"路线提醒：容器模式里**密钥怎么不进容器**值得顺手做（ai 的占位符 + 边界外注入是现成设计）。
   - 新增观察：**审批与沙箱正交**（codex、dim 都明说）+ **沙箱内失败→问人→无沙箱重试**（codex 独有）是两条可以进 Hue policy/sandbox 接口语义的机制。

## 9. 方法与可信度

- 8 个并行子任务读源码（codex、dim、grok、minimax 各一；OpenHands、ai、mastra 各一；goose+kimi+ZCode 合一），每份要求 file:line 引用并区分"读到/推断"。
- 我抽查了 8 条最承重结论，7 条证实：codex `--use-legacy-landlock`（`linux_run_main.rs:85`）；dim ADR-010 标题即 "The sandbox is opt-in"；grok SBPL 头注 "Copied verbatim from the OpenAI Codex CLI"；minimax 默认 `{enabled:false, full_access}`；mastra seatbelt.ts "Based on the approach used by Claude Code's sandbox-runtime"；kimi `dangerousCommandGuard ?? true`；goose `#[default] Auto`。1 条修正：AI SDK 接口名为 `SandboxSession`（`provider-utils/src/types/sandbox.ts:163`），注入选项叫 `experimental_sandbox`，子报告把两者混成了一个名字。
- 其余几十个行号未逐条亲验，按惯例标「报告称」；引用路径相对 `sources/<repo>/`。
- 源码快照提交号见 [harness-comparison.md](harness-comparison.md) §0.1。
- OpenHands 结论只覆盖本 checkout（前端 Agent Canvas）；每会话容器的真实 docker 参数、浏览器工具实现、确认策略规则都在上游 `OpenHands/software-agent-sdk`，未克隆。
- 本文对 sandbox-evidence.md §4 的修正：Codex 行"Linux Landlock 加 seccomp"→ **bwrap 为默认、Landlock 仅 legacy 回退**；Grok Build 行"机制未确认"→ **已确认**（进程级 nono/Landlock/Seatbelt + bwrap bind-over + seccomp，每命令层 v1 仅 macOS）；"sandbox-runtime 未安装未运行"仍然成立，但其 v0.0.74 源码已通过 minimax vendor 读到。
