# Security model

Argus holds some of the most sensitive data in an engineering organisation: source-control tokens, findings about leaked secrets, and the vulnerability map of every repository. This page describes how Argus protects that data.

Each control is labelled:

- **✅ Implemented**: built and covered by automated tests.
- **🔜 Phase *N***: a design commitment for a feature that is not built yet. It becomes ✅ when that phase ships.

If you find a vulnerability, please report it privately to the maintainers rather than opening a public issue.

---

## 1. Secrets and credentials at rest

| Control | Status |
|---|---|
| **One master key.** Everything sensitive is protected by keys derived from `ARGUS_MASTER_KEY` (at least 32 characters). HKDF-SHA256 derives a separate sub-key for each purpose (encryption, token signing, keyed hashing), so no key is reused across algorithms. | ✅ |
| **Authenticated encryption.** Stored secrets are encrypted with AES-256-GCM, using a fresh random 96-bit IV per value and a versioned envelope (`v1.iv.tag.ciphertext`). Any tampering is detected on decryption. Today this covers TOTP secrets, source-control tokens and webhook secrets. | ✅ |
| GitHub and Bitbucket access tokens and per-source webhook secrets are stored with this encryption. | ✅ |
| SMTP and Microsoft Graph secrets, Jira tokens and AI provider keys are stored with the same encryption. | 🔜 Phases 3 and 4 |
| **Write-only credentials.** The API never returns a stored credential; for source tokens it shows only the last four characters (`••••abcd`). Changing a token or connection setting re-tests the connection before saving. A webhook secret is shown once, when it is created or rotated. | ✅ |
| **Detected secrets are never stored in full.** A leaked secret found in a repository is kept only as a masked preview (for example `AKIA…MPLE`; private keys show only "PEM private key") plus an HMAC-SHA256 hash, keyed by this installation, which is used to recognise the same secret across files and scans. Gitleaks' raw report is deleted as soon as it has been read. Argus never becomes a second copy of your leaked secrets. | ✅ |
| Passwords are hashed with **argon2id** (19 MiB memory, 2 iterations; the OWASP recommendation). They are never stored reversibly or logged. | ✅ |
| Refresh tokens and MFA recovery codes are stored only as keyed HMAC-SHA256 hashes. | ✅ |

> **Protect and back up `ARGUS_MASTER_KEY`.** Without it, encrypted credentials and MFA enrollments cannot be recovered. Store it in a secret manager (for example as an Azure Key Vault reference), never in source control.

## 2. Authentication

| Control | Status |
|---|---|
| Local accounts with a configurable **password policy** (default: at least 12 characters, 3 of 4 character classes, must not contain the username). The same policy code runs in the browser for live feedback and on the server for enforcement. | ✅ |
| **Default administrator.** On a fresh database, Argus creates `admin` with a password from `ARGUS_ADMIN_PASSWORD`, or generates a strong one and logs it **once**. The password **must be changed at first sign-in**. | ✅ |
| **Every admin-set password is temporary.** Users created or reset by an administrator must choose their own password before they can do anything else. | ✅ |
| **Account lockout** after N consecutive failures (default: 5 failures, 15 minutes). Failed MFA codes and failed "current password" checks count too. Administrators can unlock accounts. | ✅ |
| **Username enumeration resistance.** Unknown and disabled accounts get the same error, and an argon2 verification still runs against a dummy hash so response times match. | ✅ |
| **TOTP multi-factor authentication** (RFC 6238; works with Microsoft Authenticator, Google Authenticator, 1Password and others). | ✅ |
| **TOTP replay protection.** A code that has already been accepted cannot be used again, even within its 30-second window. | ✅ |
| **Recovery codes:** 10 single-use codes, shown once and stored as keyed hashes. | ✅ |
| **Organisation-wide MFA enforcement.** When enabled, users without MFA must enroll before doing anything else, and they cannot turn MFA off. | ✅ |
| Per-IP **rate limiting** on credential endpoints (`ARGUS_AUTH_RATE_LIMIT`, default 10 per minute). | ✅ |
| Personal API tokens (scoped and expiring) for CI and automation. | 🔜 Phase 6 |

## 3. Sessions

