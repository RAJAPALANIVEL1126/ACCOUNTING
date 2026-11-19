# Company Accounting Software (CAS)

A database-driven accounting application for small and growing businesses: income, expenses, cash and bank
books, invoices, receivables and payables, online-payment recording, profit and loss, daily/monthly reports,
exports, role-based access and a tamper-evident audit trail.

| Layer | Technology |
|---|---|
| Web client | React 18, TypeScript, Vite, Tailwind CSS, Radix Dialog, TanStack Query, Recharts, Lucide |
| API | Node.js, Express 4, TypeScript, Zod validation |
| Database | PostgreSQL, Prisma ORM, SQL migrations (incl. constraints and triggers) |
| Security | Argon2id, DB-backed sessions in HTTP-only SameSite cookies, CSRF token, Helmet, rate limiting |
| Tests | Vitest + Supertest against a real PostgreSQL test database |

---

## 1. How the accounting works (read this first)

* **One ledger is the source of truth.** Every income, expense, transfer, invoice, receipt, refund and
  adjustment posts a balanced double-entry journal (`JournalEntry` / `JournalEntryLine`) inside a single
  database transaction. Balances, KPIs, charts and every report are *derived* from it, so they always agree.
* **Total debits = total credits** is enforced twice: in code, and by a deferred database constraint trigger.
* **Nothing posted is edited or deleted.** Corrections are reversal entries; invoices are cancelled with a
  reversing journal. Ledger lines and audit records are append-only at the database level (triggers).
* **Balances are never typed in.** Opening balances and adjustments are real journal entries; adjustments
  need a reason and an administrator.
* **Profit is not cash.** Profit and loss comes from income/expense accounts; cash flow comes from movements on
  cash and bank accounts. Transfers between your own accounts affect neither profit nor total cash.
* **Accounting method** (Settings → Accounting), shown on every report:
  * *Accrual* (default): income when invoiced/earned, expenses when incurred.
  * *Cash*: income and expenses only when money is received/paid (invoice receipts and bill payments are
    recognised net of tax, pro-rata).
* **Money** is `NUMERIC(18,2)` in the database and `decimal.js` in code — never floating point. Rounding is
  half-up to 2 places, applied per line so documents always foot. Gateway APIs use integer minor units (paise).
* **Invoices do not double-count revenue.** Issuing an invoice records revenue and a receivable once;
  payments only clear the receivable.

Formulas used: `Gross Profit = Total Revenue − Direct Costs` · `Net Profit = Recognised Income − Recognised Expenses`
· `Closing Balance = Opening Balance + Inflows − Outflows`.

## 2. Project structure

```
server/
  prisma/schema.prisma           data model (24 spec models + supporting tables)
  prisma/migrations/             SQL migrations (schema, then integrity rules: checks + triggers)
  src/app.ts, index.ts           Express app, security middleware, start-up
  src/middleware/                sessions + CSRF + permissions, idempotency, error handling
  src/lib/                       money, dates, validation, permissions, tokens, audit, mailer
  src/services/                  ledger (posting), transactions, invoices, payments, gateway,
                                 finance (aggregations), reports, exporter (CSV/XLSX/PDF)
  src/routes/                    REST endpoints
  src/scripts/setup-admin.ts     secure first-administrator setup
  tests/                         API integration + calculation tests
client/
  src/pages/                     Dashboard, Company, Transactions/Income/Expenses, Cash/Bank, Account book +
                                 reconciliation, Online Payments, Customers/Suppliers, Invoices, Reports,
                                 User Accounts, Settings, Audit Logs, Auth
  src/components/                design system (ui.tsx), layout/sidebar, forms and dialogs
  src/lib/                       API client, auth, formatting, date presets
scripts/dev-db.ps1               optional private PostgreSQL for local development (Windows)
```

## 3. Prerequisites

* Node.js 20 or newer (developed on Node 24) and npm
* PostgreSQL 14 or newer

