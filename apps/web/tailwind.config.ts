/**
 * EMAPP partner design tokens ported from
 * `MEAPP_design/design_handoff/source/tokens.css` (canonical per
 * `docs/MEAPP_DESIGN_INDEX.md`). Landed in A.S1 PR-1 (V11 canary,
 * Track A). Companion: `src/app/globals.css` (semantic CSS vars +
 * `.btn`/`.card`/`.badge`/`.tbl` component classes).
 *
 * Layering rules (locked 2026-05-27):
 *   1. Existing shadcn HSL aliases (`background`/`foreground`/
 *      `muted`/`primary`/`border`) stay UNCHANGED — `components/ui/*`
 *      depends on them.
 *   2. Partner palette (`navy`/`ink`/`success`/`warning`/`danger`)
 *      is ADDITIVE — exposes Tailwind utilities like `bg-navy-900`
 *      alongside the shadcn aliases.
 *   3. `borderRadius` and `boxShadow` differ from Tailwind defaults
 *      (partner: 6/8/12/16/20 vs Tailwind 4/6/8/12/16; partner
 *      shadows use ink rgba(15,23,42,*) not black). Mapped here so
 *      Tailwind utilities resolve to partner values.
 *   4. Heebo at 3 weights (400/500/700) per PR #47 LCP gain. Loaded
 *      via next/font in `[locale]/layout.tsx`; this config only
 *      references `var(--font-heebo)`.
 */
import type { Config } from 'tailwindcss';
import rtl from 'tailwindcss-rtl';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  // Partner component-class API from tokens.css §Components — ported
  // into `globals.css` under @layer components. Without this safelist
  // Tailwind tree-shakes the rules because no source file references
  // them YET (first consumer is A.S1 PR-2 Login reskin). Listed
  // explicitly so the API is delivered on PR-1 merge and reskins
  // A.S2..A.S15 can rely on it.
  safelist: [
    'btn',
    'btn-primary',
    'btn-secondary',
    'btn-ghost',
    'btn-danger',
    'btn-sm',
    'btn-lg',
    'btn-icon',
    'card',
    'card-pad',
    'card-hd',
    'badge',
    'badge-dot',
    'badge-success',
    'badge-warning',
    'badge-danger',
    'badge-neutral',
    'badge-info',
    'input',
    'label',
    'kbd',
    'divider',
    'progress',
    'tbl',
    'avatar',
    'avatar-lg',
    'avatar-xl',
    'row',
    'col',
    'muted',
    'soft',
    'tabular',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-heebo)', 'Assistant', 'system-ui', 'sans-serif'],
      },
      colors: {
        // shadcn aliases — UNCHANGED.
        border: 'hsl(var(--border))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        // Partner palette — ADDITIVE.
        navy: {
          50: '#F2F6FB',
          100: '#E6EDF7',
          500: '#4A6FA5',
          600: '#2B4A7C',
          700: '#1E3A5F',
          800: '#13315C',
          900: '#0B2545',
        },
        ink: {
          50: '#F8FAFC',
          100: '#F1F5F9',
          200: '#E2E8F0',
          300: '#CBD5E1',
          400: '#94A3B8',
          500: '#64748B',
          600: '#475569',
          700: '#334155',
          800: '#1E293B',
          900: '#0F172A',
        },
        success: {
          50: '#F0FDF4',
          100: '#DCFCE7',
          600: '#16A34A',
          700: '#15803D',
        },
        warning: {
          50: '#FFFBEB',
          100: '#FEF3C7',
          600: '#D97706',
          700: '#B45309',
        },
        danger: {
          50: '#FEF2F2',
          100: '#FEE2E2',
          600: '#DC2626',
          700: '#B91C1C',
        },
      },
      borderRadius: {
        sm: '6px',
        md: '8px',
        lg: 'var(--radius)',
        xl: '16px',
        '2xl': '20px',
      },
      boxShadow: {
        xs: '0 1px 2px rgba(15,23,42,.04)',
        sm: '0 1px 2px rgba(15,23,42,.04), 0 1px 3px rgba(15,23,42,.06)',
        md: '0 4px 12px rgba(15,23,42,.06), 0 2px 4px rgba(15,23,42,.04)',
        lg: '0 12px 32px rgba(15,23,42,.10), 0 4px 12px rgba(15,23,42,.06)',
        xl: '0 24px 48px rgba(15,23,42,.14), 0 8px 16px rgba(15,23,42,.08)',
      },
      keyframes: {
        fadeIn: { from: { opacity: '0' }, to: { opacity: '1' } },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'none' },
        },
        slideInLeft: {
          from: { opacity: '0', transform: 'translateX(-100%)' },
          to: { opacity: '1', transform: 'none' },
        },
        slideInRight: {
          from: { opacity: '0', transform: 'translateX(100%)' },
          to: { opacity: '1', transform: 'none' },
        },
        scaleIn: {
          from: { opacity: '0', transform: 'scale(.96)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fadeIn .18s ease-out',
        'slide-up': 'slideUp .22s ease-out',
        'slide-in-left': 'slideInLeft .22s ease-out',
        'slide-in-right': 'slideInRight .22s ease-out',
        'scale-in': 'scaleIn .18s ease-out',
      },
    },
  },
  plugins: [rtl],
};

export default config;
