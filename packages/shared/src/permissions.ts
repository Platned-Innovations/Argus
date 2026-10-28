import { type Role } from './roles';

export const PERMISSIONS = [
  'users:read',
  'users:manage',
  'teams:read',
  'teams:manage',
  'audit:read',
  'settings:read',
  'settings:manage',
  'sources:manage',
  'repos:read',
  'repos:manage',
  'scans:run',
  'findings:read',
  'tickets:read',
  'tickets:write',
  'tickets:triage',
  'ai:use',
  'intel:manage',
  'reports:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  security_manager: [
    'users:read',
    'teams:read',
    'audit:read',
    'settings:read',
    'repos:read',
    'repos:manage',
    'scans:run',
    'findings:read',
    'tickets:read',
    'tickets:write',
    'tickets:triage',
    'ai:use',
    'intel:manage',
    'reports:read',
  ],
  developer: ['teams:read', 'repos:read', 'scans:run', 'findings:read', 'tickets:read', 'tickets:write', 'ai:use', 'reports:read'],
  viewer: ['teams:read', 'repos:read', 'findings:read', 'tickets:read', 'reports:read'],
};

export function permissionsFor(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Roles that see every team's repositories rather than only their own teams'. */
export function hasGlobalScope(role: Role): boolean {
  return role === 'admin' || role === 'security_manager';
}
