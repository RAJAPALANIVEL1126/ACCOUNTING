import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { CalendarDays } from 'lucide-react';
import { isIsoDate, presetRange, PRESETS, todayIso } from '../lib/dates';
import type { DateRange, PresetKey } from '../lib/dates';
import { formatDate } from '../lib/format';
import { useAuth } from '../lib/auth';
import { Input, Select } from './ui';

interface RangeState { preset: PresetKey; range: DateRange; setPreset: (p: PresetKey) => void; setCustom: (r: DateRange) => void }
const RangeContext = createContext<RangeState | null>(null);

/** One shared reporting period for the whole app, so the dashboard, lists and reports stay in step. */
export function DateRangeProvider({ children }: { children: ReactNode }) {
  const { fyStartMonth } = useAuth();
  const [preset, setPresetKey] = useState<PresetKey>('last30');
  const [custom, setCustomRange] = useState<DateRange>(() => presetRange('thisMonth', fyStartMonth));
  const value = useMemo<RangeState>(() => ({
    preset,
    range: preset === 'custom' ? custom : presetRange(preset, fyStartMonth),
    setPreset: (p) => {
      if (p === 'custom') setCustomRange(preset === 'custom' ? custom : presetRange(preset, fyStartMonth));
      setPresetKey(p);
    },
    setCustom: (r) => { setCustomRange(r); setPresetKey('custom'); },
  }), [preset, custom, fyStartMonth]);
  return <RangeContext.Provider value={value}>{children}</RangeContext.Provider>;
}

export function useDateRange(): RangeState {
  const v = useContext(RangeContext);
  if (!v) throw new Error('useDateRange must be used inside <DateRangeProvider>');
  return v;
}

export function DateRangePicker() {
  const { preset, range, setPreset, setCustom } = useDateRange();
  const today = todayIso();
  const invalid = preset === 'custom' && range.from > range.to;
  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <div className="relative">
        <CalendarDays className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <Select aria-label="Date range" className="w-auto pl-8" value={preset} onChange={(e) => setPreset(e.target.value as PresetKey)}>
          {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </Select>
      </div>
      {preset === 'custom' ? (
        <div className="flex items-center gap-1.5">
          <Input type="date" aria-label="From date" className="w-auto" max={today} value={range.from} invalid={invalid} onChange={(e) => isIsoDate(e.target.value) && setCustom({ from: e.target.value, to: range.to < e.target.value ? e.target.value : range.to })} />
          <span className="text-sm text-slate-400">to</span>
          <Input type="date" aria-label="To date" className="w-auto" min={range.from} value={range.to} invalid={invalid} onChange={(e) => isIsoDate(e.target.value) && setCustom({ from: range.from, to: e.target.value })} />
        </div>
      ) : (
        <span className="text-sm text-slate-500">{range.from === range.to ? formatDate(range.from) : `${formatDate(range.from)} – ${formatDate(range.to)}`}</span>
      )}
    </div>
  );
}
