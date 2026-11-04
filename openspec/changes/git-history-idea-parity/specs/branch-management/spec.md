# Spec Delta

## ADDED Requirements

### Requirement: 上游状态显示必须准确

当前分支的上游状态 MUST 与实际 git 配置一致：存在上游时 MUST 显示上游分支名；确实没有上游时才 MUST 显示「无上游」；HEAD 游离时 MUST NOT 显示「无上游」，改为显示「游离 HEAD」；状态响应缺少上游字段时 SHALL 回退到分支列表中的上游信息。

#### Scenario: 有上游显示上游名
- **WHEN** 当前分支跟踪 `origin/main`
- **THEN** 面板摘要与芯片弹层显示 `origin/main`，不出现「无上游」

#### Scenario: 确实没有上游
- **WHEN** 当前分支没有配置任何上游
- **THEN** 显示「无上游」

#### Scenario: 游离 HEAD 不显示无上游
- **WHEN** HEAD 处于 detached 状态
- **THEN** 显示「游离 HEAD」，不出现「无上游」

#### Scenario: 状态缺少上游字段时回退
- **WHEN** 状态响应中的 upstream 为空，但分支列表里当前分支带有上游
- **THEN** 使用分支列表中的上游名显示，而不是「无上游」
