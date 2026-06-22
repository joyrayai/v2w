# V2W - Video to Word and OKF Export

[GitHub](https://github.com/joyrayai/v2w) · [Issues](https://github.com/joyrayai/v2w/issues)

V2W is a self-hosted workspace for turning videos, audio, and cloud-drive media into Word documents and OKF Markdown knowledge bundles. It supports batch transcription from public media URLs, video pages, Baidu Netdisk shares, and Quark Netdisk shares, then generates `.docx` outputs, reusable prompt-based documents, and optional OKF ZIP exports for enterprise knowledge reuse.

The project is designed for small teams that need stable media-to-document workflows on their own server, with account-based model settings, reusable prompt templates, usage tracking, retryable jobs, admin controls, and a native MCP endpoint for agent integrations such as OpenClaw.

V2W is an early open-source release. The core transcription and document-generation workflow is the default path. Enterprise review, OKF export, MCP integration, and netdisk automation are optional advanced capabilities that can be enabled only when your deployment needs them.

Current version: `0.3.0`

## Screenshot

![V2W web app](docs/screenshots/workspace.png)

## Core Workflow

1. Submit one or more direct media links, video page links, or supported netdisk share links.
2. Configure an ASR model and an OpenAI-compatible AI model for the current account.
3. Generate the original transcript Word file.
4. Optionally generate extra Word files from reusable prompts and per-document format requirements.
5. Download individual outputs or a batch ZIP.

## Features

- Batch submission from multiple links.
- Public HTTP/HTTPS media transcription.
- Bilibili and generic video-page parsing through `yt-dlp`.
- Baidu Netdisk share processing through `BaiduPCS-Go`.
- Baidu Netdisk QR-code login and manual credential authorization.
- Quark Netdisk share processing through user-provided cookies.
- Original transcript `.docx` output.
- Extra `.docx` files generated from reusable prompts.
- Optional OKF Markdown bundle output for knowledge assets under `knowledge/rules`, `knowledge/metrics`, and `knowledge/sop`.
- Per-extra-document output format instructions rendered into real Word styles.
- Built-in templates for `提炼版` and `思维导图`.
- Per-account model configuration and prompt templates.
- Retry failed jobs or only failed extra document generation.
- Batch download for generated files.
- Account login, admin user management, and usage records.
- Usage tracking for ASR duration, AI tokens, and estimated cost.
- Optional enterprise content review with administrator-managed rule packs, dedicated review model settings, high-risk download locks, and approval records.
- SQLite persistence for single-server deployments.
- Native HTTP MCP endpoint for agent workflows.

## Advanced Capabilities

These features are optional and are not required for ordinary video-to-Word usage:

- **OKF export**: generate Markdown knowledge bundles under `knowledge/rules`, `knowledge/metrics`, and `knowledge/sop`.
- **Enterprise review**: run post-generation document review with administrator-managed rule packs, a dedicated review model, high-risk download locks, and approval records.
- **MCP endpoint**: expose V2W workflows to compatible agents, including setup, account, job, usage, template, and netdisk tools.
- **Netdisk automation**: use Baidu Netdisk or Quark Netdisk credentials in a self-hosted deployment to process share links.

## Roadmap

V2W enters maintenance mode after the `0.3.0` OKF release. Future V2W updates will focus on performance, stability, and bug fixes for the current transcription, Word, OKF, MCP, netdisk, and admin workflows.

New knowledge-management capabilities will move to **V2K**, a platform-oriented successor for turning Word documents, videos, audio, and structured knowledge into OKF assets. V2K is planned to provide online knowledge storage, unified knowledge management, and basic question-answering over organized knowledge assets.

## Tech Stack

- Frontend: Vite + React
- Backend: Node.js + Express
- Database: SQLite with `better-sqlite3`
- Word generation: `docx`
- ZIP packaging: `archiver`
- Media tools: `ffmpeg`, `ffprobe`
- Video page downloader: `yt-dlp`
- Baidu Netdisk downloader: `BaiduPCS-Go`
- Default ASR provider: Alibaba Cloud Model Studio Paraformer
- Extra document generation: OpenAI-compatible Chat Completions API

## Requirements

- Node.js 20+
- npm
- `ffmpeg` and `ffprobe`
- `yt-dlp`
- `BaiduPCS-Go` for Baidu Netdisk links
- Chrome or Chromium for Baidu QR-code login

Public direct links can work without `BaiduPCS-Go`. Netdisk links require the corresponding netdisk authorization.

## Platform and Content Responsibility

V2W does not grant access rights to third-party content. You are responsible for ensuring that you have permission to access, download, transcribe, process, and store any media submitted to the system.

Netdisk, video-page, and download integrations depend on third-party services and tools such as Baidu Netdisk, Quark Netdisk, Bilibili, `yt-dlp`, and `BaiduPCS-Go`. Their availability may change, and your use of those integrations should comply with the relevant platform terms, local law, and your organization’s data policies.

Never submit credentials, cookies, API keys, confidential recordings, or regulated personal data to a deployment you do not control.

## Quick Start

```bash
git clone https://github.com/joyrayai/v2w.git
cd v2w
npm run setup
npm run dev
```

Open the web app and create the first administrator account when prompted. After initialization, log in and configure your model provider before submitting tasks.

Default local URLs:

- Web: `http://localhost:5173`
- API: `http://localhost:5174`

If you want the setup script to try installing system tools:

```bash
npm run setup -- --install-system
```

To only check the environment:

```bash
npm run doctor
```

## Agent / OpenClaw Quick Test

After starting the API server, the MCP endpoint is available at:

```text
http://localhost:5174/mcp
```

For OpenClaw running in Docker on the same machine, register V2W with:

```bash
openclaw mcp add v2w-local \
  --transport streamable-http \
  --url http://host.docker.internal:5174/mcp
```

Then verify tool discovery:

```bash
openclaw mcp probe v2w-local --json
```

V2W should expose `33` MCP tools in version `0.3.0`.

## Manual Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Build for production:

```bash
npm run build
npm start
```

## Configuration

Copy `.env.example` to `.env` before running the app.

```bash
cp .env.example .env
```

Common environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `5174` | Backend server port |
| `PUBLIC_BASE_URL` | `http://localhost:5174` | Public base URL used for temporary media URLs |
| `SESSION_SECRET` | development fallback | Secret for signed login tokens |
| `MAX_CONCURRENCY` | `5` | Global running task limit |
| `MAX_USER_RUNNING` | `2` | Running task limit per user |
| `MAX_USER_QUEUED` | `50` | Queued task limit per user |
| `MIN_FREE_DISK_GB` | `6` | Stop starting new tasks when free disk is below this value |
| `CHROME_PATH` | empty | Optional Chrome path for QR-code login |
| `CHROMIUM_PATH` | empty | Optional Chromium path for QR-code login |
| `REVIEW_CONTEXT_LIMIT_TOKENS` | `1000000` | Context budget for optional enterprise document review |

Do not commit real `.env` files, API keys, cookies, SQLite databases, or generated documents.

## Model Settings

Model API keys and model names are configured in the web app after login.

The default provider preset uses Alibaba Cloud Model Studio:

- ASR model: `paraformer-v2`
- AI model: configurable OpenAI-compatible chat model

Other OpenAI-compatible providers can be used for extra document generation by setting the base URL, API key, and model name in the model configuration page.

## Output Format Requirements

Each extra document can optionally include its own output format requirement. When enabled, V2W asks the AI model to return a structured JSON document with style definitions and content blocks, then renders that structure into a `.docx` file.

This is more reliable than asking the model to “look like” a Word document in plain text, because V2W writes the resulting font, size, bold, alignment, line spacing, and first-line indentation into the Word file itself.

Example requirements:

```text
一级标题：宋体、二号、加粗、居中
二级标题：黑体、三号、不加粗
正文：仿宋、三号、不加粗
行间距：固定值 28 磅
首行缩进 2 字符，两端对齐
```

## Enterprise Review

V2W includes an optional enterprise review workflow for teams that need post-generation compliance checks.

This capability is disabled by default and enabled per account by an administrator. Standard users who only need transcription and prompt-based Word generation do not need to configure or interact with it. When enabled, completed jobs are reviewed against the active rule pack after the transcript and extra Word files are generated.

Enterprise review includes:

- Markdown rule-pack import and versioning.
- Separate administrator-managed OpenAI-compatible review model configuration.
- Automatic review of the generated transcript and extra documents.
- Large-context handling that batches files or slices oversized files with result aggregation.
- High-risk job download locking until an administrator records an approval reason.
- Retryable review runs without regenerating the original documents.

Review text is stored separately from the job payload in SQLite, so normal job loading remains lightweight even when many generated documents are reviewed.

## Netdisk Authorization

### Baidu Netdisk

Baidu Netdisk support depends on `BaiduPCS-Go`.

You can authorize Baidu Netdisk in the web app by:

- QR-code login, if Chrome or Chromium is available on the server.
- Manual credential login, by providing cookies or BDUSS/STOKEN values.

Each app account keeps an independent netdisk authorization state.

### Quark Netdisk

Quark Netdisk support uses cookies copied from a logged-in Quark web session. Paste the cookies in the netdisk authorization card before submitting Quark share links.

## MCP Integration

V2W exposes a native MCP-compatible HTTP endpoint after deployment:

```text
POST /mcp
```

For a local development server:

```text
http://localhost:5174/mcp
```

Implemented MCP methods:

- `initialize`
- `tools/list`
- `tools/call`

Available tools:

| Tool | Description |
| --- | --- |
| `v2w.setup.status` | Check initialization state and local tool availability |
| `v2w.setup.create_admin` | Create the first administrator account before any account exists |
| `v2w.account.register` | Create a password account and return an `authToken` |
| `v2w.service_info` | Read service status, runtime limits and queue status |
| `v2w.mcp.capabilities` | Read grouped MCP capabilities for agent planning |
| `v2w.mcp.self_check` | Run an authenticated MCP integration self-check |
| `v2w.login` | Log in with a V2W account and return an `authToken` |
| `v2w.config.get` | Read the current account model configuration with secrets redacted |
| `v2w.config.save` | Save model and optional OSS configuration for the account |
| `v2w.config.test` | Test saved or supplied OpenAI-compatible model configuration |
| `v2w.usage.pricing` | Read the local ASR and AI pricing table used for estimates |
| `v2w.usage.summary` | Read current-account usage summary |
| `v2w.usage.records` | List current-account usage records |
| `v2w.admin.users` | Admin only: list users with job counts and usage summary |
| `v2w.admin.usage.summary` | Admin only: read global usage summary |
| `v2w.admin.usage.records` | Admin only: list global usage records |
| `v2w.netdisk.status` | Read Baidu or Quark authorization status |
| `v2w.netdisk.login` | Authorize Baidu or Quark with copied browser cookies; Baidu also supports BDUSS |
| `v2w.baidu_qr.start` | Start Baidu Netdisk QR authorization |
| `v2w.baidu_qr.status` | Poll Baidu Netdisk QR authorization status |
| `v2w.baidu_qr.cancel` | Cancel a Baidu Netdisk QR authorization session |
| `v2w.templates.list` | List extra document templates, including default templates |
| `v2w.templates.get` | Read one extra document template |
| `v2w.templates.create` | Create an extra document template |
| `v2w.templates.update` | Update an extra document template |
| `v2w.templates.delete` | Delete an extra document template |
| `v2w.jobs.submit` | Submit direct, page, Baidu Netdisk or Quark Netdisk links as jobs; optionally generate OKF bundles |
| `v2w.jobs.list` | List jobs for the current account |
| `v2w.jobs.get` | Read one job and its current progress |
| `v2w.jobs.retry` | Retry a failed job, or retry only failed extra documents when possible |
| `v2w.jobs.retry_extra` | Retry only failed extra documents from cached transcript text |
| `v2w.jobs.delete` | Delete a non-running job and its files |
| `v2w.jobs.downloads` | Return generated document download URLs and a batch ZIP URL |

Authentication flow:

1. Call `v2w.setup.status` after deployment.
2. Call `v2w.mcp.capabilities` if the agent needs a grouped capability map.
3. If `needsAdmin` is `true`, call `v2w.setup.create_admin`.
4. Otherwise call `v2w.login` with `username` and `password`, or create a user with `v2w.account.register`.
5. Pass the returned `authToken` in later tool arguments.
6. Call `v2w.mcp.self_check` to verify account model configuration, netdisk authorization and job state.
7. Alternatively, pass the token as `Authorization: Bearer <token>`.

Example JSON-RPC call:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "v2w.login",
    "arguments": {
      "username": "admin",
      "password": "your-password"
    }
  }
}
```

Baidu QR authorization returns `qrImageDataUrl` when the QR image is ready. Agents can render that data URL directly for users to scan with the Baidu Netdisk app. `qrImageUrl` is also returned for clients that can call the protected V2W HTTP API with authentication.

Task workflow over MCP:

1. Call `v2w.login`.
2. Call `v2w.config.get`; if no config exists, call `v2w.config.save`.
3. Call `v2w.config.test` to verify the AI processing model before submitting work.
4. For Baidu Netdisk links, call `v2w.netdisk.status`; if needed, use `v2w.baidu_qr.start` and poll `v2w.baidu_qr.status`. Use `v2w.baidu_qr.cancel` if the user abandons the QR login.
5. Call `v2w.jobs.submit` with `links`, optional `extraPrompts`, and optional OKF fields.
6. Poll `v2w.jobs.list` or `v2w.jobs.get`.
7. Call `v2w.jobs.downloads` after completion.

`v2w.jobs.submit` always uses the model configuration saved on the V2W account. Agents may pass runtime-only options such as `concurrency`, `directUrlMode`, `publicBaseUrl`, `okfEnabled`, or `okfOptions`, but should not pass model secrets in job calls.

OKF bundle workflow:

- Pass `okfEnabled: true` to generate a Markdown ZIP bundle alongside Word outputs.
- Optionally pass `okfOptions` with `owner`, `version`, and `tags`.
- The generated ZIP contains `manifest.json` and Markdown files under `knowledge/rules`, `knowledge/metrics`, and `knowledge/sop`.

Template workflow:

- Call `v2w.templates.list` to ensure the built-in `提炼版` and `思维导图` templates exist for the account.
- Call `v2w.templates.create` or `v2w.templates.update` when an agent needs to save reusable prompts for extra Word files.
- Pass selected template titles and prompts as `extraPrompts` when calling `v2w.jobs.submit`.

Usage and admin workflow:

- Call `v2w.usage.summary` after job completion to report ASR seconds, AI tokens, and estimated cost for the current account.
- Call `v2w.usage.records` when an agent needs itemized records for a report.
- Call `v2w.usage.pricing` to explain how local cost estimates are calculated.
- Admin accounts can call `v2w.admin.users`, `v2w.admin.usage.summary`, and `v2w.admin.usage.records` for organization-level reporting.
- Enterprise review is managed through the web admin API and UI. It is intentionally outside the default MCP workflow so standard users and general-purpose agents are not exposed to compliance controls unless an administrator enables them.

Manual netdisk authorization:

- Baidu: call `v2w.netdisk.login` with `{ "provider": "baidu", "mode": "cookies", "cookies": "BDUSS=...; STOKEN=..." }`, or with `{ "provider": "baidu", "mode": "bduss", "bduss": "...", "stoken": "..." }`.
- Quark: call `v2w.netdisk.login` with `{ "provider": "quark", "mode": "cookies", "cookies": "__pus=...; __puus=..." }`.

MCP responses redact known credential fields from command output. Clients should still avoid logging raw cookies or tokens.

## Runtime Data

Runtime files are stored under `data/`:

```text
data/
├── app.sqlite
├── downloads/
├── audio/
├── outputs/
└── netdisk-users/
```

`data/` is ignored by Git. Back it up separately if you need to preserve users, tasks, templates, usage records, or generated documents.

## Supported Link Types

- Public direct media links, such as `.mp4`, `.mov`, `.m4a`, `.mp3`.
- Bilibili video page links.
- Other video pages supported by `yt-dlp`.
- Baidu Netdisk share links.
- Quark Netdisk share links.

Unsupported netdisk providers will be rejected with a clear error message.

## Usage Notes

- The app is built for single-server deployment.
- Running tasks are processed by the Node.js process and stored in SQLite.
- If the process restarts, queued tasks can continue, while interrupted running tasks may need retry.
- Large files require enough local disk space for temporary download and audio extraction.
- Netdisk cookies can expire and may need re-authorization.
- Estimated cost is calculated from local pricing config and may differ from the final provider bill.

## Third-Party Marks

This repository may show names or logos for supported providers and tools, including GitHub, Alibaba Cloud, DeepSeek, SiliconFlow, Baidu Netdisk, Quark Netdisk, Bilibili, and other services. Those names and marks belong to their respective owners. Their appearance only indicates interoperability or configuration presets, not endorsement or affiliation.

## Useful Commands

```bash
npm run dev       # Start frontend and backend in development mode
npm run build     # Build frontend
npm start         # Start backend in production mode
npm run setup     # Install dependencies and prepare local environment
npm run doctor    # Check environment
```

## License

GPL-3.0-only
