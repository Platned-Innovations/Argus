# Tickets, email, Jira and notifications

Argus turns findings into **tickets**, one per issue, and keeps them up to date from scan results. From a ticket you can assign work, comment, email it, or raise a Jira issue. Notification rules alert people and channels when something important happens.

## How tickets are created

After every scan, Argus groups the open findings by issue and opens a ticket for each new issue at or above the auto-create threshold (default: *low*). These findings share a ticket:

| Scanner | One ticket per |
|---|---|
| Vulnerable packages | Advisory + package (all manifests and versions together) |
| Secrets | Secret value (every file it appears in) |
| End-of-life frameworks | Product + release cycle (e.g. .NET 6) |
| Certificates | Certificate (or token) |
| Licenses | Package |

Each ticket gets:
- a key such as `ARG-42`
- the severity and risk score of its riskiest open finding
- the fix guidance
- a **due date** from the SLA for its severity

| Severity | Default SLA |
|---|---|
| Critical | 7 days |
| High | 30 days |
| Medium | 90 days |
| Low | 180 days |

You can change the SLAs and the threshold under **Administration → Integrations → Tickets and SLAs**.

## Lifecycle

| Status | Meaning |
|---|---|
| Open / Reopened | Needs attention. |
| Triaged | Acknowledged and prioritised. |
| In progress | Someone is working on it. |
| Resolved | Believed fixed. The next scan confirms it. |
| Closed | Done. |
| Risk accepted | Accepted, with a justification and an optional expiry. |
| False positive | Not a real issue. |

**What Argus does on its own:**
- **Fix detected.** When a scan no longer finds any of a ticket's findings, the ticket is set to **Resolved**, recorded in its activity as verified by scan.
- **Still present.** If a ticket was manually resolved or closed and the next scan still finds the issue, it is **Reopened**.
- **Suppressed.** When all remaining findings are suppressed, the ticket becomes **Risk accepted**.
- **Overdue.** Overdue tickets are flagged once, and can trigger an *SLA breached* notification.

**Risk acceptance and false positives.** Marking a ticket *Risk accepted* or *False positive* creates a **suppression for exactly that issue**, so the decision survives future scans. The suppression:
- is visible under **Suppressions**
- carries the justification
- expires on the date you set, if any; the ticket then reopens at the next scan

Reopening the ticket yourself removes the suppression.

**Severity changes.** When a ticket's severity rises (for example, the CVE is added to the CISA KEV list), its due date tightens to the stricter SLA.

## Who can do what

| Action | Viewer | Developer | Security Manager / Admin |
|---|---|---|---|
| See tickets for their teams' repositories | ✓ | ✓ | All repositories |
| Comment, watch | Watch only | ✓ | ✓ |
| Change status to Triaged, In progress, Resolved, Open | | ✓ | ✓ |
| Assign | | Themselves | Anyone who can see the ticket |
| Close, accept risk, mark false positive (and reopen those) | | | ✓ |
| Email a ticket, create a Jira issue | | ✓ | ✓ |
| Bulk changes, CSV export | Export | ✓ | ✓ |

Every change is recorded in the ticket's activity and in the audit log.

## Emailing a ticket

**Email** on a ticket sends its details, plus your note, through one of the configured email channels. The email is recorded on the ticket.

An administrator adds email channels under **Administration → Integrations → Channels**.

### Microsoft Graph (recommended for Microsoft 365)

