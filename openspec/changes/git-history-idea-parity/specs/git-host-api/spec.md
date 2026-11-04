# Spec Delta

## ADDED Requirements

### Requirement: 日志查询支持日期范围

`GET /git/log` SHALL 接受可选的 `since` 与 `until` 参数（ISO 日期或日期时间），MUST 以本地时区解释并映射到 git 的 `--since`/`--until`；非法值 MUST 返回 400 且不执行 git；与 `grep`/`author`/`path`/`limit`/`skip`/`ref` 组合时 MUST 同时生效；无匹配时 MUST 返回空列表且 `hasMore:false`。

#### Scenario: 按日期范围查询
- **WHEN** 客户端请求 `GET /git/log?since=2026-10-01&until=2026-10-31`
- **THEN** 只返回该日期区间内的提交，响应形状与既有分页一致

#### Scenario: 非法日期被拒绝
- **WHEN** 客户端传入 `since=not-a-date`
- **THEN** 返回 400 且没有启动 git 进程

#### Scenario: 与作者过滤组合
- **WHEN** 客户端同时传入 `author` 与 `since`
- **THEN** 只返回作者匹配且日期在范围内的提交
