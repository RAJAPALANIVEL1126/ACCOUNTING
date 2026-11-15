/**
 * OPTIONAL development-only sample data.   npm run seed:dev
 *
 * - Refuses to run when NODE_ENV=production.
 * - Is never run automatically (not by migrations, not at start-up, not by the tests).
 * - Creates one demo company with a demo super administrator and a few weeks of sample
 *   entries, all posted through the same services the API uses.
 * - The demo sign-in comes from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD in server/.env
 *   (git-ignored). Nothing is hard-coded.
 */
import { prisma } from '../db';
import { config } from '../config';
import { D } from '../lib/money';
import { addDays, parseDate, today } from '../lib/dates';
import { hashPassword } from '../lib/tokens';
import { ensureReferenceData, provisionCompanyDefaults, roleId } from '../services/reference';
import { Actor, createExpense, createIncome, createOpeningBalance, createTransfer } from '../services/transactions';
import { createInvoice, issueInvoice } from '../services/invoices';
import { recordPayment } from '../services/payments';

async function main() {
  if (config.isProd) throw new Error('The development seed must never run in production.');
  const email = (process.env.SEED_ADMIN_EMAIL || '').toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || '';
  if (!email || password.length < 12) throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (min 12 characters) in server/.env first.');
  if (await prisma.user.findUnique({ where: { email } })) throw new Error(`${email} already exists — the seed has already been applied.`);

  await ensureReferenceData();
  const day = (n: number) => addDays(today(), -n);

  const { company, user } = await prisma.$transaction(async (tx) => {
    const company = await tx.company.create({ data: { name: 'Demo Trading Co (sample data)', city: 'Chennai', state: 'Tamil Nadu', country: 'India', baseCurrency: 'INR', fyStartMonth: 4 } });
    await provisionCompanyDefaults(tx, company.id);
    await tx.companySettings.update({ where: { companyId: company.id }, data: { taxEnabled: true } });
    await tx.taxRate.createMany({ data: [{ companyId: company.id, name: 'GST 5%', rate: '5' }, { companyId: company.id, name: 'GST 18%', rate: '18' }] });
    const user = await tx.user.create({ data: { companyId: company.id, fullName: 'Demo Administrator', email, passwordHash: await hashPassword(password), roleId: await roleId('SUPER_ADMIN'), emailVerifiedAt: new Date() } });
    return { company, user };
  });
  const actor: Actor = { companyId: company.id, userId: user.id, userName: user.fullName };
  const cats = await prisma.transactionCategory.findMany({ where: { companyId: company.id } });
  const cat = (name: string) => cats.find((c) => c.name === name)!.id;

  await prisma.$transaction(async (tx) => {
    const cash = await tx.account.findFirstOrThrow({ where: { companyId: company.id, subtype: 'CASH' } });
    const bank = await tx.account.create({ data: { companyId: company.id, code: '1101', name: 'Current Account', type: 'ASSET', subtype: 'BANK', bankName: 'Sample Bank', bankAccountType: 'CURRENT', accountNumberMasked: 'XXXX4821', openingBalance: '150000', openingDate: parseDate(day(60)) } });
    await createOpeningBalance(tx, actor, cash, D('20000'), parseDate(day(60)));
    await createOpeningBalance(tx, actor, bank, D('150000'), parseDate(day(60)));
    const customer = await tx.customer.create({ data: { companyId: company.id, name: 'Sample Customer', businessName: 'Sample Retail Pvt Ltd', email: 'accounts@customer.example' } });
    const supplier = await tx.supplier.create({ data: { companyId: company.id, name: 'Sample Supplier', businessName: 'Sample Wholesale Traders' } });

    for (let i = 56; i >= 0; i -= 4) {
      await createIncome(tx, actor, { date: day(i), categoryId: cat(i % 8 ? 'Product Sales' : 'Service Revenue'), amount: D(9000 + (i % 7) * 1350), taxAmount: D(0), paymentMethod: i % 3 ? 'UPI' : 'CASH', accountId: i % 3 ? bank.id : cash.id, description: 'Sample sale' });
      await createExpense(tx, actor, { date: day(i), categoryId: cat('Cost of Goods Sold'), amount: D(3800 + (i % 5) * 600), taxAmount: D(0), taxRecoverable: false, paymentMethod: 'BANK_TRANSFER', accountId: bank.id, description: 'Sample stock purchase' });
    }
    for (const i of [50, 20]) {
      await createExpense(tx, actor, { date: day(i), categoryId: cat('Rent'), amount: D(25000), taxAmount: D(0), taxRecoverable: false, paymentMethod: 'BANK_TRANSFER', accountId: bank.id, description: 'Sample office rent' });
      await createExpense(tx, actor, { date: day(i - 2), categoryId: cat('Salaries and Wages'), amount: D(42000), taxAmount: D(0), taxRecoverable: false, paymentMethod: 'BANK_TRANSFER', accountId: bank.id, description: 'Sample salaries' });
      await createExpense(tx, actor, { date: day(i - 5), categoryId: cat('Marketing and Advertising'), amount: D(6500), taxAmount: D(1170), taxRecoverable: true, paymentMethod: 'CREDIT_CARD', accountId: bank.id, description: 'Sample online ads' });
    }
    await createExpense(tx, actor, { date: day(6), categoryId: cat('Office and Administrative'), supplierId: supplier.id, amount: D(8000), taxAmount: D(1440), taxRecoverable: false, paymentMethod: 'CREDIT', description: 'Sample stationery (unpaid bill)', dueDate: addDays(today(), 10) });
    await createTransfer(tx, actor, { date: day(10), fromAccountId: cash.id, toAccountId: bank.id, amount: D(15000), description: 'Sample cash deposit' });

    const item = (description: string, unitPrice: string) => ({ description, quantity: D(1), unitPrice: D(unitPrice), discount: D(0), taxRate: D(18), categoryId: cat('Consulting Income') });
    const paid = await issueInvoice(tx, actor, (await createInvoice(tx, actor, { customerId: customer.id, issueDate: day(30), dueDate: day(15), items: [item('Sample consulting engagement', '40000')] })).id);
    await recordPayment(tx, actor, { direction: 'INBOUND', status: 'SUCCESS', method: 'NET_BANKING', invoiceId: paid.id, accountId: bank.id, date: day(18), amount: D('47200'), fee: D(0), gatewayPaymentId: 'SAMPLE-NB-0001' });
    const part = await issueInvoice(tx, actor, (await createInvoice(tx, actor, { customerId: customer.id, issueDate: day(12), dueDate: addDays(today(), 3), items: [item('Sample advisory retainer', '25000')] })).id);
    await recordPayment(tx, actor, { direction: 'INBOUND', status: 'SUCCESS', method: 'UPI', invoiceId: part.id, accountId: bank.id, date: day(5), amount: D('10000'), fee: D(0), gatewayPaymentId: 'SAMPLE-UPI-0002' });
    await issueInvoice(tx, actor, (await createInvoice(tx, actor, { customerId: customer.id, issueDate: day(40), dueDate: day(25), items: [item('Sample overdue invoice', '12000')] })).id);
  }, { timeout: 120000, maxWait: 20000 });

  console.log(`\nDevelopment sample data created for "${company.name}".\nSign in with the SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD values from server/.env.\n`);
}

main()
  .catch((e) => { console.error('\nSeed failed: ' + e.message + '\n'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
