# dsh-safe-launch

**DSH 安全启动器插件** —— 把「上次成功启动的配置、更新金丝雀测试、插件兼容性检查安装」装进 DeepSeek Harness 本身。

English: a DSH plugin providing last-good boot config, canary-tested updates, and **compatibility-checked plugin installation** — try any new plugin in an isolated boot on a spare port before it ever touches your live instance.

## 它解决什么问题

| 能力 | 说明 |
|---|---|
| 成功启动配置 | 所有操作基于 `~/.dsh/safe-launch/last-good.json`（与桌面 PowerShell 安全启动器共享），配置变更前自动备份 |
| 核心更新金丝雀 | 新版 dsh 先装入独立 `runtime/<版本>`，用隔离 HOME + 随机端口启动测试，通过才写入新配置；失败自动丢弃候选 |
| **插件兼容性检查安装** | 安装任何新插件前：复制一份 profile 到临时目录 → 在隔离环境装插件 → 用当前成功配置在新端口启动测试 → 通过才经官方 `dsh plugin add` 装入真实 profile；失败只提示，实例零影响 |
| 插件更新回归 | 插件批量更新同样先备份清单 → 更新 → 金丝雀回归 → 通过提交 / 失败回滚 |
| 安全重启 | 分离式 helper 进程接管「停旧-起新-验活」，父进程无需自尽 |

## 安装与首次使用（v0.2.0 起，与普通插件无异）

```sh
dsh plugin --profile web add github:dHR-P/dsh-safe-launch
```

或通过 Web GUI 的插件安装入口选择本仓库。**安装后重启一次 DSH 即完成全部初始化**——
插件会自动从正在运行的实例引导出「成功启动配置」，不需要任何额外步骤。

重启后插件处于 `pending` 引导状态：`/status` 会返回 `onboarding:{needed:true}`，
日志提示一次。此时它是纯增强插件（看门狗/升级提示/兼容性安装全部可用）。

### 授权接管（可选，需用户明确同意）

在任意 AI 会话里让助手询问你，或直接调用：

```sh
# 同意接管：创建桌面「DSH 安全启动」快捷方式 + 写入 AI 助手安装安全约定
curl -s http://127.0.0.1:3080/dsh-safe-launch/setup/desktop-launcher -d '{}'

# 拒绝：保持纯插件模式，不再提示
curl -s http://127.0.0.1:3080/dsh-safe-launch/setup/dismiss-onboarding -d '{}'
```

同意后：桌面快捷方式按「上次成功配置」启动 DSH（90 秒未就绪自动恢复最近清单快照重试一次）；
`~/.dsh/AGENTS.md` 写入接管约定，此后 AI 助手装插件一律走本插件的端点。

## 支持的 DSH 版本与兼容性策略（v0.2.2 起：默认开放）

**任何 dsh 版本都可以直接安装并正常使用本插件。** 用户的 dsh 与其已装插件本就自洽，
本插件的宿主 API 面极小（`webServer.register` + logger），默认假定全版本兼容；
激活代码全程 try/catch 防护——即使出现意外异常也只是插件自身降级，**绝不影响 dsh 启动**。

| 项目 | 值 |
|---|---|
| 实测基线 | **0.1.1-rc.2**（npm latest；仅信息性声明，不作为门槛） |
| 兼容模型 | 默认开放：未知旧版/新版都可用；只有实测确认不良的版本线才通过 `maxExclusive` 排除（休眠） |
| 安装期 | peerDependencies 无上下界要求——任何 dsh 都装得进 |
| 运行环境 | Windows、pnpm 在 PATH、Node ≥ 20 |

### 三层防护（对用户透明）

1. **安装期**：任何 dsh 版本可安装（peer 无上下界）；
2. **激活期**：启动时读取宿主真实版本；激活全程异常防护，最坏情况插件自身降级休眠
   （留说明端点 + NOTICE），dsh 启动永不受影响；
