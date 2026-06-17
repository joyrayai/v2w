# 网盘视频转 Word

[GitHub](https://github.com/joyrayai/v2w) · [Issues](https://github.com/joyrayai/v2w/issues)

当前版本：`0.1.2`

一个单机部署的视频转写工作台，支持把直链、视频页面链接、百度网盘和夸克网盘分享链接批量转成 Word 文件。`0.1.2` 定位是小规模内测版：优先保证单服务器可运行、任务可恢复、文件可下载、用量可追踪，并提供轻量百度扫码授权。

## 0.1.2 版本范围

### 已支持

- 账号注册、登录、退出。
- 管理员后台：账号管理、密码重置、全站用量查看。
- 直链模式：公网 HTTP/HTTPS 音视频 URL 直接提交 ASR。
- 页面链接：B 站链接优先使用内置解析；其他页面链接使用 `yt-dlp` 下载音频。
- 网盘模式：百度网盘和夸克网盘分享链接。
- 网盘授权：每个应用账号独立保存百度/夸克授权状态。
- 百度扫码登录：按需启动临时浏览器会话，扫码成功后提取并校验 Cookie。
- 批量任务：全局最多 5 个任务同时处理，单用户默认最多 2 个运行任务。
- 任务进度：展示阶段进度、下载速度、阶段序号。
- Word 输出：默认生成“原文”；额外文件按用户模板和提示词生成。
- 模板管理：额外文件模板与用户账号绑定，支持保存和删除。
- 智能命名：额外文件生成后可统一生成文件名，不影响正文生成。
- 批量下载：完成任务的 Word 文件可打包下载。
- 用量统计：记录 ASR 时长、AI token、ASR 成本、AI 成本和总成本。
- 本地持久化：用户、任务、网盘授权、模板、用量记录保存在 SQLite。
- 缓存清理：成功任务清理下载/音频缓存；失败任务缓存保留到过期清理。
- 账号级模型配置：任务提交和重试只使用服务器保存的当前账号配置，不再依赖浏览器本地模型缓存。
- 重试失败任务：失败任务可重新排队；额外文件失败时可只重试失败的额外文件。

### 不在 0.1 范围

- 多服务器部署。
- 企业组织、角色权限、审计日志。
- 微信扫码登录。
- 正式计费和余额系统。
- 官方百度网盘开放平台接入。
- 网盘文件列表浏览器。
- 分布式任务队列和独立 Worker。
- 文档安全审查插件。

## 技术栈

- 前端：Vite + React
- 后端：Express
- 数据库：SQLite，使用 `better-sqlite3`
- 文档生成：`docx`
- ZIP 打包：`archiver`
- 网盘下载：`BaiduPCS-Go`、夸克网页接口
- 页面视频解析：`yt-dlp`
- 音频处理：`ffmpeg` / `ffprobe`
- 默认 ASR：阿里云百炼 Paraformer
- 默认 AI 处理：OpenAI-compatible Chat Completions

## 目录结构

```text
.
├── index.html
├── package.json
├── .env.example
├── LICENSE
├── README.md
├── scripts/
│   └── setup-netdisk-env.sh
├── server/
│   └── src/
│       ├── auth.js
│       ├── config.js
│       ├── index.js
│       ├── routes.js
│       ├── store.js
│       ├── utils.js
│       └── services/
│           ├── ai.js
│           ├── baidu-qr-login.js
│           ├── media.js
│           ├── netdisk.js
│           ├── usage.js
│           ├── word.js
│           └── downloaders/
│               ├── bilibili.js
│               ├── http.js
│               ├── quark.js
│               └── ytdlp.js
└── web/
    └── src/
        ├── assets/
        ├── main.jsx
        └── styles.css
```

## 本地运行

推荐先运行部署引导脚本，它会检查 Node、媒体工具、网盘工具，生成 `.env`，安装依赖并构建前端：

```bash
npm run setup
```

如果希望脚本尝试安装 `ffmpeg`、`yt-dlp` 和 `BaiduPCS-Go`：

```bash
npm run setup -- --install-system
```

仅检查环境：

```bash
npm run doctor
```

手动启动开发环境：

```bash
npm install
cp .env.example .env
npm run dev
```

默认服务：

- 后端：`http://localhost:5174`
- 前端：`http://localhost:5173`

生产构建：

```bash
npm run setup -- --production
npm start
```

## 服务端依赖

网盘和页面链接能力依赖系统命令：

- `ffmpeg`
- `ffprobe`
- `BaiduPCS-Go`
- `yt-dlp`
- Chrome 或 Chromium，用于百度扫码登录

可以使用脚本安装常用环境：

```bash
npm run setup -- --install-system
```

如需安装后直接登录百度网盘：

```bash
bash scripts/setup-netdisk-env.sh --login
```

## 配置项

开源仓库只提供 [.env.example](.env.example)，不要提交真实 `.env`、API Key、Cookie、SQLite 数据库或生成文件。

常用环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `5174` | 后端监听端口 |
| `PUBLIC_BASE_URL` | 空 | 生成临时音频公网 URL 时使用；前端提交时通常会传当前访问域名 |
| `SESSION_SECRET` | 开发默认值 | 登录 token 签名密钥，生产环境必须设置 |
| `MAX_CONCURRENCY` | `5` | 全局并发上限，最大限制为 5 |
| `MAX_USER_RUNNING` | `2` | 单用户运行中任务上限 |
| `MAX_USER_QUEUED` | `50` | 单用户待处理任务上限 |
| `MIN_FREE_DISK_GB` | `6` | 磁盘低于该值时暂停新任务 |

默认模型和价格配置在 [server/src/config.js](server/src/config.js)。

## 数据目录

运行时数据在 `data/` 下，部署和打包时不要覆盖。

```text
data/
├── app.sqlite
├── users.json
├── downloads/
├── audio/
├── outputs/
└── netdisk-users/
```

说明：

- `app.sqlite`：主数据库。
- `users.json`：旧版用户文件，只用于迁移兼容。
- `downloads/`：任务下载文件。
- `audio/`：抽取后的音频，同时作为临时公网文件目录。
- `outputs/`：生成的 Word 文件。
- `netdisk-users/`：每个应用账号独立的 BaiduPCS-Go 配置目录。

`data/` 已加入 `.gitignore`。如果需要发布示例数据，请另建脱敏 fixture，不要直接提交运行库。

当前 SQLite 表：

- `users`
- `jobs`
- `netdisk_accounts`
- `usage_records`
- `extra_doc_templates`

## 任务流程

```text
用户提交链接
  ↓
创建 SQLite 任务记录
  ↓
进入内存队列
  ↓
调度器检查全局并发、用户并发、磁盘空间
  ↓
按链接类型处理
  ├─ 直链：直接提交 ASR
  ├─ B 站：解析并下载音频
  ├─ 其他页面：yt-dlp 下载音频
  ├─ 百度网盘：BaiduPCS-Go 转存/真实路径定位/下载
  └─ 夸克网盘：读取分享、转存临时目录、获取下载 URL
  ↓
必要时用 ffmpeg 抽取音频
  ↓
生成临时公网 URL 或 OSS URL
  ↓
提交 ASR 并轮询结果
  ↓
生成“原文” Word
  ↓
按额外模板生成更多 Word
  ↓
可选：统一生成文件名
  ↓
记录用量并清理缓存
```

## 网盘说明

### 百度网盘

百度网盘能力依赖 `BaiduPCS-Go` 和用户 Cookies/BDUSS 登录态。`0.1.2` 支持扫码登录：服务器临时启动一个隔离浏览器会话，展示百度网盘登录二维码，扫码成功后读取 Cookie 并写入当前应用账号的 BaiduPCS-Go 配置。

处理策略：

1. 每个应用账号使用独立 BaiduPCS-Go 配置目录。
2. 分享链接先尝试转存并下载。
3. 如果遇到“文件重复/已存在”，会从当前账号搜索真实可下载路径。
4. 找到真实路径后直接下载。
5. 找不到时使用随机改名转存兜底。

扫码登录说明：

- 会话 180 秒超时，成功或取消后立即关闭临时浏览器。
- 服务器必须能找到 Chrome/Chromium；可通过 `CHROME_PATH` 或 `CHROMIUM_PATH` 指定路径。

注意：分享页路径不一定等于当前账号里的真实路径，不能直接信任分享路径。

### 夸克网盘

夸克网盘能力依赖用户从网页版复制 Cookies。

处理策略：

1. 每个应用账号独立保存夸克 Cookies。
2. 读取分享 token 和分享文件列表。
3. 自动选择第一个可处理音视频文件。
4. 转存到夸克临时目录。
5. 获取下载 URL 并下载到服务器任务目录。

当前只支持百度网盘和夸克网盘。其他网盘链接会明确提示不支持。

## 用量和成本

用量记录在 `usage_records`：

- ASR：按音频秒数记录。
- AI 处理：按 input/output/total tokens 记录。
- 成本：按 [server/src/config.js](server/src/config.js) 中的 `USAGE_PRICING` 估算。

前端展示规则：

- 只有 ASR：展示一个预估成本。
- ASR + AI：展示 `ASR ¥... + AI ¥...`。
- 模型价格缺失时，成本可能为 `¥0` 或显示未配置。

限制：直链如果不经过本地下载和 `ffprobe`，当前无法稳定得到音频时长，因此 ASR 成本可能低估。后续应从 ASR 回调结果或任务结果里补齐时长。

## 模块边界

### `server/src/index.js`

应用装配和任务编排入口：

- Express app 创建
- 静态文件挂载
- SQLite store 初始化
- 内存任务队列
- 并发调度
- 任务主流程
- 缓存清理
- 优雅退出

新功能不要继续堆进这里，优先拆到 `routes.js`、`store.js` 或 `services/`。

### `server/src/routes.js`

HTTP API 层：

- 登录注册
- 当前用户
- 任务创建、查询、删除
- 队列暂停/恢复
- 网盘登录和状态
- 模板 CRUD
- 用量统计
- 管理员接口
- 批量下载

路由只做参数校验、权限判断和调用服务，不写长业务流程。

### `server/src/store.js`

SQLite 数据层。所有持久化读写应走这里。

### `server/src/auth.js`

认证逻辑：

- 用户名规范化和校验
- 密码哈希和校验
- token 签发和校验
- Express 鉴权中间件

生产环境必须设置 `SESSION_SECRET`。

### `server/src/services/ai.js`

ASR 和 AI 处理：

- 提交 ASR
- 轮询 ASR
- 转写结果转纯文本
- 额外文件生成
- 智能标题生成

### `server/src/services/media.js`

媒体处理：

- ffmpeg 抽取音频
- ffprobe 获取时长
- 生成临时公网 URL
- 上传 OSS 并签名

### `server/src/services/usage.js`

用量和成本：

- 单条用量成本估算
- 任务用量汇总
- 前端可见用量记录格式化

### `server/src/services/word.js`

Word 生成和文件命名。

### `server/src/services/downloaders/`

下载器：

- `http.js`：公网 URL 下载
- `bilibili.js`：B 站音频解析下载
- `ytdlp.js`：通用页面下载
- `quark.js`：夸克分享解析、转存、下载

百度下载逻辑目前仍在 `index.js`，这是 0.1 之后最优先拆分的部分。

## 部署约定

当前服务器建议只跑本系统：

```bash
npm ci
npm run build
pm2 restart video-to-word --update-env
pm2 save
```

部署包排除：

- `node_modules`
- `data`
- `.git`
- `dist`

## 0.1 Review 结论

### 0.1.2 记录

- 模型配置改为账号级服务器配置。任务提交、任务重试和额外文件重试不再信任浏览器本地保存的模型、Base URL 或 API Key。
- 配置保存增加明确成功反馈，点击保存后显示“保存成功”和保存时间。
- 失败任务增加重试入口；额外文件失败时支持只重试失败部分，并在重试额外文件前清理本地视频/音频缓存。
- 用量价格表补充常用 ASR 和 AI 模型，支持阶梯 token 计价，并区分 ASR 成本和 AI 成本展示。
- 修正网页标题，去掉页签上的任务状态前缀。
- 百度扫码登录弹窗、状态反馈和二维码展示做了体验修正。

### 已在 0.1 收束中修复

- 任务结束后不再把完整模型密钥配置长期保存在 job payload 中；完成或失败时会保留模型名、接口地址等非密钥信息。
- 每日清理不再无条件删除 `downloads/` 和 `audio/` 全目录，避免把未过期失败任务缓存提前删掉。
- 用量预估已拆分为 ASR 成本和 AI 成本；只有 ASR 时仍展示一个成本。
- README 已更新为当前代码结构和 0.1 能力边界。

### 当前可接受风险

- SQLite 和内存队列只适合单机部署。
- 进程重启会把运行中任务标记为失败，queued 任务会恢复。
- 百度/夸克授权依赖 Cookie 或第三方命令，存在失效和风控风险。
- 百度扫码登录依赖服务器 Chrome/Chromium，低配机器上只适合低频使用。
- 用户 API Key 仍会在 queued/running 任务期间保存在 SQLite job payload 中，任务结束后才清理。
- 外部下载命令没有统一超时控制，异常网络下可能拖慢队列。
- 直链 ASR 的时长和成本统计可能不完整。
- 没有审计日志、企业组织、套餐额度和正式计费系统。

### 0.1.2 后优先级

1. 拆出 `services/downloaders/baidu.js`。
2. 拆出 `queue.js`，统一处理并发、磁盘水位、任务恢复。
3. 拆出 `services/jobs.js`，统一任务状态、失败、清理和文件生命周期。
4. 给下载命令和 fetch 下载增加统一超时/取消机制。
5. 将账号模型密钥改为加密存储，任务只引用配置快照或配置 ID。
6. 补直链 ASR 的时长回填。
7. 再做安全审查插件和企业权限模型。

## 验证命令

```bash
node --check server/src/index.js
node --check server/src/routes.js
node --check server/src/store.js
npm run build
```

`0.1.2` 的交付标准是这些命令通过，并且本地可以完成登录、保存模型配置、提交任务、查看任务、重试失败任务、下载 Word、查看用量；如本机安装了 Chrome/Chromium，还应能启动百度扫码登录会话。
