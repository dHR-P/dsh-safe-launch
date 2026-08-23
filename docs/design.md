# 设计说明 / Design Notes

## 为什么"先隔离测试再安装"

dsh 的插件以 cordis 补丁层方式参与启动组合：任何一个插件的补丁都可能改变整棵
服务树。最便宜的兼容性验证就是"能不能带着它启动"。因此本插件把验证做在
**进程级**：

1. 复制 profile 清单与其 node_modules 到临时目录（真实 profile 只读不动）；
2. 在副本中安装待测插件；
3. 用 last-good.json 记录的 dsh 运行时、以 `$DSH_HOME=临时目录` 启动新进程监听随机端口;
4. 健康判定 = `--dump-config` 可组合 + `/` 返回 200 + 8 秒浸泡存活 +
   netstat 端口归属 pid === 我们启动的 pid + 输出无致命错误模式。

## 为什么正式安装走 `dsh plugin add`

官方命令会执行 bundles reconcile：把声明了 `dsh.bundle` 的依赖登记进
profile package.json 的 `dsh.profile.bundles`。直接 pnpm add 会跳过这一步——
插件装上了却永远不加载（本机 dsh-git-sync 即为此状态的活例）。本插件在
正式安装后还会读回 manifest 校验 bundles 登记结果，异常即整体回滚。

## 重启为什么用分离 helper

webServer 路由跑在被重启的进程里。若在请求处理器内自杀，响应可能发不出、
也没有人负责"再拉起来"。因此 /restart 只做两件事：应答 + spawn 一个
detached 的 restart-helper.js；helper 延迟 1.2 秒后杀旧树、等端口释放、
按 last-good 启动新实例并验活。父进程从不自己重启自己。

## 已知边界

- Windows 优先：junction/robocopy/netstat/taskkill 路径未做 posix 适配；
- 金丝雀验证"能启动、UI 可访问、进程稳定"，不实际调用模型对话接口
  （隔离环境默认不含凭据文件）;
- 隔离兼容性测试的对照面是「新插件 × dsh 核心 bundle 层」：隔离 profile 会剥离
  既有外挂插件依赖（避免把每个旧插件的构建/安装噪音卷进每次检查，也规避 pnpm
  virtual-store 重锚问题）。新插件与"其他外挂插件"之间的冲突暂不在 v1 检测范围；
- 同一时刻只允许一个重任务（内存互斥），多 GUI 并发场景返回 409。
