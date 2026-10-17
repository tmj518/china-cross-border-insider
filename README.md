# Landed Math

> **2026-10-01 改名**：项目原名 "China Cross-border Insider"（暂定名），域名 `crossborderinsider.com` 已被占用，
> 正式定名为 **Landed Math**（域名 `landedmath.com`）
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

> 安全权衡：两者都不做吊销检查。方案 A 使用 Windows 证书存储；方案 B 使用 Git 自带 CA bundle。本网络下无差别，换到网络正常的机器上建议恢复默认（`--unset`）。

### 3.3 ⚠️ 抓取网页：不要用 `Invoke-WebRequest`

在本机的 Windows PowerShell 5.1 上，`Invoke-WebRequest` 和 `Invoke-RestMethod` 会调用 IE 引擎解析页面，**弹出"安全提醒"模态对话框并让命令永久卡住**——如果是 Agent 在跑，整个任务就停在那里等一个没人看见的确认框。

统一改用这两种方式（Agent 和人都适用）：

```powershell
curl.exe -sSL "https://example.com"          # Windows 自带
node -e "fetch('https://example.com').then(r=>r.text()).then(t=>console.log(t))"
```

其他已验证的网络事实：

| 目标 | 表现 |
| --- | --- |
| `google.com` / `duckduckgo.com` / `startpage.com` / `consilium.europa.eu` | 超时或被浏览器校验挡住 |
| `bing.com` | 通，但**会截断查询**（只按第一个词返回），且返回中文市场结果 |
| `customs.gov.cn` | HTTP 412（反爬），需用镜像 |
| `taylorwessing.com` / `dlapiper.com` 等 | Azure WAF / 429 |
| `web_fetch` 工具 | **不支持 PDF**（`unsupported content type`）——PDF 源要另想办法 |
| 中国官方发布渠道（新华社、中国网） | 可达，是海关总署/财政部公告的可靠镜像 |

**验证记录**（2026-10-01）：

```
git ls-remote https://github.com/git/git.git HEAD   → exit 0，5.9s，返回真实 SHA
git clone --depth 1 https://github.com/octocat/Hello-World.git  → exit 0，2.3s，checkout 成功
```

> 备注：`git` 命令需要**新开一个终端**才会进入 PATH（用户级 PATH 的修改不影响已运行的进程）。

### 3.4 ⚠️⚠️ 编辑文本文件：绝不要用 PowerShell 读改写回

**这是本项目真实发生过的一次数据损坏事故。**

2026-10-03，为验证视频组件，我用 PowerShell 对一篇文章做了这个操作：

```powershell
$orig = Get-Content $f -Raw          # 读
Set-Content -Path $f -Value $test    # 写（临时测试内容）
Set-Content -Path $f -Value $orig    # 写回原始内容
```

**结果：文章里所有 em dash（`—`）都变成了 `—?`。**

原因：本机系统区域是中文，`Set-Content` 用 **GBK 代码页**写出，而 em dash（UTF-8 `E2 80 94`）在 GBK 里无法表示，续字节被换成 `0x3F`（`?`）。字节级证据：

```
期望: ... E2 80 94 ...
实际: ... E2 80 3F ...     ← 第三字节变成 '?'
```

**这类损坏在浏览器里几乎看不出来**，但会污染所有标点。

**正确做法**（按优先级）：

| 方式 | 说明 |
| --- | --- |
| **用 `edit` / `write` 工具** | Agent 首选。工具按 UTF-8 处理，不会经过代码页 |
| `Set-Content -Encoding utf8` | 如果非要用 PowerShell，**必须显式指定编码** |
| `[System.IO.File]::WriteAllText($p, $s, [System.Text.UTF8Encoding]::new($false))` | .NET 直写，最可控 |

**并且闸门已经加了守卫**：`tools/qa-check.mjs` 的 `text encoding` 规则。

Node 的 utf8 解码器是宽松的——遇到非法字节会替换成 `U+FFFD` 而不是抛错。所以**一条规则同时覆盖两种情况**：真正的非法 UTF-8，以及"经过坏代码页往返"的文本。

```
✗ BLOCK  text encoding   2 replacement character(s) — file was rewritten
                         through a non-UTF-8 codepage
```

已用故意破坏的 em dash 测试过，确实会拦。

**Git 是最后一道保险**：损坏后 `git checkout -- <file>` 可完整恢复。所以**在未提交的状态下做批量文本操作要格外小心**。

### 3.5 本机工具链（2026-10-03 补全）