| Control | Status |
|---|---|
| **Short-lived access tokens** (HS256 JWT, default 15 minutes) in an **HttpOnly, SameSite=Strict** cookie. JavaScript cannot read them. | ✅ |
| **Rotating refresh tokens** (opaque, 256-bit) in an HttpOnly cookie scoped to `/api/v1/auth`. Each use issues a new token and revokes the old one. | ✅ |
| **Refresh-token reuse detection.** Presenting an already-rotated refresh token revokes the whole session family and is audited as possible token theft. | ✅ |
| **CSRF protection.** On top of SameSite=Strict cookies, every state-changing request that carries a session must echo a double-submit token in the `X-CSRF-Token` header. | ✅ |
| **Immediate revocation:**<br>• Disabling a user, resetting their password or resetting their MFA signs out all of their sessions at once.<br>• Access tokens issued before a password change stop working.<br>• Role changes take effect on the next request, because the user is reloaded on every request. | ✅ |
| `Secure` cookies and HSTS are enabled automatically when `ARGUS_PUBLIC_URL` uses `https://`. | ✅ |

## 4. Authorisation

| Control | Status |
|---|---|
| **Role-based access control** with four roles: Administrator, Security Manager, Developer and Viewer. Each endpoint declares the permissions it needs, and the server checks them on every request. The UI hides what you cannot do, but the server is the authority. | ✅ |
| **Team scoping.** Developers and Viewers only see repositories, scan runs, findings, dependency inventories, package-search results and suppressions owned by their teams. Anything outside their teams returns *404 Not found* rather than *403*, so its existence is not revealed. When a repository moves to another team, its findings, inventory and scan history move with it. Tickets follow the same rule from Phase 3. | ✅ |
| **Suppressing findings needs triage rights** (Administrator or Security Manager). Every suppression carries a justification and an optional expiry, and is audited. | ✅ |
| **Self-lockout and last-admin protection.** Administrators cannot disable themselves or change their own role, and the last active administrator cannot be removed. | ✅ |

## 5. Audit trail

| Control | Status |
|---|---|
| Append-only **audit log** of security-relevant events: sign-ins (success and failure, with reason), lockouts, password changes and resets, MFA changes, user and team changes, settings changes, audit exports, and refresh-token reuse. | ✅ |
| Each entry records the actor, target, outcome, source IP and structured details. **Secrets are never written to the audit log.** | ✅ |
| CSV export is protected against spreadsheet formula injection (cells beginning with `=`, `+`, `-` or `@` are neutralised). | ✅ |
| Source changes are audited: creation, edits (including token rotation), deletion, webhook-secret rotation, sync requests and sync results. So are repository setting changes, bulk changes, and manual scan requests. | ✅ |
| Suppression creation and removal, SBOM exports and scanning-settings changes are audited, with before and after values for settings. | ✅ |
| Ticket, integration and AI actions are audited as those features arrive. | 🔜 Phases 3–4 |

## 6. Source-code handling

