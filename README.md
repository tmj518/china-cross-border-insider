# Landed Math

> **2026-10-01 改名**：项目原名 "China Cross-border Insider"（暂定名），域名 `crossborderinsider.com` 已被占用，
> 正式定名为 **Landed Math**（域名 `landedmath.com`）。改名同时避开了与 Business Insider 的商标临近风险。
> 仓库名与 Cloudflare Pages 项目名仍是历史名 `china-cross-border-insider`，不影响使用。

跨境英文内容站。技术栈：**Astro 7 + GitHub + Cloudflare Pages**，纯静态、无服务器、无数据库。

本仓库的内容分层：

| 位置 | 作用 |
| --- | --- |
| **`项目规范_英文内容站_v1.3.md`** | ⭐ **生效规范**（2026-10-02 定稿）：定位与受众、技术架构、frontmatter 标准、V6.1 模板、两道质检闸门、成本模型库、数据回流闭环、KPI、红线 |
| `项目规范_英文内容站_v1.2.md` / `_v1.0.md` | 历史版本，仅作沿革参考 |
| `项目规范_英文内容站_v1.3_修订建议清单.md` | v1.2 → v1.3 的修订过程记录（含依据与出处） |
| `英文站首页_完整版.html` | 视觉原型（单文件预览），**不参与构建**，只作视觉基准 |
| `src/` `public/` `tools/` | 站点与流水线：Astro 站点、5 个成本模型、2 道质检闸门 |

---

## 一、目录结构

```
├── astro.config.mjs          # site / sitemap 集成 / 构建格式
├── package.json              # 依赖与脚本（engines: node >= 22.12）
├── pnpm-workspace.yaml       # pnpm 11 的构建脚本白名单（esbuild）
├── tsconfig.json             # 继承 astro/tsconfigs/strict
├── .nvmrc                    # Cloudflare Pages 读它选 Node 版本
│
├── public/                   # 原样拷贝到 dist/
│   ├── favicon.svg
│   ├── og-default.png        # 默认社交分享图（1200×630，脚本生成）
│   └── _headers              # CF Pages 安全响应头 + 缓存策略
│
├── scripts/
│   └── make-og-image.mjs     # 重新生成 og-default.png
│
└── src/
    ├── consts.ts             # 站点/导航/分类/作者/页脚 —— 唯一事实来源
    ├── content.config.ts     # blog 集合的 frontmatter schema（zod）
    ├── content/blog/*.md     # 文章（Markdown）
    ├── lib/post.ts           # 排序、字数时长、related、Today's Numbers
    ├── styles/global.css     # 设计 token + 全部样式（原型 CSS 的整理版）
    ├── layouts/BaseLayout.astro   # <head> SEO + 导航 + 页脚
    ├── components/           # Nav / Hero / FeaturedCard / ArticleRow /
    │                         # Sidebar / AuthorCard / NumbersWidget /
    │                         # NewsletterForm / ArticleFooter / RelatedCard / Footer
    └── pages/
        ├── index.astro            # 首页
        ├── blog/[slug].astro      # 文章页
        ├── category/[category].astro  # 三个栏目页（由 CATEGORIES 生成）
        ├── about / privacy / contact / 404
        ├── rss.xml.ts             # /rss.xml
        └── robots.txt.ts          # /robots.txt
```

## 二、常用命令

```bash
pnpm install        # 安装依赖
pnpm dev            # 本地预览 http://localhost:4321
pnpm build          # 构建到 dist/（Cloudflare Pages 用这条）
pnpm preview        # 预览构建产物
pnpm check          # Astro + TypeScript 类型检查（当前 0 error / 0 warning）
pnpm og             # 重新生成 public/og-default.png
```

## 三、环境说明（重要，只影响本机）

这台机器缺少 VC++ 运行库（`System32` 下没有 `vcruntime140.dll`），导致 Astro 7 依赖的原生模块 `satteri` 加载失败。当前通过把运行库 DLL 放进 `node_modules/.pnpm/@bruits+satteri-win32-x64-msvc@0.10.5/.../` 解决。

**该目录在 `node_modules` 里，重装依赖会丢。** 换机器或重装后如果报
`Cannot find native binding` / `The specified module could not be found`，二选一：