| 工具 | 版本 | 位置 | 用途 |
| --- | --- | --- | --- |
| **Python** | **3.13.16** | `%LOCALAPPDATA%\Programs\Python\Python313\` | Office/数据/PDF/TTS |
| **ffmpeg / ffprobe** | **9.0.2** (gyan.dev essentials) | `%LOCALAPPDATA%\Programs\ffmpeg\bin\` | 视频编码，**含 libx264** |
| **yt-dlp** | 2026.08.19 | 同上 | YouTube 下载/元数据 |
| **n8n** | 见下 | `%LOCALAPPDATA%\Programs\n8n\` | 工作流自动化 |
| git | 2.56.0 PortableGit | `%LOCALAPPDATA%\Programs\PortableGit\` | 版本控制 |

**为什么 Python 选 3.13 而不是 3.14**：3.14 太新，数据/自动化库仍在对齐；3.13 是"现代又安全"的甜点。3.12 已开始有库放弃支持。

**Python 库**（已装）：pandas 3.0.6 · openpyxl · python-docx · python-pptx · Pillow · lxml · XlsxWriter · requests · beautifulsoup4 · **edge-tts**（免费神经语音 TTS，无需 API key）

**内置 Python 为什么坏**：DSH 运行时里的 `dependencies\python\` 只有 `python.exe` + `python3.dll`，**缺 `python3XX.dll` 和 Lib 内容**。`python3.dll` 是转发层，找不到目标就报 `-1073741515`（`0xC0000135`）。修不如重装——已另装独立 Python，不动 DSH 自带的那份。

**PATH 说明**：Python 与 ffmpeg 已加入用户级 PATH。**已运行的进程看不到**，需新开终端，或在命令里显式加：

```powershell
$env:PATH = "$env:LOCALAPPDATA\Programs\ffmpeg\bin;$env:LOCALAPPDATA\Programs\Python\Python313;$env:LOCALAPPDATA\Programs\Python\Python313\Scripts;" + $env:PATH
$env:PYTHONIOENCODING = "utf-8"   # 否则中文区域下 Python 打印非 ASCII 会抛 UnicodeEncodeError
```

### 3.6 ⚠️⚠️ 命令行上不了 Google —— 本机最关键的一条配置（2026-10-03 解决）

**症状**：浏览器能打开 Google / GSC / Trends / Reddit，但 `curl`、Node `fetch`、Python `requests` 全部**超时**。

**根因**（三层，必须全部解决）：

| 层 | 问题 | 证据 |
| --- | --- | --- |
| 1 | **系统代理开着，但命令行工具不读它** | 注册表 `ProxyEnable=1`、`ProxyServer=http=127.0.0.1:7890;https=127.0.0.1:7890`，端口 7890 在监听。浏览器读这个设置，curl 只认 `HTTP_PROXY` 环境变量 |
| 2 | **设用户级环境变量也没用** | DSH 派生 shell 时捕获了环境块，**新进程不继承**。实测 `Process` 作用域仍是空 |
| 3 | **走代理后 schannel 报 `0x80092013`** | "吊销服务器离线"——和当初 `git ls-remote` 挂 300 秒是同一个问题 |

**解决方案**：把代理写进 **`%USERPROFILE%\.curlrc`**。curl 每次调用都重新读这个文件，所以绕开了环境块继承问题。

```
proxy = http://127.0.0.1:7890
ssl-no-revoke
connect-timeout = 20
```

**实测结果**（裸 curl，不传任何参数）：

| 目标 | 配置前 | 配置后 |
| --- | --- | --- |
| `google.com` | 超时 | **200** |
| `trends.google.com` | 超时 | **200** |
| `searchconsole.googleapis.com` | 超时 | **404（可达）** |
| `reddit.com` | 超时 | **403（可达）** |
| `bing.com` | 200 | 200 |

**这件事的意义**：规范和路线图里的「GSC 数据回流闭环」「Google Trends 选题」**在这之前是无法自动化的**——不是设计问题，是命令行根本没有到 Google 的路。

**给 Node / Python 脚本用**（它们不读 `.curlrc`，只能靠环境变量，所以在命令里显式设）：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:HTTP_PROXY  = "http://127.0.0.1:7890"
```

```javascript
// Node：内置 fetch 不认 HTTPS_PROXY，需要 undici 的 ProxyAgent
import { ProxyAgent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(new ProxyAgent("http://127.0.0.1:7890"));
```

```python
# Python requests 自动读这两个变量
proxies = {"http": "http://127.0.0.1:7890", "https": "http://127.0.0.1:7890"}
```

**坑中坑**：`Set-Content -Encoding utf8` 在 Windows PowerShell 会**写入 BOM**，而 curl 会把 BOM 当成非法首行。写 `.curlrc` 必须用：

