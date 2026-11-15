/**
 * Secure first-administrator setup.
 *
 *   npm run setup:admin                (development)
 *   npm run setup:admin:prod           (production, after `npm run build`)
 *
 * This is the ONLY way a SUPER_ADMIN account comes into existence. It requires shell access
 * to the server and the database credentials; there is no web page or API that can do it.
 * The password is typed interactively (not echoed) and is never stored in plain text,
 * written to logs, or accepted from a command-line argument.
 *
 * Non-interactive provisioning (CI / container init) is possible by supplying
 * SETUP_ADMIN_NAME, SETUP_ADMIN_EMAIL and SETUP_ADMIN_PASSWORD as environment variables
 * from your secret manager. Unset them afterwards.
 */
import readline from 'readline';
import { prisma } from '../db';
import { config } from '../config';
import { hashPassword } from '../lib/tokens';
import { ensureReferenceData, roleId } from '../services/reference';
import { audit } from '../lib/audit';

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
      out._writeToOutput = (s: string) => {
        if (s.includes(question)) out.output.write(s);
        else if (s === '\r\n' || s === '\n') out.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function passwordProblem(p: string): string | null {
  if (p.length < Math.max(12, config.security.passwordMinLength)) return 'Administrator passwords must be at least 12 characters.';
  if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return 'Password must contain at least one letter and one number.';
  return null;
}

async function main() {
  await ensureReferenceData();
  const fromEnv = Boolean(process.env.SETUP_ADMIN_EMAIL && process.env.SETUP_ADMIN_PASSWORD);
  if (!fromEnv && !process.stdin.isTTY) {
    throw new Error('Run this command in an interactive terminal, or provide SETUP_ADMIN_NAME, SETUP_ADMIN_EMAIL and SETUP_ADMIN_PASSWORD.');
  }

  console.log('\nCompany Accounting Software — administrator setup\n');
  const fullName = fromEnv ? process.env.SETUP_ADMIN_NAME || 'Administrator' : await ask('Full name: ');
  const email = (fromEnv ? process.env.SETUP_ADMIN_EMAIL! : await ask('Email address: ')).toLowerCase();
  if (fullName.length < 2) throw new Error('Full name is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Enter a valid email address.');
  if (await prisma.user.findUnique({ where: { email } })) throw new Error(`A user with the email ${email} already exists.`);

  let password = fromEnv ? process.env.SETUP_ADMIN_PASSWORD! : '';
  if (!fromEnv) {
    for (;;) {
      password = await ask('Password (min 12 characters, not shown): ', true);
      const problem = passwordProblem(password);
      if (problem) { console.log(problem); continue; }
      if ((await ask('Confirm password: ', true)) !== password) { console.log('Passwords do not match.'); continue; }
      break;
    }
  } else {
    const problem = passwordProblem(password);
    if (problem) throw new Error(problem);
  }

  const user = await prisma.user.create({
    data: { fullName, email, passwordHash: await hashPassword(password), roleId: await roleId('SUPER_ADMIN'), emailVerifiedAt: new Date() },
  });
  await audit(prisma, { userId: user.id, userName: fullName, action: 'user.bootstrap_admin', entityType: 'User', entityId: user.id, summary: `Super administrator ${email} created through the server-side setup command` });

  console.log(`\nSuper administrator created: ${email}`);
  console.log('Sign in to the web application, then complete "Company Details" to create your company.\n');
}

main()
  .catch((e) => {
    console.error('\nSetup failed: ' + e.message + '\n');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