1. 安装 [Microsoft Visual C++ Redistributable (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe)（推荐，一次解决）；
2. 从 `<DSH 运行时>\dependencies\python\` 复制 `vcruntime140.dll`、`vcruntime140_1.dll` 到上面那个 satteri 目录。

其他两处环境相关的取舍：

- `pnpm-workspace.yaml` 里的 `allowBuilds: esbuild: true` —— pnpm 11 默认拦截依赖的构建脚本，esbuild 必须放行，否则 `astro build` 跑不起来。
- `typescript` 锁在 **6.x**：`astro check` 尚不支持 TypeScript 7，装上 7 会直接报错退出。

### 3.1 Git（2026-10-01 安装）

这台机器原本**没有任何包管理器**（无 winget / choco / scoop），也没有 git。已按免安装方式装好：

| 项 | 值 |
| --- | --- |
| 版本 | Git for Windows **2.56.0**（PortableGit） |
| 位置 | `%LOCALAPPDATA%\Programs\PortableGit` |
| PATH | 用户级 PATH 已追加 `...\PortableGit\cmd` |
| 凭据助手 | `ucrt64\bin\git-credential-manager.exe`（随包提供） |

**已做的全局配置**：

```ini
init.defaultBranch = main
core.autocrlf      = true
core.quotepath     = false      # 中文文件名不再显示成八进制转义
core.longpaths     = true
fetch.prune        = true
pull.rebase        = false
http.schannelCheckRevoke = false   # ← 见下方说明，本机必需
```

**`http.schannelCheckRevoke = false` 是本机能用 git 的关键。** 症状：`git ls-remote` 卡死 300 秒后报 `Connection timed out`，而同一 URL 用 `curl` 或 Node 却是 200。用 `GIT_CURL_VERBOSE=1` 抓到真正原因——TCP 连上了正确 IP（20.205.243.166），但 schannel 在 `checking server certificate revocation` 之后一直停在 `failed to receive handshake, need more data`：**证书吊销列表（CRL/OCSP）的查询被网络挡住，握手就此卡死**。

等价替代方案（二选一即可，两者都实测通过）：

```bash
# 方案 A（当前采用）：保留 schannel，关闭吊销检查
git config --global http.schannelCheckRevoke false

# 方案 B：改用 openssl 后端（走 Git 自带 CA bundle，不做 CRL 查询）
git config --global http.sslBackend openssl
```

> 安全权衡：两者都不做吊销检查。方案 A 使用 Windows 证书存储；方案 B 使用 Git 自带 CA bundle。本网络下没有区别，换到网络正常的机器上建议恢复默认（`--unset`）。

**验证记录**（2026-10-01）：

```
git ls-remote https://github.com/git/git.git HEAD   → exit 0，5.9s，返回真实 SHA
git clone --depth 1 https://github.com/octocat/Hello-World.git  → exit 0，2.3s，checkout 成功
```

> 备注：`git` 命令需要**新开一个终端**才会进入 PATH（用户级 PATH 的修改不影响已运行的进程）。

### 3.2 GitHub 仓库（2026-10-01 建立）

| 项 | 值 |
| --- | --- |
| 仓库 | `https://github.com/tmj518/china-cross-border-insider`（**私有**） |
| 远端 | `git@github.com:tmj518/china-cross-border-insider.git`（SSH 协议） |
| 分支 | `main`（跟踪 `origin/main`） |
| 首次提交 | `951564b` — 47 个文件 |
| 提交署名 | `V <209195161+tmj518@users.noreply.github.com>`（**仅本仓库**的 local 配置，未改全局） |
| SSH 密钥 | `~/.ssh/id_ed25519`，已注册到 GitHub（标题「工作机-PortableGit」） |

日常推送：

```bash
git add -A
git commit -m "post: <slug>"
git push
```

**本机网络的关键事实**（排查网络问题时先看这条）：

| 端点 | 表现 | 影响 |
| --- | --- | --- |
| `github.com` HTTPS | 被间歇性干扰，成功率 0~12% | **浏览器访问 GitHub 会转圈，刷新重试即可** |
| `api.github.com` HTTPS | 稳定（4/4） | API 调用没问题 |
| `github.com:22` SSH | **稳定** | **push / pull 不受影响** |

也就是说：**代码推拉没问题，只有"人在浏览器里操作 GitHub"和"gh CLI 设备码登录"会受影响**（gh 的设备码与令牌轮询都走 `github.com`，实测重试 15 次仍失败，最终改用 SSH 密钥 + 浏览器手工建仓）。


## 四、写一篇文章

在 `src/content/blog/` 新建 `<slug>.md`，文件名即 URL（`/blog/<slug>/`）。frontmatter 字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | ✅ | ≤120 字符 |
| `description` | ✅ | ≤300 字符，同时用作 `<meta description>` 和卡片摘要 |
| `publishDate` | ✅ | `2026-09-29` |
| `updatedDate` | | 有更正时填，会输出 `article:modified_time` |
| `category` | ✅ | `trade-policy` / `platforms` / `supply-chain` 三选一 |
| `tags` | | 字符串数组 |
| `priority` | | `P0` / `P1` / `P2`，首页侧栏统计用 |
| `featured` | | `true` 时进首页 Hero |
| `draft` | | `true` 则完全不出现在站点与 RSS |
| `sources` | | 信源名单，正文底部渲染成 Sources。**正文里不写 URL**（规范 §4.3） |
| `heroImage` / `heroImageAlt` | | 配图路径 + alt |

正文按写作模板 V6.1 组织：

```markdown
Hook 段（不写小标题，直接抛反常识问题）

## What happened
## Why now
## So what
## For you
## The data point
```

可直接用的两个片段：

```html
<div class="callout">
<span class="callout-label">Data point</span>
一句话关键数字收尾。
</div>
```

成本测算用标准 Markdown 表格即可（样式已内置）。

### 发布前自检（已自动化，取代人工审稿）

人工审稿已取消。原来靠人看的东西，现在由**两道脚本闸门**把关，**失败即不得发布**：

```bash
pnpm qa        # 质检闸门：17 条规则（结构 / 语言 / 数字五元组）
pnpm qa:serp   # 信息增量闸门：抓目标词 SERP 前三名，比对"这篇比他们多什么"
pnpm landed    # 成本模型：FOB → 关税 → 到岸成本（每件 / 每柜）
pnpm guarantee # 成本模型：税款担保的资金占用成本
```

**闸门一：[qa-check.mjs](tools/qa-check.mjs)** — 阻断项包括

| 规则 | 判定 |
| --- | --- |
| 数字五元组 | `figures[]` 每条必须有 value + unit + period + source + retrieved，缺项即阻断 |
| 数字数量 | 少于 5 个即阻断 |
| 信息增量声明 | 缺 `information_gain` 即阻断 |
| 目标关键词 | 缺 `target_keyword` 即阻断 |
| AI Summary | 必须恰好 40-60 词 |
| 六段结构 | Hook / What happened / Why now / So what / For you / The data point 缺一即阻断 |
| FAQ | 3-5 问，答案 80-150 词 |
| 字数 | 正文 1500-2500 |
| 对比表 / 定义块 | 各至少 1 个 |
| 分人群建议 | ≥3 |
| 模糊词 | may / might / possibly / perhaps / could / reportedly … |
| AI 套话 | delve / landscape / in today's fast-paced world … |
| 敏感词 | 政策红线黑名单 |
| 正文 URL | 一个都不许有 |

**闸门二：[serp-check.mjs](tools/serp-check.mjs)** — 按 `information_gain` 的类型逐条验证：

| 声明类型 | 机器判定方式 |
| --- | --- |
| `custom-calculation` | 本文必须有带金额的每件/每柜成本表，且 SERP 前三名中 ≤1 个有同类计算 |
| `primary-source` | 本文必须引用一次文献编号（FR / 公告号 / HTSUS），且竞品中 ≤1 个引用 |
| `cross-source` | 本文 ≥2 个具名来源，且竞品中 ≤1 个有相当的数据密度 |
| `own-data` | **机器无法验证 → 一律 INCONCLUSIVE**，转人工 |

**SERP 来源可插拔**（因为本机抓不到 Google/DDG，Bing 也会截断查询）：

```bash
pnpm qa:serp                                  # 默认 best-effort 抓 Bing
node tools/serp-check.mjs <file> --serp=file:data/serp   # 用快照
```

快照放 `data/serp/<文章名>.json`，格式 `[{url,title,snippet}]`。生产流水线里写稿 agent 自带搜索能力，由它产出快照；接付费 SERP API 也是同一个入口。

**设计原则：抓不到就拒绝盖章。** 没有 SERP、SERP 与关键词不相关、竞品页面加载不足 2 个、或声明类型机器无法验证 —— 全部返回 `INCONCLUSIVE`，**绝不返回 PASS**。官方源（`.gov` / `customs.gov.cn` / FR 等）会被识别并**排除出竞品分母**，因为那是输入，不是竞争。

> 实测记录（2026-10-01）：
> - A 篇 `custom-calculation` → **SUPPORTED**：三个竞品全部 `costTable=false / perUnit=false`；同时其中两个 `primaryDoc=true`，**说明如果 A 篇声明的是 `primary-source`，它会被判不合格** —— 闸门确实在区分不同声明。
> - B 篇 `primary-source` → **INCONCLUSIVE**：竞品页面在本机网络下抓取失败（2/3 失败），拒绝认证。需在正常网络上重跑。


## 五、部署到 Cloudflare Pages

**状态：已上线** —— 仓库 `tmj518/china-cross-border-insider`，CF Pages 项目同名，正式域名 `landedmath.com`。

1. ~~推到 GitHub 仓库~~ ✅
2. ~~Cloudflare Pages → Create project → Connect to Git~~ ✅
3. 构建设置（已配置）：
   - Framework preset：**Astro**
   - Build command：`pnpm build`
   - Build output directory：`dist`
   - 环境变量：`NODE_VERSION=24`
4. ~~域名~~ ✅ 已注册 `landedmath.com` 并绑定到 CF Pages 的 Custom domains；
   `src/consts.ts` 的 `SITE_URL` 已指向它 —— canonical / sitemap / RSS / og:image 全部从这一处取值，改一处即可。

## 六、相对原型做的改动

原型是视觉稿，转成站点时补了工程必需但原型没有的部分：

1. **SEO 骨架**：canonical、description、OG/Twitter、JSON-LD（WebSite / Article / AboutPage）、
   sitemap-index.xml、robots.txt、RSS —— 原型一个都没有。
2. **修掉中文混入**：原型 Related Reading 里那条 `保税物流` 已改成英文
   （`Bonded Logistics Growth of 42.3%...`）。
3. **订阅框变成真表单**：`<form>` + `<label>` + `required`，不再是裸 input/button。
   **但还没有后端**：`src/consts.ts` 的 `newsletterAction` 为空，接 Buttondown/ConvertKit 时填上即可。
4. **移动端导航**：原型在 ≤900px 直接 `display:none`，现在有 Menu 按钮可展开。
5. **Today's Numbers 不再写死**：由文章数量、P0/P1 条数、覆盖栏目数实时算出，
   不会出现原型那种编造的数字。
6. **标题层级修正**：原作者卡用了 `h5`、相关阅读用了 `h6`，现在按语义归位。
7. **无障碍**：skip link、`:focus-visible`、`aria-current`、图片 alt、`<main id="main">`。
8. **示例文章**：`src/content/blog/` 下 6 篇是**占位样例**（文件顶部有注释标明），
   数字是示意性的，上线前必须替换成真实取材的稿件 —— 规范 §7 明令不编造数据。

## 七、待你确认 / 待补

| # | 事项 | 现状 |
| --- | --- | --- |
| 1 | ~~**正式域名**~~ | ✅ 已定 `landedmath.com`（2026-10-01 注册，Cloudflare Registrar，$10.46/年） |
| 2 | **金色 `#ffd166`** | 规范 §3 只定义了三色，原型多用了这个金色（kicker / 页脚 hover）。要么写进规范，要么去掉 |
| 3 | **P0/P1/P2 体系** | 规范里没有定义，原型已在用。需要补一段判定标准 |
| 4 | **作者信息** | 已按 v1.2 §11 对齐：笔名 `V`、China Supply Chain Analyst · Shenzhen。**仍缺真实头像**（`AUTHOR.avatar`），以及 `hello@landedmath.com` 需要开 Cloudflare Email Routing 才能真正收信 |
| 5 | **配图规范** | 现在只有渐变/emoji 占位。建议定：1200×750、(16:10)、alt 必须写、单张 <200KB |
| 6 | **订阅后端** | `newsletterAction` 为空 |
| 7 | **LinkedIn / X** | 可选，暂未加 |
| 8 | **栏目扩容** | 定位已定（2026-10-01）：保留「独立分析」表述，受众**做增量**——欧美平台卖家 + 一带一路/新兴市场进口商。新增受众需要新增栏目，**栏目 slug 即 URL，定稿前不建页** |

## 八、规范里还没落地的部分

- 豆包定时任务写稿 → 飞书审稿 → 说"发" → git push（第 2~4 步的自动化）
- 提交 GSC Indexing API（需要 service account + 定时任务）
- 每周拉 GSC 回流数据选下周选题（`sources` / `tags` 字段已经为这一步预留了结构）
- AdSense / 联盟位（规范 §8，前 6 个月本来也不该上）