3. **发布期**：每次 dsh 出新旧版本，用 `POST /self-test {"versions":[...]}` 对
   「该版核心 × 当前全部插件」跑金丝雀矩阵——通过才随插件更新确认支持；发现某条
   dsh 版本线真坏了，才在新插件里设置 `maxExclusive` 把那条线排除。

> 声明位于 package.json 的 `dsh.compat`（policy: default-open）。`DSH_SL_ASSUME_DSH_VERSION`
> 环境变量可模拟任意宿主版本做测试。金丝雀的静态预检（--dump-config）在旧版 dsh 上失败时
> 自动跳过、以真实启动测试为准；官方 `dsh plugin add` 在旧版上不可用时自动回退到手动安装路径
> （pnpm add + bundles 登记）。

本包无构建脚本（无 prepare/postinstall），不会被 pnpm allowBuilds 拦截。

## 历史版本兼容性矩阵（v0.3.0 实测）

对 npm 上**全部可安装**的 dsh 历史版本逐一做了「该版核心 × 本插件」激活金丝雀
（隔离环境、随机端口、HTTP 探活、插件路由响应验证）。工具与原始数据见
`tools/matrix-test.mjs` 与 `tools/matrix/`。

| dsh 版本 | 验证通过的启动命令 | 插件激活 | `plugin add` 子命令 | `--dump-config` |
|---|---|---|---|---|
| 0.0.1-rc.5 | `dsh --profile web --port <P>` | ✓ | ✓ | ✓ |
| 0.1.0-rc.2 | `dsh --profile web --host .. --port .. --no-open` | ✓ | ✓ | ✓ |
| 0.1.0-rc.3 | 同上 | ✓ | ✓ | ✓ |
| 0.1.0-rc.6 | `dsh web --host .. --port .. --no-open`（`--profile` 形状同样可用） | ✓ | ✓ | ✓ |
| 0.1.0-rc.7 | 同上 | ✓ | ✓ | ✓ |
| 0.1.0-rc.8 | 同上 | ✓ | ✓ | ✓ |
| 0.1.1-rc.1 | 同上 | ✓ | ✓ | ✓ |
| 0.1.1-rc.2 | 同上（当前 npm latest） | ✓ | ✓ | ✓ |
| 0.0.1-rc.1 / rc.2 | 不适用——上游已撤包（依赖 `dsh-agent-tool-mode` 404），任何人都无法安装 | – | – | – |

### 启动命令自适应

不同版本的 CLI 形状有差异（`web` 位置参数 vs `--profile web`；最老的 rc.5 没有
`--no-open`）。插件的处理方式：

- **零配置捕获**：插件进程自己的 `process.argv` 就是当前 dsh 的真实启动参数，
  引导时把实际主机/端口替换成 `{host}`/`{port}` 占位符存入 `last-good.json` 的
  `bootArgs` 模板——任何版本的正确形状都会被自动记录；
- **全链路使用模板**：重启助手、桌面启动器、核心升级金丝雀、插件安装金丝雀全部
  从同一模板解析启动参数；
- **手动修正入口**：`POST /boot-shape/set {"args":["--profile","web","--host","{host}","--port","{port}"]}`
  会先做隔离金丝雀验证再保存；`GET /boot-shape/current` 查看当前形状。

## 配置页面（控制面板）与接管范围（v0.4）

**控制面板 URL：`http://127.0.0.1:3080/dsh-safe-launch/panel`**（端口按你的实例）。自包含网页，
不依赖 dsh 前端内部机制，任何 dsh 版本可用。页面上可见、可操作：

