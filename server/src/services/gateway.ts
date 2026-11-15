import crypto from 'crypto';
import { config } from '../config';
import { AppError } from '../lib/errors';

/**
 * Razorpay integration (optional).
 *
 * With no credentials the application runs in TRANSACTION-RECORDING MODE: online payments
 * are entered by staff and nothing is collected. With credentials, orders are created
 * server-side and a payment is only ever marked successful by a signature-verified
 * webhook (or a server-to-server status fetch) — never by anything the browser says.
 */
export const gatewayConfigured = () => Boolean(config.razorpay.keyId && config.razorpay.keySecret && config.razorpay.webhookSecret);

export function gatewayStatus() {
  const configured = gatewayConfigured();
  return {
    provider: configured ? 'razorpay' : null,
    configured,
    mode: configured ? ('gateway' as const) : ('recording' as const),
    keyId: configured ? config.razorpay.keyId : null, // public key id only; secrets never leave the server
    message: configured
      ? 'Razorpay is configured. Payments are confirmed only by signed webhooks.'
      : 'No payment gateway is configured. Online payments are recorded manually (transaction-recording mode); no money is collected by this application.',
  };
}

export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined, secret = config.razorpay.webhookSecret): boolean {
  if (!secret || !signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

async function call<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
  if (!gatewayConfigured()) throw new AppError(409, 'GATEWAY_NOT_CONFIGURED', 'No payment gateway is configured');
  const auth = Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64');
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: init.method,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new AppError(502, 'GATEWAY_ERROR', `The payment gateway rejected the request (HTTP ${res.status})`);
  return (await res.json()) as T;
}

export interface GatewayOrder { id: string; amount: number; currency: string; status: string }
export interface GatewayPayment { id: string; order_id: string; amount: number; currency: string; status: string; method: string; fee?: number; created_at: number }

export const createOrder = (amountMinor: number, currency: string, receipt: string, notes: Record<string, string>) =>
  call<GatewayOrder>('/orders', { method: 'POST', body: { amount: amountMinor, currency, receipt, notes } });

export const fetchOrderPayments = (orderId: string) => call<{ items: GatewayPayment[] }>(`/orders/${encodeURIComponent(orderId)}/payments`, { method: 'GET' });

export function mapGatewayMethod(method: string | undefined) {
  switch (method) {
    case 'upi': return 'UPI' as const;
    case 'netbanking': return 'NET_BANKING' as const;
    case 'card': return 'CREDIT_CARD' as const;
    default: return 'PAYMENT_GATEWAY' as const;
  }
}
