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
 *
 * CANONICAL COLOR SOURCE (P1-2): `src/app/globals.css` `:root` is the
 * single source of truth for color. The raw-hex `navy`/`ink`/`success`/
 * `warning`/`danger` values below DUPLICATE the `--navy-*`/`--ink-*`/…
 * CSS vars in globals.css and MUST be kept in lock-step until this side
 * is rebased onto `hsl(var(--…))` refs (incremental Phase-10 work, see
 * docs/ARCHITECTURE-fe-design-tokens.md). Components must use these
 * tokens/utilities, never new inline hex/hsl — enforced by
 * `src/app-no-new-inline-colors.spec.ts`.
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
        // ── TIER 2: SEMANTIC color mappings (E2.0, visual-system §3.3) ──
        // Components author in Tailwind but every utility resolves to a
        // Tier-2 token (var(--…)) — never a raw hex, never a default
        // palette class. Re-skin = edit globals.css Tier 1. `card` fixes
        // the dead `bg-card` (64 sites had no backing token).
        brand: {
          DEFAULT: 'var(--brand)',
          hover: 'var(--brand-hover)',
          fg: 'var(--brand-fg)',
        },
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-fg)',
        },
        surface: {
          DEFAULT: 'var(--surface)',
          raised: 'var(--surface-raised)',
          subtle: 'var(--surface-subtle)',
          app: 'var(--surface-app)',
          hover: 'var(--surface-hover)',
        },
        text: {
          DEFAULT: 'var(--text)',
          muted: 'var(--text-muted)',
          soft: 'var(--text-soft)',
        },
        status: {
          'success-bg': 'var(--status-success-bg)',
          'success-fg': 'var(--status-success-fg)',
          'warning-bg': 'var(--status-warning-bg)',
          'warning-fg': 'var(--status-warning-fg)',
          'danger-bg': 'var(--status-danger-bg)',
          'danger-fg': 'var(--status-danger-fg)',
          'info-bg': 'var(--status-info-bg)',
          'info-fg': 'var(--status-info-fg)',
          'neutral-bg': 'var(--status-neutral-bg)',
          'neutral-fg': 'var(--status-neutral-fg)',
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
      // Spacing scale — NEW (E2.0, visual-system §2.4). Maps the numeric
      // keys onto the --space-* Tier-1 tokens so `p-4`/`gap-6`/`space-y-8`
      // are tokenized (and `p-card` uses the semantic card padding). These
      // KEEP the same px values Tailwind's defaults had (4/8/12/16/…), so
      // every existing `p-4`/`gap-3` renders identically — zero regression.
      spacing: {
        1: 'var(--space-1)',
        2: 'var(--space-2)',
        3: 'var(--space-3)',
        4: 'var(--space-4)',
        5: 'var(--space-5)',
        6: 'var(--space-6)',
        8: 'var(--space-8)',
        10: 'var(--space-10)',
        12: 'var(--space-12)',
        card: 'var(--space-card)',
      },
      // Type scale — NEW (E2.0, visual-system §2.2). [size, { lineHeight }].
      fontSize: {
        display: ['var(--text-display-size)', { lineHeight: 'var(--text-display-lh)' }],
        h1: ['var(--text-h1-size)', { lineHeight: 'var(--text-h1-lh)' }],
        h2: ['var(--text-h2-size)', { lineHeight: 'var(--text-h2-lh)' }],
        h3: ['var(--text-h3-size)', { lineHeight: 'var(--text-h3-lh)' }],
        body: ['var(--text-body-size)', { lineHeight: 'var(--text-body-lh)' }],
        label: ['var(--text-label-size)', { lineHeight: 'var(--text-label-lh)' }],
        caption: ['var(--text-caption-size)', { lineHeight: 'var(--text-caption-lh)' }],
      },
      fontWeight: {
        regular: 'var(--weight-regular)',
        medium: 'var(--weight-medium)',
        bold: 'var(--weight-bold)',
      },
      borderRadius: {
        sm: 'var(--r-sm)',
        md: 'var(--r-md)',
        // FIX (E2.0): `lg` previously mapped to `var(--radius)` (shadcn
        // 0.5rem = 8px) while `--r-lg` is 12px — a silent mismatch
        // (visual-system §1.3). Reconciled to the partner --r-lg (12px),
        // the intended card radius (§2.5). `.card` in globals.css already
        // uses var(--r-lg); now `rounded-lg` agrees with it.
        lg: 'var(--r-lg)',
        xl: 'var(--r-xl)',
        '2xl': 'var(--r-2xl)',
        // semantic radius aliases (Tier 2).
        card: 'var(--radius-card)',
        control: 'var(--radius-control)',
        pill: 'var(--radius-pill)',
      },
      // Motion — NEW (E2 Wave-0 M1, visual-system §2.7). Maps the Tier-1
      // --motion-* tokens so components can author `duration-base
      // ease-out` instead of literal ms / cubic-bezier. ADDITIVE under
      // extend (Tailwind's numeric `duration-200` defaults stay intact).
      // The `prefers-reduced-motion` guard in globals.css zeroes the
      // duration tokens, so `duration-base` snaps under reduce for free.
      transitionDuration: {
        fast: 'var(--motion-duration-fast)',
        base: 'var(--motion-duration-base)',
        slow: 'var(--motion-duration-slow)',
      },
      transitionTimingFunction: {
        out: 'var(--motion-ease-out)',
        spring: 'var(--motion-ease-spring)',
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