- **引导卡片**：安装后首次打开时询问「是否在桌面创建安全启动器并接管启动」——同意即一键创建，拒绝则保持纯插件模式；
- **启动器状态**：是否已接管、快捷方式路径、最近一次正常启动记录；
- **更新提示卡**：发现新版 dsh 核心 / 插件有新版本时高亮显示，按钮触发「随机端口隔离环境兼容性测试」，测试通过后再询问是否应用——全程不需要命令行；
- **看门狗卡片**：任何绕过安全启动器发生的 profile 清单变动（包括用其他工具装的插件）都会被拦截提示，一键金丝雀验证：通过自动采纳、失败自动回滚——这就是"装任何新插件都由本插件接管"的落地机制；
- **已装插件清单** 与 **高级操作**（检测更新 / 重启 DSH 应用变更 / 回滚上次配置）。

插件本体出现在 dsh 的插件清单（loader entries 投影）中；本插件的描述、支持版本见上表。
## HTTP API（全部在 `/dsh-safe-launch/` 前缀下）

| 端点 | 入参 | 行为 |
|---|---|---|
| `GET/POST /ping` | - | 存活探针 |
| `POST /status` | `{network?:bool}` | 配置摘要；`network:true` 时附带最新版本与可更新插件 |
| `POST /check` | `{}` | 检测核心/插件更新，只提示不改动 |
| `POST /test-candidate` | `{version?}` | 安装指定版本(默认 npm 最新)→金丝雀→晋升配置 |
| `POST /install-plugin` | `{source}` | **兼容性检查安装**：`npm 包名` 或 `github:owner/repo` |
| `POST /update-plugins` | `{}` | 备份→更新→回归测试→提交或回滚 |
| `POST /restart` | `{}` | 分离式安全重启（按 last-good 配置） |
| `POST /rollback-config` | `{}` | 回滚到上一份不同备份，并连带恢复 profile 清单快照 |
| `POST /manifest/status` | `{}` | 清单基线 vs 当前：漂移报告 |
| `POST /manifest/verify` | `{}` | 对**当前**清单组合做金丝雀验证，通过则纳入成功快照 |
| `POST /manifest/ack` | `{}` | 不测试、手动确认接受当前清单（写入审计） |
| `POST /setup/desktop-launcher` | `{}` | **同意接管**：生成桌面安全启动快捷方式 + 写入 AI 安装约定 |
| `POST /setup/dismiss-onboarding` | `{}` | 拒绝接管：纯插件模式，不再提示 |
| `POST /job` | `{id}` | 轮询长任务状态与日志 |

长任务（test-candidate / install-plugin / update-plugins / manifest/verify）立即返回 `{ok, jobId}`，用 `/job` 轮询；同一时刻仅允许一个重任务。

## 核心版本升级流程（v0.1.2，严格同意制）

1. **启动**：永远按 `last-good.json` 里已验证的版本启动，完全不碰 npm 最新版；
2. **提示**：启动约 30 秒后后台查一次 npm（环境变量 `DSH_SL_NO_AUTO_CHECK=1` 可关闭），
   发现有新版本只写 NOTICE + 日志，并把 `coreUpdatePending` 暴露在 `/status`——不做任何下载；
3. **同意后测试**：调用 `POST /test-candidate {}` 才开始后台下载到独立 `runtime/<版本>`，
   并用 junction 隔离启动做金丝雀验证——**新版核心 × 当前全部插件的真实组合**
   （静态预检 + HTTP 就绪 + 浸泡 + 进程身份 + 致命错误扫描），当前实例全程无感；
4. **采用**：通过才写入新配置；失败自动丢弃候选并保持旧配置。是否立即重启始终由用户决定。

PS 桌面启动器同规则：检测到新版本先弹确认框征得同意，同意后才下载测试。

## 清单看门狗（v0.1.1）

**问题**：插件端点只是"正确的路"，拦不住有人（或 AI）直接对 profile 跑 `pnpm add` / `dsh plugin add` 绕过兼容性测试。

**机制**：每个验证通过的状态都会把 profile 清单（package.json / pnpm-lock.yaml / cordis.patch.yml）快照到 `~/.dsh/safe-launch/profile-snapshots/`，并在 last-good.json 记录指纹（deps + bundles + 锁文件哈希）。插件运行期间每 5 秒对比指纹：

