import type { FormEvent } from 'react';
import { useForm } from '../lib/hooks';
import { MONTH_NAMES } from '../lib/dates';
import { Button, Field, Input, Select, Textarea } from './ui';

export interface CompanyValues {
  name: string; registrationNumber: string; gstin: string; pan: string; email: string; phone: string; address: string; city: string; state: string;
  country: string; postalCode: string; website: string; baseCurrency: string; fyStartMonth: string;
}
export const EMPTY_COMPANY: CompanyValues = {
  name: '', registrationNumber: '', gstin: '', pan: '', email: '', phone: '', address: '', city: '', state: '', country: 'India', postalCode: '', website: '', baseCurrency: 'INR', fyStartMonth: '4',
};
export const companyValues = (c: Record<string, unknown> | null | undefined): CompanyValues => {
  const out = { ...EMPTY_COMPANY } as Record<string, string>;
  if (c) for (const k of Object.keys(EMPTY_COMPANY)) if (c[k] !== null && c[k] !== undefined) out[k] = String(c[k]);
  return out as unknown as CompanyValues;
};

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD'];

interface Props {
  initial: CompanyValues;
  submitLabel: string;
  readOnly?: boolean;
  currencyLocked?: boolean;
  onSubmit: (values: CompanyValues, setErrors: (e: Record<string, string>) => void) => Promise<unknown>;
  busy?: boolean;
}

export function CompanyForm({ initial, submitLabel, readOnly, onSubmit, busy }: Props) {
  const f = useForm<Record<keyof CompanyValues, string>>({ ...initial });
  const submit = (e: FormEvent) => { e.preventDefault(); void onSubmit(f.values, f.setErrors); };
  const ro = { disabled: readOnly };
  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-semibold text-slate-900">Business identity</legend>
        <Field label="Company name" required error={f.errors.name} className="sm:col-span-2"><Input {...f.bind('name')} {...ro} maxLength={160} /></Field>
        <Field label="Company registration number" error={f.errors.registrationNumber} hint="CIN / LLPIN / other, if registered"><Input {...f.bind('registrationNumber')} {...ro} /></Field>
        <Field label="Company website" error={f.errors.website}><Input type="url" placeholder="https://example.com" {...f.bind('website')} {...ro} /></Field>
        <Field label="GSTIN" error={f.errors.gstin} hint="Leave blank if not registered for GST"><Input {...f.bind('gstin')} {...ro} maxLength={15} className="uppercase" /></Field>
        <Field label="PAN" error={f.errors.pan} hint="Optional"><Input {...f.bind('pan')} {...ro} maxLength={10} className="uppercase" /></Field>
      </fieldset>
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-semibold text-slate-900">Contact and address</legend>
        <Field label="Business email" error={f.errors.email}><Input type="email" {...f.bind('email')} {...ro} /></Field>
        <Field label="Business phone number" error={f.errors.phone}><Input type="tel" {...f.bind('phone')} {...ro} /></Field>
        <Field label="Registered address" error={f.errors.address} className="sm:col-span-2"><Textarea {...f.bind('address')} {...ro} maxLength={400} /></Field>
        <Field label="City" error={f.errors.city}><Input {...f.bind('city')} {...ro} /></Field>
        <Field label="State" error={f.errors.state}><Input {...f.bind('state')} {...ro} /></Field>
        <Field label="Country" required error={f.errors.country}><Input {...f.bind('country')} {...ro} /></Field>
        <Field label="Postal code" error={f.errors.postalCode}><Input {...f.bind('postalCode')} {...ro} maxLength={12} /></Field>
      </fieldset>
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-sm font-semibold text-slate-900">Accounting preferences</legend>
        <Field label="Financial year starts on" required error={f.errors.fyStartMonth} hint="First day of the selected month">
          <Select {...f.bind('fyStartMonth')} {...ro}>{MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>1 {m}</option>)}</Select>
        </Field>
        <Field label="Base currency" required error={f.errors.baseCurrency} hint="Cannot be changed once accounting entries exist">
          <Select {...f.bind('baseCurrency')} {...ro}>
            {[...new Set([f.values.baseCurrency, ...CURRENCIES])].map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>
      </fieldset>
      {!readOnly && <div className="flex justify-end"><Button type="submit" loading={busy}>{submitLabel}</Button></div>}
    </form>
  );
}
