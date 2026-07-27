import { describe, it, expect } from 'vitest';
import { applyRichMappings, parseDateWithFormat, type MappingEntry } from '../services/MappingEngine';

/**
 * Tier-3 QC-safe additive presets: codeMap, default, currency, divide, parseDate.
 * These exercise the new branches in computeValue via the public applyRichMappings path.
 */
function preset(sources: string[], destination: string, name: string, presetConfig?: Record<string, unknown>): MappingEntry {
  return {
    id: `m-${name}`,
    sources,
    destinations: [destination],
    srcTypes: sources.map(() => 'string'),
    destTypes: ['string'],
    transform: 'PRESET',
    preset: name,
    presetConfig,
    expression: '',
  };
}

describe('MappingEngine — QC-safe presets', () => {
  it('codeMap maps known codes and falls back to Unknown', () => {
    const m = preset(['emp_status'], 'Status', 'codeMap', { map: { A: 'Active', T: 'Terminated' }, default: 'Unknown' });
    expect(applyRichMappings({ emp_status: 'A' }, [m]).Status).toBe('Active');
    expect(applyRichMappings({ emp_status: 'Z' }, [m]).Status).toBe('Unknown');
  });

  it('default substitutes a value only when the source is empty/null', () => {
    const m = preset(['note'], 'Note', 'default', { value: 'N/A' });
    expect(applyRichMappings({ note: '' }, [m]).Note).toBe('N/A');
    expect(applyRichMappings({ note: 'hello' }, [m]).Note).toBe('hello');
  });

  it('currency converts at the configured rate', () => {
    const m = preset(['amount'], 'AmountInr', 'currency', { rate: 83.2, decimals: 2 });
    expect(applyRichMappings({ amount: 100 }, [m]).AmountInr).toBe(8320);
    expect(applyRichMappings({ amount: 'x' }, [m]).AmountInr).toBeNull();
  });

  it('divide handles the happy path and division-by-zero', () => {
    const m = preset(['leavers', 'headcount'], 'AttritionPct', 'divide', { multiplier: 100, decimals: 2 });
    expect(applyRichMappings({ leavers: 5, headcount: 100 }, [m]).AttritionPct).toBe(5);
    expect(applyRichMappings({ leavers: 5, headcount: 0 }, [m]).AttritionPct).toBeNull();
  });

  it('parseDate converts dd/MM/yyyy to ISO and rejects impossible dates', () => {
    const m = preset(['d'], 'IsoDate', 'parseDate', { format: 'dd/MM/yyyy' });
    expect(applyRichMappings({ d: '30/06/2026' }, [m]).IsoDate).toBe('2026-06-30');
    expect(applyRichMappings({ d: '30/02/2026' }, [m]).IsoDate).toBeNull();
    // helper directly
    expect(parseDateWithFormat('07/03/2026', 'dd/MM/yyyy')).toBe('2026-03-07');
    expect(parseDateWithFormat('2026-03-07', 'yyyy-MM-dd')).toBe('2026-03-07');
  });
});
