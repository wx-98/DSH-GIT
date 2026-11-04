# Spec Delta

## Purpose

Host 侧 `/git/*` 契约：为面板与头部芯片提供受信任、可校验、可诊断的本地 git 操作入口，覆盖读取、索引、提交、分支、stash 与日志过滤。

## ADDED Requirements

### Requirement: 所有 /git 路由先过连接信任栅栏

每条 `/git/*` 路由 SHALL 在读取请求体或执行任何 git 命令之前调用宿主的连接信任检查；未通过时 MUST 返回 401/403 且不产生副作用。

#### Scenario: 无认证请求被拒绝
- **WHEN** 未携带宿主认证 cookie 的客户端请求 `/git/health`
- **THEN** 返回 401 或 403，且没有任何 git 进程被启动

### Requirement: 仓库相对路径与参数校验

接受文件路径的接口 SHALL 只接受仓库相对路径：绝对路径、包含 `..` 段、含 NUL 的输入 MUST 被拒绝（400），解析后的目标 MUST 仍在工作树内；破坏性操作 MUST 要求显式 `confirm: true`。

#### Scenario: 拒绝越界路径
- **WHEN** 客户端对 `../outside.txt` 调用放弃变更接口
- **THEN** 返回 400（invalid-path），且工作树外的文件不受影响

#### Scenario: 放弃变更缺少确认
- **WHEN** 客户端调用放弃变更接口但没有 `confirm: true`
- **THEN** 返回 400 且不修改任何文件

### Requirement: 新增索引与提交契约

契约 SHALL 增加：按 hunk 暂存/取消暂存（接收该 hunk 的补丁内容，仅应用到索引）、修补提交（amend）、以及提交信息历史。补丁无法应用时 MUST 返回可诊断错误且索引保持不变；空提交信息 MUST 返回 400。

#### Scenario: 按 hunk 应用补丁
- **WHEN** 客户端提交一个只包含单个 hunk 的补丁给 hunk 暂存接口
- **THEN** 索引中只有该 hunk 的改动，其余改动仍在工作区

#### Scenario: 补丁冲突不破坏索引
- **WHEN** 传入的补丁上下文与当前索引不匹配
- **THEN** 接口返回 409/422 并说明原因，索引与工作区均未被修改

### Requirement: 新增分支与 stash 契约

契约 SHALL 增加分支创建、删除、重命名与 stash 的列表/创建/应用/弹出/删除；删除当前分支 MUST 返回 409；删除未合并分支时 MUST 要求显式强制标志；所有失败 MUST 按既有错误码（400/404/409/422）返回并附带 git 错误摘要。

#### Scenario: 删除当前分支被拒绝
- **WHEN** 客户端请求删除当前所在分支
- **THEN** 返回 409 且分支仍然存在

#### Scenario: stash 往返
- **WHEN** 客户端依次调用创建 stash、列出 stash、应用 stash
- **THEN** 工作区改动被暂存、列表中出现该条目、应用后改动回到工作区

### Requirement: 写操作串行化与错误码映射

所有写操作 SHALL 通过单一串行队列执行，避免并发互相踩踏；错误 MUST 统一映射为契约错误码（bad-request/invalid-path/not-found/not-a-repo/git-failed/conflict/internal）并附带截断后的 git stderr 摘要。

#### Scenario: 并发写操作不交叉
- **WHEN** 两个写请求同一时刻到达
- **THEN** 它们串行执行，索引不会出现半完成状态

#### Scenario: git 失败映射为可读错误
- **WHEN** git 命令以非零状态退出
- **THEN** 响应含 `ok:false`、`code` 与 git stderr 首行摘要，而不是 500 空壳