1. In Entra ID, register an application.
2. Add the **Microsoft Graph → Application → Mail.Send** permission and grant admin consent.
3. Create a client secret.
4. Restrict the app to the sending mailbox with an [application access policy](https://learn.microsoft.com/graph/auth-limit-mailbox-access). Exchange Online PowerShell: `New-ApplicationAccessPolicy -AppId <client id> -PolicyScopeGroupId argus-sender@contoso.com -AccessRight RestrictAccess`.
5. In Argus, add a **Microsoft Graph** channel with the tenant ID, client ID, client secret and sending mailbox.

### Microsoft 365 SMTP

Use host `smtp.office365.com`, port **587**, STARTTLS.

- **OAuth2 (recommended):** grant the app the **Office 365 Exchange Online → SMTP.SendAsApp** permission and register its service principal in Exchange Online. Then choose *Microsoft OAuth2* and enter the mailbox, tenant, client ID and secret.
- **Username and password:** only where SMTP AUTH with basic authentication is still allowed. Microsoft is retiring it.

### Google Workspace / Gmail

Use host `smtp.gmail.com`, port **465**, TLS.

Sign in with the account and an **app password**: Google Account → Security → 2-Step Verification → App passwords.

### Encryption

Argus only sends email over TLS, either implicit TLS on port 465 or STARTTLS on 587, with TLS 1.2 or later. Plain-text SMTP is not offered.

### Testing

Use **Test** on a channel to send a test message.

## Jira

Under **Administration → Integrations → Jira**:

- **Jira Cloud:** site URL (`https://acme.atlassian.net`), the account email and an [API token](https://id.atlassian.com/manage-profile/security/api-tokens).
- **Jira Data Center / Server:** server URL and a personal access token.
- Default issue type (e.g. *Bug*) and an optional extra label.

Give the account permission to **create issues** in the projects you use. Set each repository's **Jira project key** in its monitoring settings. You can also override the project when creating the issue.

**Create Jira issue** on a ticket creates an issue that contains:
- the summary `[ARG-42] title`
- the details and fix guidance
- a link back to Argus
- the labels `argus` and your extra label

The Jira key and link are stored on the ticket.

**Status sync.** Argus checks linked issues every 15 minutes, or immediately with **Sync**. When the issue moves to a *Done* status, the ticket becomes **Resolved**, and the next scan verifies the fix.

## AI assistance on tickets

If an administrator has turned on AI assistance:

- **Suggest a fix** on a ticket asks the configured AI model for step-by-step remediation. The result shows:
  - the fixed version and the breaking-change risk
  - the reasoning and a confidence level
  - which model produced it

  **Regenerate** replaces the suggestion. **Add as comment** posts it to the ticket, labelled AI-assisted.
- **Draft with AI** in the **Create Jira issue** and **Email** dialogs fills in the summary and description, or the message, for you to edit before sending.

AI never changes a ticket's status. See [AI assistance](ai-assistance.md) for what is sent to the provider and how secrets are protected.

## Notification rules

A rule says **when** to notify, **what** qualifies and **where** to send it:

| Events | Filters | Channels |
|---|---|---|
| New ticket, ticket reopened, SLA breached, scan failed, weekly digest (Mondays 07:00 UTC) | Minimum severity (for ticket events), teams | Any email channel (to the listed recipients and, optionally, the repository's notification recipients), Microsoft Teams, Slack, signed webhook |

Notifications are queued and delivered in the background with retries, so a slow or failing channel never delays scans. Each channel shows when it was last used and its last error.

### Microsoft Teams

In the Teams channel, add a workflow from the template **"Post to a channel when a webhook request is received"**, then paste its URL into a *Microsoft Teams webhook* channel. Argus sends Adaptive Cards. (Classic Office 365 connectors are being retired by Microsoft.)

### Slack

Create an incoming webhook for the channel and paste its URL.

### Signed webhook

Argus POSTs JSON: `event`, `title`, `summary`, `severity`, `url`, `facts`, `sentAt`. It also sends these headers:

- `X-Argus-Event`
- `X-Argus-Timestamp` (Unix seconds)
- `X-Argus-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>" with the channel secret>`

Verify the signature and reject old timestamps. For example, in Node.js:

```js
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(`${req.headers['x-argus-timestamp']}.${rawBody}`).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-argus-signature']))
  && Math.abs(Date.now() / 1000 - Number(req.headers['x-argus-timestamp'])) < 300;
```

Set `ARGUS_PUBLIC_URL` so that notifications, emails and Jira issues link back to Argus.
