# Contributing to V2W

Thanks for improving V2W. This project is currently focused on self-hosted media-to-document workflows, Word generation, OKF export, MCP integration, and optional enterprise review.

## Development Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Useful checks:

```bash
npm run doctor
npm run build
```

`ffmpeg`, `ffprobe`, `yt-dlp`, `BaiduPCS-Go`, and Chrome/Chromium are optional local tools. Missing tools may disable specific workflows but should not block general frontend/backend development.

## Pull Request Guidelines

- Keep changes focused and avoid unrelated UI or formatting churn.
- Do not commit `.env`, SQLite databases, generated documents, cookies, API keys, or files under `data/`, `dist/`, or `node_modules/`.
- For backend changes, run the relevant `node --check` command and `npm run build`.
- For UI changes, include a screenshot or short description of the affected screen.
- For provider integrations, document any external tool or platform dependency.

## Issue Guidelines

When reporting a bug, include:

- V2W version and commit hash if available.
- Operating system and Node.js version.
- Whether the task uses direct links, video pages, Baidu Netdisk, Quark Netdisk, OKF export, MCP, or enterprise review.
- Redacted logs. Remove API keys, cookies, tokens, private URLs, and personal data.

## Scope

V2W is in maintenance-oriented development after the `0.3.0` OKF release. Performance, stability, packaging, bug fixes, and documentation are the preferred contribution areas. Larger knowledge-management platform features should be proposed separately before implementation.
