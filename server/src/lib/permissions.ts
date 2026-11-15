/** Single source of truth for role → permission mapping. Mirrored into the Role/Permission tables at start-up. */
export const PERMISSIONS = {
  'company.view': 'View company details',
  'company.manage': 'Edit company details and logo',
  'settings.manage': 'Change accounting, tax, invoice and notification settings',
  'categories.manage': 'Configure income and expense categories',
  'users.view': 'View user accounts and activity',
  'users.manage': 'Create, edit, activate and deactivate non-admin users',
  'admins.manage': 'Create or authorise administrators and change admin roles',
  'transactions.view': 'View transactions, income and expenses',
  'transactions.create': 'Record income, expenses and transfers',
  'transactions.reverse': 'Reverse posted transactions',
  'expenses.approve': 'Approve or reject expenses',
  'adjustments.create': 'Post cash and bank balance adjustments',
  'accounts.view': 'View cash and bank accounts',
  'accounts.manage': 'Create and edit cash and bank accounts',
  'reconciliation.manage': 'Import statements and reconcile accounts',
  'contacts.view': 'View customers and suppliers',
  'contacts.manage': 'Create and edit customers and suppliers',
  'invoices.view': 'View invoices',
  'invoices.manage': 'Create, issue and cancel invoices',
  'payments.view': 'View payments',
  'payments.manage': 'Record payments, refunds and reconciliation',
  'reports.view': 'View dashboards and reports',
  'reports.export': 'Export reports and data',
  'audit.view': 'View audit logs',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export type RoleName = 'SUPER_ADMIN' | 'ADMIN' | 'ACCOUNTANT' | 'VIEWER';
export const ROLE_NAMES: RoleName[] = ['SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT', 'VIEWER'];
export const ADMIN_ROLES: string[] = ['SUPER_ADMIN', 'ADMIN'];

const ALL = Object.keys(PERMISSIONS) as PermissionKey[];

export const ROLE_PERMISSIONS: Record<RoleName, PermissionKey[]> = {
  SUPER_ADMIN: ALL,
  ADMIN: ALL.filter((p) => p !== 'admins.manage'),
  ACCOUNTANT: [
    'company.view', 'transactions.view', 'transactions.create', 'accounts.view', 'reconciliation.manage',
    'contacts.view', 'contacts.manage', 'invoices.view', 'invoices.manage', 'payments.view', 'payments.manage',
    'reports.view', 'reports.export',
  ],
  VIEWER: ['company.view', 'transactions.view', 'accounts.view', 'contacts.view', 'invoices.view', 'payments.view', 'reports.view'],
};

export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  SUPER_ADMIN: 'Full access, including system configuration and authorising administrators',
  ADMIN: 'Manages company details, transactions, reports and non-admin user accounts',
  ACCOUNTANT: 'Records income and expenses, manages invoices, runs accounting reports',
  VIEWER: 'Read-only access to permitted financial information',
};

export const permissionsFor = (role: string): Set<PermissionKey> => new Set(ROLE_PERMISSIONS[role as RoleName] ?? []);
