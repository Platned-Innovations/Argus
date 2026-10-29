# Dashboards, reports and the credential inventory

## Dashboard and trends

The dashboard shows a **Trends** section to everyone with the `reports:read` permission: Viewers, Developers, Security Managers and Administrators. Choose the last 30, 90 or 180 days.

| Figure | How it is calculated |
|---|---|
| Open critical & high | Open (unsuppressed) findings now. |
| Found / fixed | Findings first seen, and findings fixed (verified by a later scan), in the period. |
| Mean time to fix | Average days from first seen to fixed, for findings fixed in the period, per severity. |
| SLA compliance | Of the tickets resolved in the period, the share resolved by their due date; plus tickets overdue now. |
| Open findings over time | Daily count of open findings, reconstructed from when each was first seen and fixed. Suppressed findings are left out, because when a suppression was added is not recorded. |
| Found vs fixed per week | Weekly counts of new and fixed findings. |
| Riskiest repositories | Ranked by the sum of the risk scores of their open findings. |
| Expiring certificates and credentials | Certificates and tokens found in repositories, plus tracked credentials, expired or expiring within 180 days. |
| End-of-life frameworks | Runtimes and frameworks past (or close to) end of support, with the number of repositories using them. |

Charts have hover tooltips and a **Show data table** view. Their colours are checked for colour-blind safety and contrast in both light and dark mode.

Developers and Viewers see only their teams' repositories, as everywhere else in Argus.

## Reports

**Reports** in the navigation opens a printable security report: the same figures, for the organisation, one team, or one repository. Open a repository's report with **Report** on its page.
- **Print / save as PDF** uses the browser's print dialog. Navigation and controls are hidden in print.
- **Findings CSV** downloads every open and suppressed finding in scope: repository, severity, risk, scanner, rule, location, package and versions, advisory and CVEs, KEV and EPSS, dates and ticket key. Cells are protected against spreadsheet formula injection, and each export is audited (`report.findings_exported`).

**Monthly report by email.** A notification rule with the *Monthly security report* event sends a summary on the 1st of each month at 07:00 UTC. It is built from the same figures, for the last 30 days, scoped to the rule's teams:
- open critical and high findings
- found and fixed
- mean time to fix
- overdue tickets
- what is expiring
- end-of-life frameworks
- the three riskiest repositories

## Credential inventory

**Credentials** tracks the secrets your systems depend on that do not live in a repository: API keys, client secrets, certificates, passwords, access tokens and SSH keys. Argus records what each one is, which system it belongs to, who owns it, its team and when it expires. **It never stores the secret itself.**

- **Expiry notices.** A notification rule with the *Tracked credential expiring* event receives notices at 30, 14, 7 and 1 days before expiry and when a credential expires. Each notice is sent once per threshold. Recording a new expiry date (after rotating the credential) starts the notices again. Severity rises as expiry approaches: medium at 30 or 14 days, high within 7 days, critical once expired. Recipients listed on the credential are added when the rule includes repository recipients.
- **Microsoft Entra ID import.** Administrators can import every app registration's client secrets and certificates daily, or with **Sync now**.
  1. Register an application.
  2. Grant it the **Microsoft Graph → Application → Application.Read.All** permission, with admin consent.
  3. Create a client secret.
  4. Enter the tenant ID, client ID and secret under **Credentials → Microsoft Entra ID import**.

  Imported credentials keep their name, kind and expiry in sync with Entra; you can set the team, owner, notes and recipients. A secret removed in Entra is archived at the next sync. The client secret is stored encrypted and write-only. Paging links from Graph are followed only on the Graph host, so the access token is never sent elsewhere.
- **Visibility.** Credentials assigned to a team are visible to its members. Organisation-wide ones are visible only to Security Managers and Administrators, who also manage the inventory (`credentials:manage`).
- **Dashboard.** Tracked credentials also appear in the dashboard's expiry timeline.

## Data retention

Under **Administration → Scanning settings → Data retention**, choose how long to keep history. Retention runs daily, and what was removed is recorded in the audit log (`retention.applied`).

| Data | Default |
|---|---|
| Scan runs, with logs | 90 days |
| Fixed findings (trends and time-to-fix use them) | 365 days; empty keeps them forever |
| Audit log | forever (empty); check your compliance obligations before shortening it |
| Security news items that are no longer awaiting analysis or review | 365 days |
| AI usage records | 730 days |
