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

## 4. B 线不能自主发布（根因已查明并已修，剩余两处卡点）

```
已查明   "10 轮零工具调用"不是模型不调工具，而是 lib-llm 的 SSE 解析器
         只累加 delta.content，把 delta.tool_calls 整段丢掉 —— 见 943baf2
         ★ 直连非流式请求两个端点都返回 finish_reason=tool_calls，
           说明模型会调，丢的地方在我们自己的解析里
已修     943baf2 SSE 累加 tool_calls（按 index 合并 name/arguments）+ role:"assistant"
         修后实测：turn 1 就出现 read_file，不再是 "no tool call"
已修     e33e109 两条发布路径都过 gateOf()，BLOCK 不发布、warning 走 PUBLISHED-DEGRADED
剩余卡点 ① orphan：link-check 判新页无入链 → 需它在发布前自己链进一篇已有文章
         ② reviewer agent FAIL：原因未查（上一轮只报了现象）
影响     这两项没修完，B 线产出进不了本站
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
  ★ 2026-10-28 22:0x 复核：job 被分配、runner_name 为空、3 秒结束、steps=0，
    且 10 个工作流全部 state=active —— 与权限无关（改权限后仍如此），与代码无关
```

## 9. B 线自主发布的两处卡点（封箱时未修）

```
① orphan — link-check 要求新页被至少一个已有页面链到
   修法   在 SYSTEM 里写成可执行步骤：
          "Before publishing, add one sentence with a link to an existing article that the new page extends.
           Pick it with list_dir + read_file. Do not link to the new page itself."
   验收   link-check 0 orphan

② reviewer agent FAIL — 原因未查
   修法   先诊断：跑一次该闸门，贴完整输出，判定是"模型不可用"还是"内容被判不合格"
   验收   一句结论 + 日志原文

★ 这两项都不大，但都不在封箱范围。B 线降级为"部分完成"。
```

## 10. 裁决 B（引文豁免）未实现

```
背景   逐字引文里出现 may 是必然的（官方原文就有），而 no hedging words 是阻塞级
裁定   引文豁免：只扫正文；豁免仅限 ① 以 > 开头的 blockquote 行
       ② 双引号包裹且片段出现在 sources[] / figures[].source 里的文字
现状   未实现（qa-check 里只有"按日期豁免老文章"，没有引文豁免）
影响   引用含 may 的原文时会被 BLOCK，模型只能绕开那句话
验收   三草稿：引文含 may 通过 / 正文含 may BLOCK / 假引文 BLOCK
```

## 11. check_draft 多违规是否按行号排序 —— 未验证

```
现状   已能一次返回多条（不再是"一次一条"），但未验证是否按行号升序
影响   排序不影响正确性，只影响模型修改顺序
验收   一份 4 处违规的草稿 → 一次返回 4 条且按行号升序
```

## 12. 飞书「自检 / 复盘」两列已落地（更正一条误判）

```
事实   运行台账 9 列 → 11 列；最新一行两列都有值，例如
       自检 "ledger ok · route script · verdict PUBLISHED"
       复盘 "1) 2026-10-28 共 0 次运行，发布 0 篇。 2) 无失败判决。 3) 明天先看失败原因列…"
误判   执行者曾报"两列为空"——原因是它 records/search 未排序，取到了旧行
纪律   读飞书一律带 sort: [{ field_name: "运行日期", desc: true }]
```

## 13. 运行预算与每日监督（长期口径，2026-10-28 定）

**仓库保持私有**（2026-10-28 确认 private；公开会把 docs 里的 base/wiki token 暴露）。

### 削减后的定时与分钟账

```
A 07:20   2 分钟/天
B 20:20   3 分钟/天
C 15:20   4 分钟/天
────────────────────────
每天 9 分钟 → 270/月

周一  需求雷达 5 + 回测 1 + 审计 2 + 深度 5 + 信源探针 1 = 14/周 → 60/月
────────────────────────
合计 约 330 分钟/月  =  免费额度的 17%
```

**★ 每条线只保留一个 cron（备份已全部删除）。代价：GitHub 跳过那次 = 当天没有，而不是晚两小时。**
**★ 交换条件：330/月 远低于 2000 额度，正常情况下不会再撞顶。**

### CI 只在代码变化时跑

```
.github/workflows/ci.yml 的 on.push 已有 paths-ignore：
  data/**  docs/**  out/**  EXPERIMENT_RULES.md
★ 数据、文档、周报提交不再触发九道闸门
★ src/ 与 .github/ 变化仍然触发 —— 这两处才是会改站点的地方
```

### 每日监督六项（只读，不改任何东西）

| # | 查什么 | 怎么查 | 判定 |
|---|---|---|---|
| 1 | 运行台账有没有今天的新行 | records/search + sort 运行日期 desc | 有行=在跑；无行=停了 |
| 2 | 内容台账 total 有没有涨 | 同上 | 涨=有新文章；三天不涨=异常 |
| 3 | 站点能不能开 | GET / 与最新一篇 | 200=正常 |
| 4 | 最近一次云端 run 的结论 | gh run list | success / failure / 0 步骤 |
| 5 | B 线有没有进步 | run 日志里的 verdict | PUBLISHED 才算进步 |
| 6 | open-items 有没有新增 | 数 `^## ` 条数 | 涨=又发现新问题 |

**★ 每日交付一句话：今天在跑 / 今天停了 / 哪里坏了。查不到就说查不到，不猜。**

## 14. 时钟只剩 Cloudflare Worker 一个来源（2026-10-29）

```
事实  GitHub 的 cron 全部注释（5143d4b），未注释 cron 行 = 0；workflow 仍可手动 dispatch
时钟  Cloudflare Worker "landedmath-cron"：07:20(A) / 09:20(A备份) / 15:20(C) / 20:20(B, 周日二四)
风险  Worker 停了、PAT 过期、变量被删 → 没有任何东西触发，系统静默停摆
★ 这正是今天最难发现的那种故障：不是红了，是什么都没有
缓解  每天查一次"昨晚有没有 run"，没有就报；Worker 日志在 CF 后台 Observability，204 成功 / 401 是 PAT
待决议 09:20 那条 A 线备份：月度预算里已删，但 Worker 仍在触发 → 每天多一次 A 线（约 2 分钟）
        要么删 Worker 那条 cron，要么接受这个开销
```
