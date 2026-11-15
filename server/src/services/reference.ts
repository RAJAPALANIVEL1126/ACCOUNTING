import { prisma, Tx } from '../db';
import { PERMISSIONS, ROLE_DESCRIPTIONS, ROLE_NAMES, ROLE_PERMISSIONS } from '../lib/permissions';
import type { AccountSubtype, AccountType, CategoryType, PlGroup } from '@prisma/client';

/**
 * Idempotently mirrors the role/permission matrix into the database.
 * This is reference configuration, not sample data: it contains no users and no financial records.
 */
export async function ensureReferenceData() {
  for (const [key, description] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({ where: { key }, update: { description }, create: { key, description } });
  }
  const perms = await prisma.permission.findMany();
  const byKey = new Map(perms.map((p) => [p.key, p.id]));
  for (const name of ROLE_NAMES) {
    const role = await prisma.role.upsert({
      where: { name },
      update: { description: ROLE_DESCRIPTIONS[name] },
      create: { name, description: ROLE_DESCRIPTIONS[name] },
    });
    const wanted = ROLE_PERMISSIONS[name].map((k) => byKey.get(k)!);
    await prisma.$transaction([
      prisma.rolePermission.deleteMany({ where: { roleId: role.id, permissionId: { notIn: wanted } } }),
      prisma.rolePermission.createMany({ data: wanted.map((permissionId) => ({ roleId: role.id, permissionId })), skipDuplicates: true }),
    ]);
  }
}

export async function roleId(name: string): Promise<string> {
  const role = await prisma.role.findUnique({ where: { name } });
  if (!role) throw new Error(`Role ${name} missing — run ensureReferenceData()`);
  return role.id;
}

export const SYSTEM_ACCOUNTS: Array<{ code: string; name: string; type: AccountType; subtype: AccountSubtype }> = [
  { code: '1200', name: 'Accounts Receivable', type: 'ASSET', subtype: 'RECEIVABLE' },
  { code: '1300', name: 'Input Tax Recoverable', type: 'ASSET', subtype: 'TAX_INPUT' },
  { code: '2000', name: 'Accounts Payable', type: 'LIABILITY', subtype: 'PAYABLE' },
  { code: '2100', name: 'Output Tax Payable', type: 'LIABILITY', subtype: 'TAX_OUTPUT' },
  { code: '3000', name: 'Opening Balance Equity', type: 'EQUITY', subtype: 'OPENING_EQUITY' },
  { code: '4000', name: 'Revenue', type: 'INCOME', subtype: 'REVENUE' },
  { code: '5000', name: 'Expenses', type: 'EXPENSE', subtype: 'EXPENSE' },
];

export const SYSTEM_CATEGORY = {
  FEES: 'Payment Processing Fees',
  ADJ_GAIN: 'Balance Adjustment (Gain)',
  ADJ_LOSS: 'Balance Adjustment (Loss)',
};

export const DEFAULT_CATEGORIES: Array<{ name: string; type: CategoryType; plGroup: PlGroup; isSystem?: boolean }> = [
  { name: 'Product Sales', type: 'INCOME', plGroup: 'SALES_REVENUE' },
  { name: 'Service Revenue', type: 'INCOME', plGroup: 'SALES_REVENUE' },
  { name: 'Consulting Income', type: 'INCOME', plGroup: 'SALES_REVENUE' },
  { name: 'Training Income', type: 'INCOME', plGroup: 'SALES_REVENUE' },
  { name: 'Other Income', type: 'INCOME', plGroup: 'OTHER_OPERATING_INCOME' },
  { name: SYSTEM_CATEGORY.ADJ_GAIN, type: 'INCOME', plGroup: 'OTHER_OPERATING_INCOME', isSystem: true },
  { name: 'Cost of Goods Sold', type: 'EXPENSE', plGroup: 'COST_OF_GOODS_SOLD' },
  { name: 'Direct Costs', type: 'EXPENSE', plGroup: 'DIRECT_COST' },
  { name: 'Salaries and Wages', type: 'EXPENSE', plGroup: 'EMPLOYEE' },
  { name: 'Rent', type: 'EXPENSE', plGroup: 'RENT_UTILITIES' },
  { name: 'Utilities', type: 'EXPENSE', plGroup: 'RENT_UTILITIES' },
  { name: 'Marketing and Advertising', type: 'EXPENSE', plGroup: 'MARKETING' },
  { name: 'Transportation and Travel', type: 'EXPENSE', plGroup: 'TRANSPORTATION' },
  { name: 'Office and Administrative', type: 'EXPENSE', plGroup: 'ADMINISTRATIVE' },
  { name: SYSTEM_CATEGORY.FEES, type: 'EXPENSE', plGroup: 'ADMINISTRATIVE', isSystem: true },
  { name: 'Other Expenses', type: 'EXPENSE', plGroup: 'OTHER_EXPENSE' },
  { name: SYSTEM_CATEGORY.ADJ_LOSS, type: 'EXPENSE', plGroup: 'OTHER_EXPENSE', isSystem: true },
];

/** Chart of accounts, default categories, one cash account and settings for a brand-new company. */
export async function provisionCompanyDefaults(tx: Tx, companyId: string) {
  await tx.companySettings.create({ data: { companyId } });
  await tx.account.createMany({
    data: [
      ...SYSTEM_ACCOUNTS.map((a) => ({ ...a, companyId, isSystem: true })),
      { companyId, code: '1000', name: 'Cash in Hand', type: 'ASSET' as const, subtype: 'CASH' as const, isSystem: false },
    ],
  });
  await tx.transactionCategory.createMany({ data: DEFAULT_CATEGORIES.map((c) => ({ ...c, isSystem: c.isSystem ?? false, companyId })) });
}