## 4. Installation

```bash
npm --prefix server install
```

```bash
npm --prefix client install
```

> **Windows + OneDrive:** if the project lives inside a OneDrive-synced folder, `node_modules` makes installs
> and builds very slow. Either move the project outside OneDrive or exclude `node_modules` from sync. (On the
> machine where this was built, `node_modules` is a junction to `%LOCALAPPDATA%\cas-deps`.)

## 5. Database setup

1. Create two empty databases — one for the app, one that the tests may wipe:

   ```sql
   CREATE DATABASE cas_dev;
   CREATE DATABASE cas_test;
   ```

   *Windows shortcut:* `npm run db:start` creates and starts a private development cluster on port 5434, with
   its data in `%USERPROFILE%\cas-dev-pg` (local connections only) and both databases; `npm run db:stop` stops it. It must be started again after
   a reboot.

2. Copy the environment template and fill it in:

   ```bash
   cp server/.env.example server/.env
   ```

   | Variable | Purpose |
   |---|---|
   | `DATABASE_URL` | Application database |
   | `TEST_DATABASE_URL` | Test database (**wiped on every test run**; must differ from `DATABASE_URL`) |
   | `APP_URL` | Public URL of the web app (links in e-mails, CORS). `https://…` is required in production |
   | `SESSION_TTL_HOURS` | Session lifetime (default 12) |
   | `COOKIE_SECURE` | `true` behind HTTPS (forced on in production) |
   | `TRUST_PROXY` | Number of reverse proxies in front of the API |
   | `SMTP_*` | Outgoing e-mail for verification, invitations and password resets |
   | `MAX_UPLOAD_MB` | Upload size cap (default 4). Files are stored in the database; `UPLOAD_DIR` is only read for files saved by older versions |
   | `RAZORPAY_*` | Optional payment gateway (leave empty for recording mode) |
   | `SERVE_CLIENT` | `true` to serve the built web client from the API process |

   `server/.env` is git-ignored. Never commit real credentials.

3. Apply the migrations:

   ```bash
   npm --prefix server run migrate:deploy
   ```

## 6. Create the first administrator (secure setup)

There is **no** admin sign-up page, **no** default account and **no** default password. The first
administrator is created from a shell on the server, which requires the database credentials:

```bash
npm --prefix server run setup:admin
```

It asks for a name, e-mail and a password (typed hidden, minimum 12 characters), stores only an Argon2id hash,
and records the action in the audit log. Then sign in to the web app: you are taken to **Company Details** to
create the company (chart of accounts, a cash account and standard categories are created; no transactions).

For unattended provisioning, supply `SETUP_ADMIN_NAME`, `SETUP_ADMIN_EMAIL` and `SETUP_ADMIN_PASSWORD` from
your secret manager for that one command, then unset them. Run the command again to create a separate company
with its own super administrator.

**How other people get access**

* An admin creates the user under **User Accounts** → the user receives a single-use link to choose a password.
* Or the person signs up publicly. Public sign-up always creates a *Viewer with no company*: after verifying
  their e-mail they see a "waiting for access" page and can read nothing until an admin adds their e-mail
  under User Accounts. Public registration can never produce an administrator.

| Role | Can do |
|---|---|
| Super Admin | Everything, including creating/authorising administrators |
| Admin | Company details, settings, transactions, approvals, reversals, reports, non-admin users |
| Accountant | Record income/expenses/transfers, invoices, payments, reconciliation, reports and exports |
| Viewer | Read-only |

Permissions are enforced by the API on every request; the UI only hides what you cannot use.

## 7. Local development

Terminal 1 — API on http://localhost:4000:

```bash
npm --prefix server run dev
```

Terminal 2 — web app on http://localhost:5173 (proxies `/api` to the API):

```bash
npm --prefix client run dev
```

Without SMTP in development, e-mails (verification, invitation, reset links) are printed to the API console.

