# Runbook — Uptime & Health Monitoring (H-5)

External uptime monitoring for the live NexCare API, and the triage path to
follow when it alerts. Written to be followable cold, with no prior context.

---

## What is monitored

| Setting | Value |
|---|---|
| Provider | **UptimeRobot** (free tier) |
| Type | HTTP(S) monitor |
| URL | `https://nexcare-api-production.up.railway.app/api/v1/health` |
| Method | `GET`, expects `200` |
| Keyword check | None (free tier — status code only) |
| Interval | **Every 5 minutes** |
| Alert channel | **Email to the owner** |

`GET /api/v1/health` is unauthenticated by design and returns no patient data, so
the monitor never needs a token and never touches PHI. A passing check means the
container is up, serving HTTP, and its health probe is green.

To confirm manually:

```bash
curl -i https://nexcare-api-production.up.railway.app/api/v1/health
# Expect: HTTP/2 200  and a JSON body with "status":"ok"
```

---

## When the monitor alerts (DOWN) — triage

Work top to bottom. Stop at the first step that explains the outage.

### 0. Confirm it's real (30 seconds)

```bash
curl -i --max-time 10 https://nexcare-api-production.up.railway.app/api/v1/health
```

- `200` with `"status":"ok"` → likely a transient blip or a monitor-side false
  alarm. Note it and move on.
- Timeout, `5xx`, or connection refused → real outage, continue.

### 1. Check Railway deploy logs first

Railway dashboard → project → **nexcare-api** service → **Deployments** / **Logs**.

- Is the latest deploy **crashed / restarting**? Read the crash log. A boot-time
  Zod env-validation failure or a failed `pnpm prisma migrate deploy` (the
  preDeploy step) will crash the container before it serves — the log names the
  bad variable or migration.
- Is a deploy **in progress**? Health flaps during rollout; wait for it to finish.
- If the last good deploy crashed on a new release → **roll back** to the previous
  successful deployment in Railway, then fix forward.

### 2. Check the Postgres database service

Railway dashboard → the **Postgres** service.

- Is the DB service **up**? If it's down or restarting, the API's health check and
  migrations fail even though the app image is fine.
- Check DB resource limits (storage full / connection cap). Restart the Postgres
  service if it is wedged, then watch the API recover.

### 3. Check recent merges to `main`

Railway deploys from `main`, so a recent merge is the usual root cause of a
fresh outage.

```bash
git -C ~/nexcare-api log --oneline -10 origin/main
```

- Correlate the outage start time with the latest merge. If a recent PR caused it,
  roll back the Railway deploy (step 1) and open a fix branch.
- Check the PR's CI status:

```bash
gh pr list --state merged --limit 5
gh run list --branch main --limit 5
```

### Escalate / record

- If steps 1–3 don't explain it, the outage is likely platform-side (Railway
  region incident) — check Railway's status page and wait it out.
- Once resolved, note the cause and recovery time in the operational log so the
  next on-call sees the pattern.
