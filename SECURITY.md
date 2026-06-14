# NexCare — Security

> Internal security policy and incident-response playbook for the NexCare HIMS/EHR. Reviewed by the engineering lead and the DPO. Read alongside `COMPLIANCE.md` and `PRIVACY.md`.

---

## 1. Reporting a vulnerability

If you believe you have found a security vulnerability in any NexCare service, please email **security@elarahealthcare.co.ke**.

- Please include: a description of the issue, steps to reproduce, the affected URL or component, and your name and contact details so we can follow up.
- We will acknowledge receipt within 2 business days and aim to provide a substantive response within 14 days.
- Please do not exploit the vulnerability beyond what is necessary to demonstrate it, do not access patient data, and do not publicly disclose the issue until we have had a reasonable opportunity to remediate it.

We do not currently run a paid bug-bounty programme. We will publicly credit good-faith researchers who follow this policy and ask to be named.

---

## 2. Scope

This policy covers all NexCare-operated services and repositories under the `Kibet-JC` and (future) `nexcare` GitHub organizations, including:

- Web frontends (`nexcare-landing`, `nexcare-web`)
- Backend APIs (`nexcare-api` and successors)
- Databases and backups managed by NexCare
- AI-integration endpoints

Out of scope: third-party platforms (Vercel, Railway, Anthropic, GitHub) — please report issues in those platforms to the relevant vendor.

---

## 3. Security controls

### 3.1 Authentication and access

- All clinician and admin access requires authentication.
- Role-based access control: `patient`, `clinician`, `admin` minimum; least privilege by default.
- Strong password policy + MFA for clinician and admin accounts (target by Phase 2 go-live).
- Session timeouts on inactivity; immediate session revocation on user disable.

### 3.2 Encryption

- TLS 1.2+ enforced for all external traffic; HSTS enabled.
- Database encryption at rest (managed by the database provider) and disk-level encryption for any backup storage.
- Secrets in environment variables or a secret manager — never in source control. Rotated on suspected exposure.

### 3.3 Audit logging

- Append-only audit log table records: actor, action, resource, timestamp, source IP, user agent.
- Logs are immutable from the application; archival only after the legal retention window.
- Periodic review of audit logs for anomalous access patterns.

### 3.4 Backups and recovery

- Automated daily database backups, encrypted, with 30-day hot retention.
- Restore procedure tested at least once before initial go-live and at least once per quarter thereafter.
- Recovery objectives:
  - **RPO** (data loss tolerance): _TODO: agree, e.g., 24 hours_
  - **RTO** (downtime tolerance): _TODO: agree, e.g., 4 hours for clinical workflows_

### 3.5 Dependency and code security

- `npm audit` (or equivalent) on every CI run; high/critical vulnerabilities block merges.
- Dependabot or Renovate for automated security updates.
- Branch protection on `main`; required PR reviews; CI must be green to merge.
- Static analysis and linting on every PR.

### 3.6 Application security baseline

- Target: OWASP ASVS Level 1 minimum at first patient go-live; ASVS Level 2 by end of Year 1.
- Input validation on every external boundary (server-side, never trust the client).
- Parameterized queries via Prisma — no raw SQL with user input.
- CSRF protection on state-changing endpoints; CORS allowlist.
- Content Security Policy and standard security headers on all web responses.
- Rate limiting on auth endpoints.

---

## 4. Incident response playbook

### 4.1 Severity levels

| Severity | Definition | Examples |
|---|---|---|
| **SEV-1** | Active confirmed breach of patient data, or service is down for all clinical workflows | Database leaked; API offline during clinic hours |
| **SEV-2** | Likely breach not yet confirmed, or partial outage of critical workflow | Suspicious bulk export from a clinician account; appointments module down |
| **SEV-3** | Security weakness without confirmed exploitation | Vulnerability disclosed by a researcher, no evidence of abuse |
| **SEV-4** | Minor issue, no patient impact | Lint regression in a security header |

### 4.2 Response steps

1. **Detect / receive report.** Triage within 1 hour of receipt during business hours, 4 hours otherwise.
2. **Assemble responders.** Engineering lead + DPO. Add the lead clinician for any SEV-1 or SEV-2 with patient impact.
3. **Contain.** Revoke compromised credentials; isolate affected systems; rotate secrets.
4. **Assess.** Identify what data, how many records, which patients. Preserve logs for forensic review.
5. **Notify.**
   - **ODPC:** notify without undue delay where the breach meets KDPA notification thresholds. Use the template in §4.4.
   - **Affected patients:** notify without undue delay where the breach is likely to result in high risk. Use plain language; explain what happened, what data was involved, what we are doing, and what they can do.
6. **Remediate.** Patch the root cause, not just the symptom.
7. **Post-incident review.** Within 14 days of containment. Document timeline, root cause, what worked, what did not, action items with owners and dates.

### 4.3 Notification thresholds (interpretation guide)

The KDPA requires notification of breaches that are "likely to result in risk to the rights and freedoms" of data subjects. As a rule of thumb for NexCare:

- Any unauthorized access to clinical records is notifiable.
- Loss of an unencrypted backup is notifiable.
- A vulnerability that exposed patient data, even without confirmed exploitation, is notifiable if exposure cannot be confidently ruled out.
- A vulnerability with no exposure of personal data is documented internally but is not externally notifiable.

When in doubt, notify. Confirm thresholds with counsel.

### 4.4 ODPC notification template

```
To: ODPC notification address
Subject: Personal data breach notification — NexCare — [reference]

1. Controller details
   - Legal name, registration number, contact

2. Nature of the breach
   - When it happened, when it was discovered
   - Categories and approximate number of data subjects affected
   - Categories and approximate number of records affected

3. Likely consequences

4. Measures taken or proposed to address the breach and mitigate harm

5. Contact point for further information (DPO)
```

### 4.5 Patient notification template

```
Dear [name],

We are writing to let you know about a security incident at NexCare that may
have affected your personal information.

What happened: [plain-language description]
What information was involved: [specific categories]
What we are doing: [containment, remediation]
What you can do: [practical steps, e.g., reset password, watch for phishing]

If you have any questions, please contact us at [email] / [phone].

We are sorry this happened. Protecting your information is one of our most
important responsibilities, and we are taking steps to make sure this does
not happen again.

Yours sincerely,
[DPO / Lead Clinician]
NexCare
```

---

## 5. Roles and responsibilities

| Role | Responsibility |
|---|---|
| Engineering lead | Day-to-day security; PR review; incident technical response |
| DPO | Privacy compliance; breach notifications; data subject requests |
| Lead clinician (Kibet) | Sign-off on patient-facing changes; clinical impact assessment in incidents |
| All team members | Report suspected security or privacy issues immediately |

---

## 6. Document maintenance

- Reviewed quarterly by the engineering lead and DPO.
- Reviewed after any SEV-1 or SEV-2 incident.

Last reviewed: 2026-05-29
Next review due: 2026-08-29
