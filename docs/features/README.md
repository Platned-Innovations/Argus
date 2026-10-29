# Features

Status legend: ✅ available · 🔜 planned (phase shown)

## Platform & administration

| Feature | Status | Docs |
|---|---|---|
| Local user accounts, default system administrator on a new database | ✅ | [User management](user-management.md) |
| Roles (Administrator, Security Manager, Developer, Viewer) and teams | ✅ | [User management](user-management.md) |
| TOTP multi-factor authentication, recovery codes, org-wide enforcement | ✅ | [User management](user-management.md#multi-factor-authentication) |
| Password policy, account lockout, session management | ✅ | [Configuration](../configuration.md#in-app-security-settings) |
| Audit log with filtering and CSV export | ✅ | [User management](user-management.md#audit-log) |
| PostgreSQL or MongoDB storage | ✅ | [Architecture](../architecture.md#data-layer) |
| Single Docker image; Azure Web App support | ✅ | [Docker](../deployment/docker.md), [Azure](../deployment/azure.md) |
| Personal API tokens for CI/automation | 🔜 Phase 6 | |

## Sources & scanning

See [Sources, repositories and scans](sources-and-repositories.md).

| Feature | Status |
|---|---|
| GitHub (github.com and Enterprise Server) and Bitbucket (Cloud and Data Center) connections, verified before saving, with daily and on-demand repository sync | ✅ |
| List repositories in a source and activate them individually or in bulk; auto-activate new repos matching a pattern | ✅ |
| Per-repository scan schedule (hourly, daily, weekly or custom cron), manual "Scan now", scan-on-push webhooks (HMAC-verified) | ✅ |
| Repository settings: branch, business criticality, owning team, Jira project, notification recipients | ✅ |
| Team-scoped visibility of repositories and scans | ✅ |
| Scan runs: ephemeral shallow clone, commit, ecosystem and manifest inventory, log, history | ✅ |
| Per-repository choice of scanners | ✅ |
| `.argus.yml` repo-level configuration (ignore paths, scanner switches, suppressions) — see [Scanners and findings](scanners-and-findings.md#argusyml) | ✅ |
| **Secret detection** (Gitleaks, with built-in rules as a fallback) | ✅ |
| Live verification of detected secrets against provider APIs (opt-in) | 🔜 Phase 4 |
| **npm vulnerabilities, deprecations and latest versions** (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`) | ✅ |
| **NuGet vulnerabilities and latest versions** (`PackageReference`, central package management, `packages.lock.json`, `packages.config`) | ✅ |
| **Framework / runtime end-of-life** (.NET, .NET Framework, Node.js, Angular, React, Vue, Next.js, NestJS) | ✅ |
| **Certificate and credential expiry** (certificates, weak keys, key stores and expiring JWTs in repositories) | ✅ |
| License compliance policy (npm license data) | ✅ |
| NuGet license data | 🔜 Phase 6 |
| CycloneDX SBOM per repository; organisation-wide package search | ✅ |
| Credential inventory (manually tracked secrets, Entra ID app-registration secret expiry) | 🔜 Phase 6 |

## Risk & tickets

| Feature | Status |
|---|---|
| Findings with open, suppressed and fixed states, automatic fix detection and re-opening, and suppressions with justification and expiry — see [Scanners and findings](scanners-and-findings.md) | ✅ |
| 0–100 explainable risk score combining CVSS, EPSS, CISA KEV, dependency type, test paths, exposure and repository criticality; configurable weights | ✅ |
See [Tickets, email, Jira and notifications](tickets-and-notifications.md).

| Built-in tickets (one per issue) with statuses Open, Triaged, In progress, Resolved, Closed, Risk accepted, False positive and Reopened | ✅ |
| Automatic resolution when a later scan no longer finds the issue, and automatic re-opening if it returns | ✅ |
| SLA due dates by severity, overdue flagging, assignment, watchers, labels, comments, activity timeline, bulk actions, CSV export | ✅ |
| Risk acceptance and false positives backed by ticket-scoped, optionally expiring suppressions | ✅ |
| Email from a ticket via Microsoft Graph, Microsoft 365 SMTP (OAuth2 or password) or Google SMTP | ✅ |
| Create a Jira issue from a ticket (Jira Cloud or Data Center, in the project linked to the repository), with status sync | ✅ |
| Notification rules: email, Microsoft Teams (Adaptive Cards), Slack, signed webhooks; weekly digests | ✅ |

## AI

| Feature | Status |
|---|---|
| Choice of provider (Anthropic Claude, OpenAI, Google Gemini), configured by an administrator | 🔜 Phase 4 |
| AI triage of uncertain findings (likely false positives, dev-only usage) | 🔜 Phase 4 |
| AI remediation suggestions on tickets | 🔜 Phase 4 |
| Guardrails: secret redaction, minimal context, per-repository opt-out, budget caps; see [security](../security.md#7-ai-guardrails) | 🔜 Phase 4 |

## Threat intelligence

| Feature | Status |
|---|---|
| Advisory sources: OSV.dev (including the GitHub Advisory Database), CISA KEV, FIRST EPSS, endoflife.date, with database caching, stale fallback, configurable mirrors and offline mode | ✅ |
| NVD as an additional CVSS source (today CVSS comes from the GitHub/OSV advisory data) | 🔜 Phase 5 |
| Security news and advisory sites (RSS/HTML), with AI extraction into an admin review queue | 🔜 Phase 5 |
| Continuous re-matching of new advisories against every repository's stored dependency inventory, without re-scanning | 🔜 Phase 5 |

## Reporting

| Feature | Status |
|---|---|
| Organisation, team and repository dashboards (risk trend, MTTR, SLA compliance, expiring credentials, EOL exposure) | 🔜 Phase 6 |
| CSV and PDF reports, scheduled by email | 🔜 Phase 6 |
| Prometheus metrics, OpenAPI documentation | 🔜 Phase 6 |

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0. Foundation | Monorepo, PostgreSQL and MongoDB data layer, authentication with MFA, roles and teams, audit log, web UI shell, Docker, CI, documentation | ✅ |
| 1. Sources & scheduling | GitHub and Bitbucket connectors, repository activation, job queue, scheduler, scan runs, push webhooks | ✅ |
| 2. Scanners & risk | Advisory sources, all scanners, findings, risk scoring, SBOM, package search, suppressions | ✅ |
| 3. Tickets & integrations | Ticket lifecycle, SLAs, email providers, Jira, notification rules, digests | ✅ |
| 4. AI | Providers, triage, remediation, guardrails | 🔜 |
| 5. Threat intel | News crawler, AI extraction, review queue, continuous re-matching | 🔜 |
| 6. Enterprise polish | Dashboards, reports, credential inventory, API tokens, Azure Bicep | 🔜 |
