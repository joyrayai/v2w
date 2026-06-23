# Security Policy

## Supported Versions

Security fixes are accepted for the latest release on `main`.

## Reporting a Vulnerability

Please report security issues privately before opening a public issue.

Use GitHub Security Advisories if available for the repository, or contact the maintainer through the repository owner profile.

When reporting, include:

- Affected version or commit.
- Steps to reproduce.
- Impact and whether credentials, generated documents, or user data can be exposed.
- Relevant logs with secrets removed.

Do not include real API keys, cookies, BDUSS/STOKEN values, database files, generated documents, or private media links in public issues.

## Secret Handling

V2W is self-hosted and stores runtime state locally. Operators are responsible for protecting:

- `.env`
- `data/app.sqlite`
- `data/netdisk-users/`
- generated files under `outputs/`
- uploaded or downloaded media under `cache/downloads/` and `cache/audio/`

The repository `.gitignore` excludes these paths. Verify backups, logs, and deployment artifacts separately.

## Third-Party Integrations

Netdisk and video-page workflows depend on third-party services and local tools. Treat copied cookies and account tokens as credentials. Use only accounts and media that you are authorized to process.