```powershell
[System.IO.File]::WriteAllText($path, $content, (New-Object System.Text.UTF8Encoding($false)))
```

**另一个坑**：`.curlrc` 里的 `compressed` 选项**当前 libcurl 不支持**，会每次都打警告。

### 3.7 视频：从文章生成英文短视频
```powershell
python tools/make-video.py <slug>                      # 完整生成
python tools/make-video.py <slug> --dry-run            # 只出分镜+语音，跳过 ffmpeg
python tools/make-video.py <slug> --voice en-GB-RyanNeural
```

流程：**读文章 → 从文章自己的文字里取旁白 → edge-tts 合成 → Pillow 画幻灯片 → ffmpeg 拼接**。

设计要点：

1. **旁白完全来自文章正文**（AI Summary / What happened / So what 的表 / The point），所以**视频不可能说出文章里没有的话**。这是规范 §7「不编造」在视频上的延伸。
2. **不用任何 API key**：edge-tts 走微软公开的神经语音服务，Pillow 画纯文字幻灯片，因此没有图库授权问题。
3. **产物在 `build/video/`，已 gitignore**。只有 YouTube id 进仓库。

**已知的第一个坑（已修）**：表格单元格里的 Markdown 粗体 `**€15.00**` 曾被原样画成字面文字，因为段落清洗函数没作用到表格。现在单元格带 `emph` 标记，渲染成强调色。

**发布后回写**：拿到 YouTube 链接后，在文章 frontmatter 加：

```yaml
youtube_id: "dQw4w9WgXcQ"     # 只要 11 位 id，不要整条 URL
videoTitle: "..."              # 可选，默认用文章标题
videoDuration: "PT4M13S"       # 可选，ISO 8601，喂给 VideoObject
```

`ArticleVideo` 组件会自动渲染 `youtube-nocookie` 播放器（`loading="lazy"`）+ `VideoObject` 结构化数据，**让视频在搜索结果里独立占位**。

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

### 5.1 ⚠️ Cloudflare 控制台必须保持的设置（2026-10-02 定）

这些**不是可选项，是正确性要求**。免费版的几个默认值会破坏站点功能，换域名或换人维护时务必核对。

| 设置 | 位置 | 必须 | 为什么 |
| --- | --- | --- | --- |
| **Email Address Obfuscation** | 域 → 安全/设置 → Client side abuse | **关** | 免费版**默认开启**，它把 HTML 里的邮箱替换成 `/cdn-cgi/l/email-protection#...`（需 JS 解码）。实测结果：首页/contact/about/privacy 四页**明文邮箱为 0**，Contact 页用户看不到也复制不了邮箱。关闭后恢复为明文 `mailto:`。 |
| **Bot fight mode** | 域 → 安全/设置 → DDoS attacks | **关** | 会拦截自动化流量，是"网站正常但 Google 抓不到"最常见的原因。 |
| **AI bot policies → Search** | 域 → 安全/设置 → AI bots | **Allow** | 不被搜索引擎抓 = 不存在。 |
| **AI bot policies → Agent** | 同上 | **Allow** | 最关键的一项。"Agent"是抓取内容回答用户问题的爬虫（PerplexityBot / ChatGPT 一类），**GEO 战略完全依赖它**。 |
| **AI bot policies → Training** | 同上 | **Allow** | 是否允许用于训练。允许以换取被引用。 |
| **Bot Preference Sync** | 同上 | **关** | 它会去改 `robots.txt`，而我们的 `robots.txt` 是 Astro 生成、已正确声明 sitemap，不要让它插手。 |

**验证方法**（关掉邮箱混淆后跑，期望明文 ≥1、混淆 = 0）：

```powershell
curl.exe -4 -sS https://landedmath.com/contact/ |
  Select-String -Pattern 'cdn-cgi/l/email-protection','hello@landedmath.com'
```

### 5.2 邮箱（Email Routing）

MX（`route1/2/3.mx.cloudflare.net`）与 DKIM（`cf2024-1._domainkey`）已配好并锁定。
**还需一步**：电子邮件路由 → 「路由规则」→ 创建地址 `hello` → 转发到 Gmail。只配 MX 收不到信。

**当前能力边界**：`hello@landedmath.com` 只能**收信转发**，不能以它**发信**。
要以它的名义回信，需另配 SMTP（Resend 免费额度足够），列在路线图待办中。

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
★ 所以不需要 git filter-repo。 那件事会重写 264 个提交的历史，只在确实超限时才值得做，而现在离限制还有 93%。

★ 我把判断标准也给你：到 400 MB 再做，那时候梯度也还在（一次 gc + 一次 filter-repo 能回收大部分）。

## 八、规范里还没落地的部分


