# start-prod-local.ps1 — run the API (dev, on the LOCAL db) + the WEB as a
# PRODUCTION build (next start). The web prod build is pre-compiled + minified,
# so there is NO per-page dev compile — every page is fast on first hit. This is
# the real CLIENT experience. Build first:  pnpm --filter @emapp/web build
#
#   powershell -ExecutionPolicy Bypass -File .\start-prod-local.ps1
#
# Local-only helper — do NOT commit (holds the local DB password).
param([switch]$Inner)

if ($Inner) {
  # INSIDE `infisical run` — pin local-db + dev secrets AFTER injection.
  $env:DB_TARGET = 'local'
  $env:LOCAL_DATABASE_URL = 'postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable'
  $env:DEV_AUTH_BYPASS = '1'
  $env:DOC_ENCRYPTION_KEY = 'cF/Xa/6D36fUnplXsErk7ycpGXgp3a15NyncXxWVazg='
  # The web proxy forwards /api/v1/* to this backend (the local-db API on :3000).
  $env:API_BACKEND_URL = 'http://localhost:3000'
  # API in dev mode (compiles once at boot; its responses are already ~ms-fast).
  Start-Process powershell -ArgumentList '-NoProfile', '-Command', 'pnpm --filter @emapp/api dev' -WindowStyle Hidden
  # WEB as a production build — next start serves the pre-built .next on :3001.
  pnpm --filter @emapp/web start
}
else {
  infisical run --env dev -- powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Inner
}
