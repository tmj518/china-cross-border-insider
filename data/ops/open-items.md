# 挂着的事（需要老板或总监点头的）

> 登记时间 2026-10-28。这里只记"不能自己决定"的事；能自己决定的已经做了，不写在里。

## 1. stash@{1}（"opt"）

```
内容   3 个文件：data/runs/agent-2026-10-19T01-14-57.json、data/runs/latest.json、src/data/instruments.json
规模   含 instruments.json 226 行改动
状态   未动、未 drop、未应用。文件是真实的，只是一直没人说要不要
决定   等老板：还需要 / 可以丢 / 要应用到当前分支
```

## 2. 飞书旧 app 凭据（docs/进度日志.md 曾写下）

```
已做   APP_ID / APP_SECRET / wiki token / app_token 四个值已从文档删除，git 历史未改写
未做   无法验证该 app 是否仍有效 —— 文档里的 secret 当时就是截断的，换不出 token
差异   该 app（cli_aa4ad6…）与当前在用的（cli_aa53dd…）不是同一个
决定   等老板：弃用并轮换 / 确认已失效后保留记录
```

## 3. 其他重复页

```
今天清掉的是 eu-goes-provisional-safeguard-trq-price-threshold-2026-2026-10-28.md
★ 没有顺手清理别的。若还有，按总监要求先报告、再决定
```

## 4. B 线不能写作

```
现象   本地与 CI 各跑一次，选中格后 10 轮零工具调用，判决 DUPLICATE-SUBJECT
根因   不是缺代码，是"模型不调工具"：换过 volces、换过 lite 端点，两次都不调
影响   B 线的探索产出仍然进不了内容
修法   换模型 或 改工具协议（都不在封箱范围）
```

## 5. 格子供给只有 2 格

```
现象   三条筛选叠加（方向单值 + 可算≥1 + 意图≥10）后，25 格里只有 2 格可入队
原因   23 格的 directionMix 有多个方向
放宽   把混合方向拆成 into / out 两问，一格变两格
★ B 线现在不写，所以供给不是当前瓶颈；B 线能写时才会咬人
```

## 6. 每周盲评 2 篇

```
机制   已写进裁决标准（每周人工抽 2 篇，30 分钟）
状态   尚未执行第一次
原因   这是唯一真正的"第二意见"，但它需要人，不是代码
```

## 7. GitHub Actions 停止启动 job（2026-10-28 16:32 起）

```
现象   任何 workflow 触发后 3 秒失败，steps = 0，无日志可读
证据   我的 seo-audit 三次失败 → 回滚到 10-27 版本仍失败 → 触发未改动的 ci.yml 同样 0 步骤
判定   与本次改动无关，是平台/额度层面；本地构建、闸门、飞书均正常
影响   周报卡片与 backtest 无法在 CI 验证，直到 Actions 恢复
```

## 8. Actions 恢复后的 30 分钟清单

> 写于 2026-10-28，Actions 停摆期间。任何人拿到仓库，照做即可，不必问我。

```
0 先判定平台是否恢复
  手动触发 ci.yml（这个文件本轮没改过）
  · 仍是 3 秒 / 0 步骤 → 没恢复，停。看第 6 条
  · 有步骤在跑 → 继续

1 CI 必须绿
  gh workflow run ci.yml --ref main
  等结束 → 结论必须 success，日志里九道闸门 9/9 ok
  ★ 不绿就不要往下走，先修它

2 A 线端点核对（这一步是本周的重点）
  gh workflow run daily.yml --ref main -f route=script
  在日志开头找这五行：
    ARK_MODEL          : 期望 ep-20261019161601-9k6dn
    ARK_MODEL_WRITER   : 期望 ep-20251220173606-gzxdg
    ARK_MODEL_PLANNER  : 期望 ep-20251220175517-rjpsc
    ARK_MODELKIMI      : 期望 ep-20261028184805-v56in（实测 404，知道即可）
    ARK_MODEL_REVIEWER : 期望 ep-20261019161601-9k6dn
  ★ 任一为 ★ MISSING 或空 → yml 的 vars 没生效，先修这个再谈别的
  ★ writer 与 reviewer 必须是不同端点，否则独立审核是假的

3 C 线跑一次
  gh workflow run c-line-daily.yml --ref main
  期望：verdict PUBLISHED，且新指南 figures 不为空
  ★ 若 INSUFFICIENT-EVIDENCE：那是真结果，不是故障

4 B 线定位（本轮没修，恢复后第一件事）
  gh workflow run daily.yml --ref main -f route=agent
  看日志：turn 1 之后是 "no tool call" 还是真的调了工具
  ★ 已知事实：把 agent 的完整 SYSTEM（5849 字）+ 11 个工具原样发一次，
    两个端点都返回 finish_reason=tool_calls。所以丢的地方在循环里，
    不在模型。查 tools/agent-run.mjs 里 `const calls = r.toolCalls ?? []`
    这一行拿到的是什么。

5 把三个 run 链接与结论贴回给老板

6 若 job 仍 3 秒 0 步骤 → 是额度问题
  GitHub → Settings → Billing → Actions 用量
  设 spending limit（哪怕 $5），或等月度重置
  ★ 这不是代码问题，改代码没用
```