- **自己的变更**（install-plugin / update-plugins / 晋升 / 回滚）：静默吸收；
- **绕过的变更**：写入 `~/.dsh/safe-launch/audit.jsonl` 审计 + NOTICE 通知，并**自动**用 junction 隔离启动做兼容性验证——通过则把变更纳入新的成功快照（`watchdog-adopted`）；失败则大声告警并给出回滚指引（当前实例不受影响，但已明确告知下次启动有风险）。

桌面 PowerShell 启动器同版升级：启动时提示清单漂移；启动失败时自动恢复最近成功清单快照并重试一次；`rollback-config` 连带恢复清单。

### 兼容性安装示例

```sh
# 1. 发起
curl -s http://127.0.0.1:3080/dsh-safe-launch/install-plugin \
     -d '{"source":"github:someone/some-dsh-plugin"}'
# => {"ok":true,"value":{"jobId":"ab12cd34"}}

# 2. 轮询
curl -s http://127.0.0.1:3080/dsh-safe-launch/job -d '{"id":"ab12cd34"}'
```

流程：复制 profile 到临时目录 → 隔离安装插件 → 以当前成功配置在随机端口启动
（静态预检 + HTTP 就绪 + 8 秒浸泡 + 进程身份校验 + 致命错误扫描）→
通过则官方命令装入真实 profile 并确认 bundles 登记 → 提示「重启后生效」；
任一步失败则清理现场、给出原因与日志路径，当前实例全程无感。

## 自动清理说明（依项目规则中文注明）

- `%TEMP%\dsh-canary-*` 隔离测试目录：测试专用副本，每次运行结束自动删除；
- 测试失败的候选运行时 `runtime/<版本>`：自动删除（与在用版本相同的自测失败除外），日志保留；
- 插件更新前的清单备份 `plugin-backup-*` 与配置历史 `backups\` 保留供回滚。

## 状态文件

```
~/.dsh/safe-launch/
├─ last-good.json      上次成功的启动配置
├─ runtime/<版本>/     自有安装的各版本 dsh
├─ backups\            配置历史（回滚用）
├─ plugin-backup-*\    插件操作前的 profile 清单快照
├─ NOTICE.txt          操作通知历史
└─ logs\               任务与金丝雀日志
```

## 版本命名规则

本插件版本号 = `<适配的dsh版本>-v<插件自身版本>`，例如：

    0.1.1-rc.2-v0.5.0
    └──┬──┘ └─┬─┘
    适配的dsh版本  插件自身版本

一眼即可看出当前插件最新适配的 dsh 版本。规则要点：

- 前缀与所适配 dsh 版本的名称**完全一致**（含 prerelease 写法，如 `rc.2`）；
- `-v` 后是插件自身语义版本，随插件功能迭代递增，与 dsh 版本无关；
- 同一 dsh 版本下发布多次时，只递增自身版本（`...-v0.5.1` > `...-v0.5.0`）。

改版本用助手脚本（同步改写 package.json 与 lib/index.js 两处）：

    node tools/set-version.mjs <dshVersion> [pluginOwnVersion]
    node tools/set-version.mjs 0.1.1-rc.3          # 自身版本沿用当前值
    node tools/set-version.mjs 0.1.1-rc.3 0.6.0    # 同时提升自身版本
## 发布合规说明（dsh 插件要求对照）

- `package.json` 声明 `dsh.bundle.patch` 指向随包 `cordis.patch.yml`（层叠补丁插入服务行）；
- 经 `dsh plugin --profile web add <spec>` 安装时由官方 reconcile 写入 `dsh.profile.bundles` 激活；
- 导出 cordis 标准 `apply(ctx)` + `inject`（仅依赖宿主 `webServer` 服务）；
- 纯 ESM、`exports` 映射完整、`files` 白名单发布、无构建脚本、MIT 协议、keywords 含 `dsh-plugin`。

## License

MIT © 2025 dHR-P