**No sample data.** The application never inserts sample or demo records, and there is no seed script. Every
income, expense, invoice and payment is entered by a user, and entry forms start empty: no date, amount, payment
method, account or category is chosen for you. A new company starts with only an empty "Cash in Hand" account
(balance 0) and a standard list of income and expense categories that you can rename, deactivate or extend.

## 8. Tests

```bash
npm --prefix server test
```

```bash
npm --prefix client test
```

The server suite runs against `TEST_DATABASE_URL` (migrated automatically, emptied before each file) through
the real HTTP API. It covers: registration, login/logout, lockout, password reset, CSRF, unauthenticated access
to every protected route, role permissions, privilege escalation, company data isolation, transaction
creation and validation (zero, negative, huge amounts, invalid dates), cash balance rules, bank transfers,
reversals, duplicate-request protection, concurrent postings, expense approval, invoice totals, partial
payments, over-payment, duplicate payments, refunds, pending/failed online payments, webhook signature
verification and idempotency, P&L (accrual and cash), date-range filtering, report totals reconciling with the
ledger, CSV/Excel/PDF exports, empty reports, company validation, the audit log, file uploads (type
sniffing, size limit, access control), bank statement import and reconciliation, and user invitation.

## 9. Production build

```bash
npm --prefix server run build
```

```bash
npm --prefix client run build
```

Outputs: `server/dist/` (run with `node dist/index.js`) and `client/dist/` (static files).

## 10. Production deployment

**Checklist**

1. PostgreSQL: a managed instance or your own server, reachable only from the API host, TLS enabled, with a
   dedicated least-privilege role that owns only this database.
2. Environment on the API host: `NODE_ENV=production`, `DATABASE_URL`, `APP_URL=https://your-domain`,
   `TRUST_PROXY=1` (behind one reverse proxy) and `SMTP_*`. The server
   refuses to start in production without a database URL and an `https://` `APP_URL`.
3. `npm ci` in `server/`, then `npm run build`, then `npm run migrate:deploy` (run on every release).
4. Create the first administrator once: `npm run setup:admin:prod`.
5. Start the API under a process manager (systemd, PM2, a container): `node dist/index.js`. Health check:
   `GET /api/health`.
6. Serve the web client **from the same origin** as the API, over HTTPS:
   * *Single host:* build the client, set `SERVE_CLIENT=true`; the API serves `client/dist` and falls back to
     `index.html`.
   * *Reverse proxy (recommended):* nginx/Caddy serves `client/dist`, proxies `/api/` to the API, terminates
     TLS and redirects HTTP → HTTPS. Example (nginx):

     ```nginx
     server {
       listen 443 ssl http2;
       server_name books.example.com;
       root /srv/cas/client/dist;
       client_max_body_size 6m;
       location /api/ { proxy_pass http://127.0.0.1:4000; proxy_set_header Host $host;
                        proxy_set_header X-Forwarded-For $remote_addr; proxy_set_header X-Forwarded-Proto https; }
       location / { try_files $uri /index.html; }
     }
     ```
   Same-origin hosting keeps the session cookie first-party (`HttpOnly; Secure; SameSite=Lax`).
7. Run exactly one schema migration at a time; the API itself is stateless and can run as several instances
   (sessions, idempotency keys and counters live in PostgreSQL). Uploaded files then need shared storage.

**Deploying on Vercel (recommended host for this repository)**

The repository is ready for Vercel as a single project: `vercel.json` builds the web client as static files and
runs the API as one serverless function (`api/index.ts`), on the same domain, so sign-in cookies just work.

