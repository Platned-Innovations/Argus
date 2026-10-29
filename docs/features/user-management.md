# User management

Argus uses local accounts. Administrators manage them under **Administration → Users** and **Administration → Teams**.

## The default administrator

When Argus starts against an empty database, it creates one account:

- **Username:** `admin`
- **Password:**
  - the value of `ARGUS_ADMIN_PASSWORD`, or
  - if that is unset, a strong random password written **once** to the log, on a line beginning `DEFAULT ADMIN CREATED`

You must change this password at first sign-in; nothing else is accessible until you do. After that:

1. create named administrator accounts for real people
2. turn on MFA
3. keep `admin` for break-glass access

## Roles

| Role | Can |
|---|---|
| **Administrator** | Everything: users, teams, security settings, sources, integrations, AI configuration, and all repositories and tickets. |
| **Security Manager** | Manage repositories, findings, tickets and threat intel across all teams; read users, teams, settings and the audit log. Cannot manage users or change system settings. |
| **Developer** | Run scans, work tickets and use AI remediation for their teams' repositories. |
| **Viewer** | Read-only access to their teams' repositories, findings and tickets. |

Role changes take effect on the user's next request; no sign-out is needed. The server enforces every permission, and the UI simply hides actions you cannot perform.

**Safeguards:**

- Administrators cannot change their own role or disable themselves.
- The last active administrator cannot be demoted or disabled.

## Teams

Teams represent ownership: for example *Payments*, *Mobile* or *Platform*. A user can belong to several teams.

From Phase 1, every repository has an owning team. Developers and Viewers see only their teams' repositories, findings and tickets, while Administrators and Security Managers see everything.

Deleting a team removes it from its members. Their accounts are not affected.

## Creating users

**Users → New user** asks for:

- username, display name and optional email
- role
- teams

You can set an initial password, or let Argus generate a strong temporary password, which is shown **once**. Either way, the user must choose their own password at first sign-in.

## Invite links

Instead of creating accounts yourself, you can send people a link to create their own. **Users → Invite users** sets:

| Setting | |
|---|---|
| **Role and teams** | Every account created with the link gets them. |
| **Link expires** | The link works until the end of the chosen day (at most 365 days ahead). |
| **Email addresses** | Optional. Only these addresses can use the link, once each, and the address becomes the account's email. Separate several with commas or new lines. |
| **Number of accounts** | Without addresses: how many people can sign up with the link (1–500; default 1). With addresses: one per address. |
| **Note** | Optional, for administrators only, for example who the link was sent to. |

The link is shown **once**, when it is created. From that window you can:

- **Copy link**, always: send it yourself, for example in a chat.
- **Send by email**, when the invite lists addresses and an email channel is set up under **Integrations**. Each address gets its own message, from the channel you pick, with an optional note from you. Their link fills in their address on the sign-up form. Addresses that have already signed up are skipped, and if some messages fail, **Try again** resends only those.

Once the window is closed, the link cannot be shown or emailed again; create a new invite instead.

Opening the link shows the role and teams on offer (never the list of invited addresses). The invitee chooses a username, display name and password (the password policy applies), and is signed in straight away. They are not asked to change the password at first sign-in, because they chose it themselves. If MFA is required, they enrol at first sign-in as usual.

**Invite links** on the Users page lists active links with how many accounts each has created. Tick *Show used, expired and revoked* to see the rest. **Revoke** stops a link working immediately; accounts already created with it are not affected.

Creating and revoking links needs the *Manage users* permission and a signed-in session (an API token cannot create them). Creating and revoking links, and each account created with one, are audited.

## Account actions

Open a user to:

- **Edit** their display name, email, role, teams or status. A disabled user is signed out everywhere immediately and cannot sign in.
- **Reset password**: generates a new temporary password (shown once) and signs the user out everywhere.
- **Reset MFA**: removes their authenticator so they can enroll again (for example, after losing a phone).
- **Unlock account**: clears a lockout caused by repeated failed sign-ins.
- **Sign out everywhere**: revokes all of their sessions.

Every action is recorded in the audit log.

## Multi-factor authentication

Users enable MFA under **Profile → Multi-factor authentication**:

1. Scan the QR code with an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password and others). You can also enter the key manually.
2. Enter a 6-digit code to confirm.
3. Save the **10 recovery codes**. Each works once, and they are not shown again.

At sign-in, after the password, Argus asks for a code from the app or a recovery code. Codes cannot be reused.

**Enforcing MFA:** under **Security settings → Require MFA for all users**, every user without MFA is taken to enrollment at their next sign-in and cannot use Argus until they finish. While enforcement is on, users cannot turn MFA off.

## Password policy and lockout

These are configured under **Security settings**:

- **Password rules.** The defaults are at least 12 characters, at least 3 of {lowercase, uppercase, digit, symbol}, and the password must not contain the username. The sign-in UI checks the rules as you type, and the server enforces them.
- **Lockout.** After 5 consecutive failures (counting wrong passwords, wrong MFA codes and wrong "current password" entries), the account is locked for 15 minutes. Administrators can unlock it sooner.
- **Session lifetime.** Access tokens last 15 minutes and are renewed silently. A session ends after 7 days of inactivity.

## Audit log

**Administration → Audit log** lists security events, newest first:

- sign-ins and sign-in failures (with the reason)
- lockouts
- password changes and resets
- MFA enrollment, disablement and reset
- user and team changes
- security setting changes
- audit exports
- suspected refresh-token theft

You can filter by action, outcome and date range. Expand a row to see its details, or use **Export CSV** (up to 10,000 rows per export; the export itself is audited).

See the [security model](../security.md) for how all of this is implemented.
