import { describe, it, expect } from 'vitest';
import { generateSync } from 'otplib';
import { getMonthYearLabel, FLATIRON_LABEL_PATTERNS } from '../approaches/flatiron/flatiron.config';

describe('Flatiron Config', () => {
  it('generates correct month/year label', () => {
    const date = new Date('2026-03-15');
    expect(getMonthYearLabel(date)).toBe('mar26');
  });

  it('generates correct label for December', () => {
    const date = new Date('2025-12-01');
    expect(getMonthYearLabel(date)).toBe('dec25');
  });

  it('generates correct patch label', () => {
    expect(FLATIRON_LABEL_PATTERNS.patch('mar26')).toBe('patch_mar26');
  });

  it('generates correct tempapp label', () => {
    expect(FLATIRON_LABEL_PATTERNS.tempapp('mar26')).toBe('tempapp_mar26');
  });

  it('generates correct internal defects label', () => {
    expect(FLATIRON_LABEL_PATTERNS.internalDefects('26')).toBe('nalashaa_26');
  });

  it('planned cycle label is static', () => {
    expect(FLATIRON_LABEL_PATTERNS.plannedCycle).toBe('Planned_cycle');
  });
});

describe('TOTP Generation', () => {
  it('generates a 6-digit TOTP code', () => {
    // Use a base32 secret that is >= 16 bytes decoded (26+ chars base32)
    const testSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const code = generateSync({ secret: testSecret });
    expect(code).toMatch(/^\d{6}$/);
  });
});
