import type { Contractor } from '@emapp/shared-types';

// Offline SAMPLE_CONTRACTORS — the `GET /contractors` list + `/contractors/:id`
// surface in MSW mode. Several rows with VARIED specialties so the data-derived
// specialty facet chips + the name search are exercisable offline (and at a
// glance demonstrate the "findable at scale" UX). Schema-parsed by the
// samples.spec drift gate (ContractorSchema). NOT real customers.
export const SAMPLE_CONTRACTORS: Contractor[] = [
  {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc01',
    organizationId: '22222222-2222-2222-2222-222222222222',
    name: 'אלקטרה בנייה',
    contactEmail: 'info@electra-build.dev',
    contactPhone: '03-5551001',
    companyId: '511111111',
    specialty: 'קבלן מבצע',
    notes: null,
    createdAt: new Date('2026-05-01T10:00:00Z'),
    updatedAt: new Date('2026-05-01T10:00:00Z'),
    archivedAt: null,
  },
  {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc02',
    organizationId: '22222222-2222-2222-2222-222222222222',
    name: 'משרד אדריכלים כהן ושות׳',
    contactEmail: 'studio@cohen-arch.dev',
    contactPhone: '09-7772002',
    companyId: '512222222',
    specialty: 'אדריכלות',
    notes: null,
    createdAt: new Date('2026-05-03T10:00:00Z'),
    updatedAt: new Date('2026-05-03T10:00:00Z'),
    archivedAt: null,
  },
  {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc03',
    organizationId: '22222222-2222-2222-2222-222222222222',
    name: 'עו״ד לוי — ליווי התחדשות',
    contactEmail: 'office@levi-law.dev',
    contactPhone: '02-6663003',
    companyId: null,
    specialty: 'ליווי משפטי',
    notes: 'מלווה את מתחם הרצל 12.',
    createdAt: new Date('2026-05-06T10:00:00Z'),
    updatedAt: new Date('2026-05-06T10:00:00Z'),
    archivedAt: null,
  },
  {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc04',
    organizationId: '22222222-2222-2222-2222-222222222222',
    name: 'חשמל-טק שירותי חשמל',
    contactEmail: 'service@hashmaltech.dev',
    contactPhone: '04-8884004',
    companyId: '513333333',
    specialty: 'חשמל',
    notes: null,
    createdAt: new Date('2026-05-09T10:00:00Z'),
    updatedAt: new Date('2026-05-09T10:00:00Z'),
    archivedAt: null,
  },
  {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccc05',
    organizationId: '22222222-2222-2222-2222-222222222222',
    name: 'שמאי מקרקעין דוד אבני',
    contactEmail: 'david@avni-appraisal.dev',
    contactPhone: '03-5555005',
    companyId: null,
    specialty: 'שמאות מקרקעין',
    notes: null,
    createdAt: new Date('2026-05-12T10:00:00Z'),
    updatedAt: new Date('2026-05-12T10:00:00Z'),
    archivedAt: null,
  },
];

/** The data-derived specialty facet the live BE computes (DISTINCT non-null
 *  specialties across active contractors, Hebrew-collated). Mirrored here so the
 *  MSW list handler returns the SAME `facets.specialties` shape the FE expects. */
export const SAMPLE_CONTRACTOR_SPECIALTIES: string[] = Array.from(
  new Set(SAMPLE_CONTRACTORS.map((c) => c.specialty).filter((s): s is string => s !== null)),
).sort((a, b) => a.localeCompare(b, 'he'));