| Control | Status |
|---|---|
| Repositories are **shallow-cloned into an ephemeral directory** (`ARGUS_SCAN_WORKDIR/<run id>`) for the duration of a scan and **always deleted afterwards**, including when the scan fails. Source code is never stored in the database. | ✅ |
| **Tokens never appear in URLs or command lines.** Git receives the credential as an HTTP header through its environment (`GIT_CONFIG_*`), so it cannot leak through process listings, git error messages or a stored remote URL. | ✅ |
| **Clone-host allowlist.** Before any credential is attached, a clone URL must use HTTPS and point to the source's own host (for example github.com, bitbucket.org, or your server). A tampered or unexpected clone URL is refused. | ✅ |
| **API calls are pinned to the configured server.** Pagination links returned by a provider are followed only if they stay on the same origin, so a token is never sent to another host. Redirects are not followed. | ✅ |
| **Hardened git.** Git runs with: <br>• no user or system git configuration<br>• no interactive prompts<br>• HTTPS/HTTP transports only<br>• symbolic links checked out as plain files<br>• Git LFS downloads disabled<br>• no submodules or tags<br>• a timeout (`ARGUS_SCAN_TIMEOUT_MINUTES`)<br>Repository hooks are never executed. | ✅ |
| **Redacted scan logs.** Scan logs and error messages are scrubbed of the token, the authorisation header and any `user:password@` URL credentials before they are stored or shown. | ✅ |
| Source servers must use **HTTPS**. Plain HTTP is accepted only for loopback addresses (local development). | ✅ |
| Only findings and the dependency inventory (package names, versions and licenses, for SBOMs and package search) are persisted. File contents are not stored; a finding records only its path and line. | ✅ |
| **Untrusted repository content is parsed defensively.**<br>• XML (`.csproj`, `packages.config`) is parsed without DTDs or external entities.<br>• YAML (`pnpm-lock.yaml`, `yarn.lock`, `.argus.yml`) is parsed with alias-expansion limits.<br>• Files are read with size caps, and binary files are skipped.<br>• Symbolic links are never followed.<br>• Nothing from a repository is ever executed. | ✅ |
| **Threat-intelligence lookups never send code or secrets.** OSV and the npm/NuGet registries receive package names and versions, EPSS receives CVE ids, and endoflife.date receives product names. The full list is in [Data sources](features/scanners-and-findings.md#data-sources-caching-and-offline-mode). `ARGUS_OFFLINE=true` turns all of these lookups off, and each URL can point at an internal mirror. | ✅ |
| The bundled **Gitleaks binary is pinned to a version and verified against its published SHA-256 checksum** when the image is built. | ✅ |
| **Read-only tokens are enough.** The [sources guide](features/sources-and-repositories.md#access-tokens) lists the minimum permissions for each provider. | ✅ |

## 7. AI guardrails

AI features are optional and switched off until an administrator configures a provider (Anthropic Claude, OpenAI or Google Gemini).

| Control | Status |
|---|---|
| **Secrets are always redacted before any prompt is sent.** Detected secret values, and anything matching Argus's secret patterns in surrounding code, are replaced with placeholders before text leaves Argus. | 🔜 Phase 4 |
| **Minimal context.** The code sent to a model is capped in size and limited to the lines around a finding. Administrators can exclude specific repositories from AI processing entirely. | 🔜 Phase 4 |
| **Per-use-case switches** (secret triage, remediation advice, advisory extraction and others), with token usage and cost tracked against a monthly budget cap. | 🔜 Phase 4 |
| **Humans decide.** AI output is always labelled as AI-assisted and shows its reasoning. AI can suggest a likely false positive or a fix, but it **never closes or suppresses a ticket on its own**. | 🔜 Phase 4 |
| Model responses must match a strict JSON schema; anything else is rejected. | 🔜 Phase 4 |
| Every AI request is audited (use case, provider, model and token counts; prompt contents are not logged). | 🔜 Phase 4 |

## 8. Platform hardening

| Control | Status |
|---|---|
| **Strict Content Security Policy** (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`), plus `X-Content-Type-Options`, a Referrer-Policy and the other Helmet defaults. | ✅ |
| Request bodies are limited to 1 MB (25 MB for signed push webhooks, which can be large) and validated against schemas. Unknown fields are stripped. | ✅ |
| **Structured logs never contain credentials.** Cookies, `Authorization` headers, CSRF tokens and `Set-Cookie` headers are redacted. Request bodies are not logged. | ✅ |
| Configuration is validated at startup, and a misconfigured instance refuses to start. | ✅ |
| The container runs as a **non-root user**, with `tini` as PID 1 and a health check. | ✅ |
| **Dependency hygiene.** CI fails on high or critical `npm audit` findings in production dependencies, and the image is scanned with Trivy. | ✅ |
| **Inbound push webhooks are authenticated** with an HMAC-SHA256 signature (`X-Hub-Signature-256` / `X-Hub-Signature`) over the raw request body, using a per-source random secret. Signatures are compared in constant time, and unsigned or mis-signed calls are rejected with 401. | ✅ |
| Source-connection tests have their own rate limit (20/min), so Argus cannot be used to amplify requests to third-party APIs. | ✅ |
| Outbound webhooks are HMAC-signed. | 🔜 Phase 3 |

## 9. Operator checklist

1. Generate a strong `ARGUS_MASTER_KEY` (`openssl rand -base64 48`), keep it in a secret store, and back it up.
2. Serve Argus over HTTPS and set `ARGUS_PUBLIC_URL=https://…`.
3. Sign in as `admin` immediately and set a new password. Then enable MFA and consider **Require MFA for all users**.
4. Create named administrator accounts for real people, and use `admin` only for break-glass access.
5. Restrict database network access to the Argus containers only, and enable encryption at rest on the database.
6. Review the audit log regularly, or export it to your SIEM.
