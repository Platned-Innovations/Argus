export const ROLES = ['admin', 'security_manager', 'developer', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrator',
  security_manager: 'Security Manager',
  developer: 'Developer',
  viewer: 'Viewer',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  admin: 'Full access, including users, sources, integrations and system settings.',
  security_manager: 'Manages repositories, findings, tickets and threat intel across all teams.',
  developer: "Works tickets and runs scans for their teams' repositories.",
  viewer: "Read-only access to their teams' repositories, findings and tickets.",
};

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
