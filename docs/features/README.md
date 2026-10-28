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

| Feature | Status |
|---|---|
| GitHub (cloud and Enterprise Server) and Bitbucket (Cloud and Data Center) connections | 🔜 Phase 1 |
| List repositories in a source and activate them individually or in bulk; auto-activate new repos matching a pattern | 🔜 Phase 1 |
| Per-repository scan schedule (hourly, daily, weekly or custom cron), manual "Scan now", scan-on-push webhooks | 🔜 Phase 1 |
| Repository settings: branches, scanners, business criticality, owning team, Jira project, notification recipients | 🔜 Phase 1 |
| `.argus.yml` repo-level configuration (ignore paths, suppressions) | 🔜 Phase 2 |
| **Secret detection** (Gitleaks plus custom rules), with optional live verification for well-known providers | 🔜 Phase 2 |
| **npm vulnerabilities and outdated packages** (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`) | 🔜 Phase 2 |
| **NuGet vulnerabilities and outdated packages** (`PackageReference`, central package management, `packages.lock.json`, `packages.config`) | 🔜 Phase 2 |
| **Framework / runtime end-of-life** (.NET, Node.js, Angular, React and others, via endoflife.date) | 🔜 Phase 2 |
| **Certificate and credential expiry** (certificates and JWTs in repositories) | 🔜 Phase 2 |
| License compliance policy | 🔜 Phase 2 |
| CycloneDX SBOM per repository; organisation-wide package search | 🔜 Phase 2 |
| Credential inventory (manually tracked secrets, Entra ID app-registration secret expiry) | 🔜 Phase 6 |

## Risk & tickets

| Feature | Status |
|---|---|
| 0–100 risk score combining CVSS, EPSS, CISA KEV, fix availability, dependency type, exposure and repository criticality; configurable weights | 🔜 Phase 2 |
| Built-in tickets with statuses Open, Triaged, In progress, Resolved, Closed, Risk accepted, False positive and Reopened | 🔜 Phase 3 |
| Automatic resolution when a later scan no longer finds the issue, and automatic re-opening if it returns | 🔜 Phase 3 |
| SLA due dates by severity, assignment, comments, bulk actions, suppression rules | 🔜 Phase 3 |
| Email from a ticket via Microsoft Graph, Microsoft 365 SMTP or Google SMTP | 🔜 Phase 3 |
| Create a Jira issue from a ticket (in the Jira project linked to the repository), with status sync | 🔜 Phase 3 |
| Notification rules: email, Microsoft Teams, Slack, signed webhooks; weekly digests | 🔜 Phase 3 |

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
| Advisory feeds: OSV.dev, GitHub Advisory Database, NVD, CISA KEV, FIRST EPSS, endoflife.date | 🔜 Phase 2 (core feeds) |
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
| 1. Sources & scheduling | GitHub and Bitbucket connectors, repository activation, job queue, scheduler, scan runs | 🔜 |
| 2. Scanners & risk | Advisory database, all scanners, findings, risk scoring, SBOM, suppressions | 🔜 |
| 3. Tickets & integrations | Ticket lifecycle, email providers, Jira, notification rules | 🔜 |
| 4. AI | Providers, triage, remediation, guardrails | 🔜 |
| 5. Threat intel | News crawler, AI extraction, review queue, continuous re-matching | 🔜 |
| 6. Enterprise polish | Dashboards, reports, credential inventory, API tokens, Azure Bicep | 🔜 |
