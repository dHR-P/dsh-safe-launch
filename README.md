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

## 安装（符合 dsh 插件发布要求）

```sh
dsh plugin --profile web add github:dHR-P/dsh-safe-launch
```

或在 Web GUI 中通过 dsh-git-sync 的插件安装入口选择本仓库。

要求：Windows（robocopy/junction/netstat 路径）、pnpm 在 PATH、Node ≥ 20。
本包无构建脚本（无 prepare/postinstall），不会被 pnpm allowBuilds 拦截。

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
| `POST /job` | `{id}` | 轮询长任务状态与日志 |

长任务（test-candidate / install-plugin / update-plugins / manifest/verify）立即返回 `{ok, jobId}`，用 `/job` 轮询；同一时刻仅允许一个重任务。

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

## 发布合规说明（dsh 插件要求对照）

- `package.json` 声明 `dsh.bundle.patch` 指向随包 `cordis.patch.yml`（层叠补丁插入服务行）；
- 经 `dsh plugin --profile web add <spec>` 安装时由官方 reconcile 写入 `dsh.profile.bundles` 激活；
- 导出 cordis 标准 `apply(ctx)` + `inject`（仅依赖宿主 `webServer` 服务）；
- 纯 ESM、`exports` 映射完整、`files` 白名单发布、无构建脚本、MIT 协议、keywords 含 `dsh-plugin`。

## License

MIT © 2025 dHR-P
