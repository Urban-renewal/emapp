# Migration Playbook — Free Tier to Production

This document describes how to scale EMAPP from the MVP free-tier setup to
paid production tiers as the customer base grows. Keep this document updated
as the migration is executed under time pressure.

## The 4 Growth Stages

| Stage      | Size             | Monthly Cost | Key Changes                             |
| ---------- | ---------------- | ------------ | --------------------------------------- |
| **MVP**    | 0–3 orgs (pilot) | $0–6         | Everything on free tiers; Railway Hobby |
| **Launch** | 3–10 orgs        | $100–180     | Neon Launch; Resend Pro; Sentry Team    |
| **Growth** | 10–50 orgs       | $300–600     | + Upstash Redis; Railway Pro            |
| **Scale**  | 50–100+ orgs     | $500–1,000   | Neon Pro; Pusher; Datadog optional      |

---

## Stage 1 — MVP ($0–6/month)

### Current providers

| Provider         | Plan          | Limits                         |
| ---------------- | ------------- | ------------------------------ |
| Neon             | Free          | 0.5 GB storage, 1 compute unit |
| Railway          | Hobby ($5/mo) | $5 credit, then per-usage      |
| Cloudflare R2    | Free          | 10 GB storage, 10M reads/mo    |
| Cloudflare Pages | Free          | Unlimited builds + bandwidth   |
| Resend           | Free          | 3,000 emails/month             |
| Sentry           | Developer     | 5K errors/mo, 10K perf events  |

### Known limitations

- No Redis — `ICacheProvider` → `PostgresCacheProvider` (cache_kv table). Handles thousands of req/min.
- No real-time push — `IRealtimeProvider` → `SseRealtimeProvider` (Server-Sent Events). OK for notifications.
- SMS active from MVP — `ISMSProvider` → `IsraeliSMSProvider` (019/Inforu) for Tenant OTP. Dev uses `NoopSMSProvider`.

---

## Stage 2 — Launch ($100–180/month)

**Trigger**: Exiting pilot; 3+ paying orgs; need stronger SLAs.

### Steps

1. **Neon: Free → Launch ($19/mo)**
   - Dashboard → Project → Upgrade plan
   - No code change needed; same `DATABASE_URL` format
   - Now have: 10 GB, autoscaling, PITR 7 days

2. **Resend: Free → Pro ($20/mo)**
   - Dashboard → Billing → Upgrade
   - Verify `emapp.io` domain SPF/DKIM records
   - No code change

3. **Sentry: Developer → Team ($26/mo)**
   - Sentry dashboard → Organization → Billing
   - Set alert thresholds for error spike > 1%

4. **Domain + DNS (~$15/year)**
   - Register `emapp.io` (Cloudflare Registrar recommended)
   - Update `CORS_ORIGINS.production` in `apps/api/src/main.ts`
   - Update `NEXT_PUBLIC_API_URL` env var

### Code changes required

None — the interface layer (`ICacheProvider`, `ISMSProvider`, etc.) isolates providers from business logic.

---

## Stage 3 — Growth ($300–600/month)

**Trigger**: 10+ orgs; cache latency noticeable; need stronger monitoring.

### Steps

1. **+ Upstash Redis ($10–30/mo)**
   - Create Upstash account → new Redis database → copy `UPSTASH_REDIS_URL`
   - Change `providers.module.ts`: swap `PostgresCacheProvider` → `UpstashRedisCacheProvider`
   - Add `UPSTASH_REDIS_URL` to Infisical

2. **Railway: Hobby → Pro ($20/mo base)**
   - Dashboard → Usage → Upgrade
   - Enables private networking between BE and Worker services

3. **Sentry: Team → Business ($80/mo)**
   - For 200K errors/mo; advanced alert rules

### Code changes required

- `providers.module.ts`: swap `CacheProvider` implementation
- No other structural changes (interface layer holds)

---

## Stage 4 — Scale ($500–1,000/month)

**Trigger**: 50+ orgs; real-time features needed; storage > 30 GB.

### Steps

1. **Neon: Launch → Pro ($69/mo) or Business ($200+)**
   - Read replicas for analytics queries
   - Dedicated compute units

2. **+ Pusher / dedicated WebSocket ($50–100/mo)**
   - Replace `SseRealtimeProvider` → `PusherRealtimeProvider`
   - Required for real-time collaborative features

3. **Resend: Pro → Business ($80/mo)**
   - 200K emails/month

4. **Railway: Pro → Team ($50+)**
   - Multi-environment support; private networking

### Code changes required

- `providers.module.ts`: swap `RealtimeProvider` implementation
- `Pusher` SDK added to `apps/api/package.json`

---

## Rollback Procedures

All DB migrations are versioned via Drizzle Kit (`packages/db/migrations/`).

```bash
# Check current migration state
pnpm --filter @emapp/db db:generate  # dry-run, shows diff

# Rollback: create a down migration and apply
# (Drizzle Kit does not auto-generate rollback; write manually)
```

**Always back up Neon before any migration in production:**

1. Neon dashboard → Project → Branches → Create branch (point-in-time snapshot)
2. Run migration on `preview` branch first
3. Verify, then apply to `main` branch

---

## Secrets Management

All secrets live in Infisical. Rotate them here:

```bash
# Dev (local)
infisical run -- pnpm dev

# CI: uses GitHub Actions secrets (set in repo Settings → Secrets)
# Production: Railway reads from Infisical via Railway → Variables
```

Never commit `.env` with real values. `.env.example` contains placeholders only.