1. **Database.** In the Vercel project open **Storage → Create Database → Neon (Postgres)** and connect it to
   the project. This adds `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct). The app automatically
   uses the direct connection; with another provider just set `DATABASE_URL`.
2. **Import the repository** (Add New → Project). Keep **Root Directory** `./` and choose **Application Preset:
   Other**. Do *not* use "Services" or import `client`/`server` separately — `vercel.json` already sets the
   install command, build command and output directory.
3. **Environment variables** (Settings → Environment Variables, Production):

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `APP_URL` | your production URL, e.g. `https://accounting-xxxx.vercel.app` (must be `https://`) |
   | `TRUST_PROXY` | `1` |
   | `CRON_SECRET` | a long random string; protects the daily cleanup job |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | your e-mail provider; without them sign-up verification and password links cannot be delivered |

4. **Deploy.** Every deploy's build applies pending database migrations and creates the roles
   (`npm run vercel-build`), then builds the client. No users, companies or records are created.
5. **Create the first administrator** from your own computer, pointed at the production database (use the
   *unpooled* connection string from the Neon integration), in PowerShell:

   ```powershell
   $env:DATABASE_URL = 'postgresql://…unpooled URL…'; npm run setup:admin
   ```

   Then open the site, sign in, and create your company.

What differs from a classic server: uploaded logos and receipts are stored in the database (Vercel has no
persistent disk), uploads are limited to 4 MB (Vercel's request limit is 4.5 MB), expired sessions are cleaned
by a daily Vercel Cron job (`/api/cron/housekeeping`), and request rate limits are counted per function instance.

**External services that still need your configuration**

| Service | Needed for | Status in this repository |
|---|---|---|
| PostgreSQL | Everything | You provide the database and `DATABASE_URL` |
| SMTP server | E-mail verification, user invitations, password resets, approval notices | Not configured. Without it in production no link can be delivered (links are deliberately never logged) |
| Razorpay | *Collecting* money online | Optional. Not configured → transaction-recording mode |
| HTTPS certificate / domain | Production | You provide |

## 11. Online payments

* **Recording mode (default).** UPI, cards, net banking, gateway and bank-transfer payments are *recorded* by
  staff after the money has arrived. A payment can be saved as *Pending* (posts nothing) and confirmed later.
  The UI states clearly that no money is collected. Provider reference IDs are unique, so the same payment
  cannot be recorded twice.
* **Gateway mode (Razorpay).** Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` and add
  a webhook in the Razorpay dashboard pointing to `https://your-domain/api/webhooks/razorpay` for
  `payment.captured`, `payment.failed`, `refund.processed`. "Collect online" then appears on issued invoices.
  * Orders are created server-side for the exact outstanding amount (in paise).
  * A payment becomes *Successful* only through a webhook whose HMAC-SHA256 signature verifies, or a
    server-to-server status check — never from anything the browser reports.
  * Webhook events are stored and de-duplicated; amounts must match; redeliveries are ignored.
* Card numbers, CVV, PINs and banking passwords are never requested, transmitted or stored.

> **Tested vs not tested:** signature verification, idempotency, amount checks, refunds and the "browser
> cannot mark a gateway payment paid" rule are covered by automated tests using a test secret. The live calls
> to Razorpay (order creation, checkout, status fetch) have **not** been exercised, because that needs real
> gateway credentials. Test them in Razorpay *test mode* before going live.

## 12. Security summary

* Passwords: Argon2id; minimum 10 characters with a letter and a number; lockout after 5 failures for 15 min.
* Sessions: random 256-bit token, only its SHA-256 stored; HTTP-only, SameSite=Lax, Secure in production;
  revoked on logout, password change, role change and deactivation.
* CSRF: per-session token required on every state-changing request.
* Authorisation: permission check + company scoping on every route; ids from another company return 404.
* Validation: every input validated server-side (Zod); parameterised SQL only (Prisma / tagged templates).
* Duplicate requests: `Idempotency-Key` on financial POSTs; row locks make concurrent postings safe.
* Uploads: size-capped, type decided by magic bytes, stored under random names, served only to the owning
  company with `nosniff` and a sandbox CSP.
* Headers and limits: Helmet (CSP, frame-ancestors none, etc.), rate limiting on `/api` and tighter on auth.
* Errors: one JSON shape, no stack traces to clients; logs redact passwords, tokens, cookies and secrets.
* Secrets live only in environment variables; none are in the client bundle or the repository.

## 13. Backup and recovery

**What to back up:** (1) the PostgreSQL database — all accounting data, including uploaded logos and receipts;
(2) your environment/secrets, stored separately in a secret manager.

**Nightly logical backup**

```bash
pg_dump --format=custom --no-owner --file="cas-$(date +%F).dump" "$DATABASE_URL"
```

Encrypt the files, copy them off-site, keep at least 30 daily and 12 monthly copies. For a recovery point of
minutes rather than a day, also enable WAL archiving / point-in-time recovery (built in on managed PostgreSQL).

**Restore**

```bash
createdb cas_restored
```

```bash
pg_restore --no-owner --dbname="postgresql://USER:PASSWORD@HOST:5432/cas_restored" cas-YYYY-MM-DD.dump
```

Then point `DATABASE_URL` at the restored database, run
`npm run migrate:deploy`, start the API and verify: sign in, compare the dashboard cash/bank balances and the
latest transaction number with what you expect, and open one attachment.

**Practice:** restore into a scratch database at least quarterly; an untested backup is not a backup. Take an
extra backup immediately before every release that includes a migration.

## 14. API overview

All endpoints are under `/api`, return `{ "data": …, "meta": … }` on success and
`{ "error": { "code", "message", "details" } }` on failure.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/signup`, `/auth/login`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/verify-email`, `/auth/resend-verification`, `/auth/change-password`, `GET /auth/me` |
| Company | `GET/POST/PATCH /company`, `POST/GET /company/logo` |
| Dashboard | `GET /dashboard/summary`, `/income-expenses`, `/profit-loss`, `/cash-flow` |
| Transactions | `GET/POST /transactions`, `GET/PATCH /transactions/:id`, `POST /transactions/:id/reverse`, `/approve`, `/reject` |
| Income / Expenses | `GET/POST /income`, `GET/POST /expenses`, `POST /expenses/:id/payments` |
| Accounts | `GET/POST /accounts`, `PATCH /accounts/:id`, `GET /accounts/:id/transactions`, statement import and reconciliation under `/accounts/:id/…` |
| Customers / Suppliers | `GET/POST /customers`, `GET/PATCH /customers/:id` (same for `/suppliers`) |
| Invoices | `GET/POST /invoices`, `GET/PATCH /invoices/:id`, `POST /invoices/:id/issue`, `/cancel`, `/payments`, `/payment-order`, `GET /invoices/:id/pdf` |
| Payments | `GET/POST /payments`, `POST /payments/:id/status`, `/verify`, `/refund`, `/reconcile`, `POST /webhooks/razorpay` |
| Reports | `GET /reports`, `GET /reports/:key?from&to&format=json|csv|xlsx|pdf` — daily, monthly, annual, profit-loss, income, expenses, cash-flow, cash-accounts, bank-accounts, online-payments, receivables, payables, customer-transactions, supplier-transactions, tax-summary |
| Admin | `GET/POST /users`, `PATCH /users/:id`, `PATCH /users/:id/status`, `POST /users/:id/reset-password`, `GET /users/:id/activity`, `GET/PATCH /settings`, `/categories`, `/tax-rates`, `GET /audit-logs` |

## 15. Known limits

* One base currency per company (configurable until the first entry is posted); no multi-currency.
* Roles and their permissions are fixed in code (viewable under User Accounts → Roles and permissions).
* Bank reconciliation works on imported CSV statements; there is no live bank feed.
* The tax summary is a bookkeeping aid, not a statutory GST return.
* Not a substitute for professional accounting advice; have your accountant review the setup before relying
  on it for statutory filings.
