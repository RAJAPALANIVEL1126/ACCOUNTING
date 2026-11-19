import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ImageUp } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useSubmit } from '../lib/hooks';
import { formatDateTime } from '../lib/format';
import { Button, Card, CardHeader, ErrorState, Loading, PageHeader } from '../components/ui';
import { CompanyForm, companyValues } from '../components/CompanyForm';

export default function Company() {
  const { can, refresh } = useAuth();
  const canManage = can('company.manage');
  const q = useQuery({ queryKey: ['company'], queryFn: async () => (await api.get<Record<string, unknown>>('/company')).data });
  const save = useSubmit();
  const logo = useSubmit();
  const fileRef = useRef<HTMLInputElement>(null);
  const [logoVersion, setLogoVersion] = useState(0);

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data;
  const hasLogo = Boolean(c.logoAttachmentId);

  const onFile = (file: File | undefined) => {
    if (!file) return;
    void logo.run(() => api.upload('/company/logo', file), { success: 'Logo updated', onDone: () => { setLogoVersion((v) => v + 1); void refresh(); } });
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <>
      <PageHeader title="Company Details" description={canManage ? 'Legal identity, contact details and accounting preferences used on invoices and reports.' : 'You have read-only access to the company profile.'} />
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <Card className="p-5 sm:p-6">
          <CompanyForm
            key={String(c.updatedAt)}
            initial={companyValues(c)}
            submitLabel="Save changes"
            readOnly={!canManage}
            busy={save.busy}
            onSubmit={(values, setErrors) => save.run(() => api.patch('/company', values), { success: 'Company details saved', setErrors, onDone: () => { void refresh(); } })}
          />
        </Card>
        <div className="space-y-5">
          <Card>
            <CardHeader title="Company logo" description="PNG, JPEG or WebP, up to 4 MB. Shown on invoices." />
            <div className="p-5">
              <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-slate-300 bg-slate-50">
                {hasLogo ? <img src={`/api/company/logo?v=${String(c.logoAttachmentId)}-${logoVersion}`} alt="Company logo" className="max-h-28 max-w-full object-contain" /> : <span className="text-sm text-slate-400">No logo uploaded</span>}
              </div>
              {canManage && (
                <>
                  <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Choose logo file" onChange={(e) => onFile(e.target.files?.[0])} />
                  <Button variant="secondary" className="mt-3 w-full" loading={logo.busy} icon={<ImageUp className="h-4 w-4" />} onClick={() => fileRef.current?.click()}>{hasLogo ? 'Replace logo' : 'Upload logo'}</Button>
                </>
              )}
            </div>
          </Card>
          <Card className="p-5 text-sm text-slate-600">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Last updated</p>
            <p className="mt-1">{formatDateTime(String(c.updatedAt))}</p>
            <p className="mt-3 text-xs text-slate-500">Changes to company details are recorded in the audit log.</p>
          </Card>
        </div>
      </div>
    </>
  );
}
