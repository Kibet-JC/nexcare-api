# NexCare — Compliance

> Internal-facing document. Describes how NexCare meets Kenyan legal and regulatory obligations as a Health Information Management System (HIMS) / Electronic Health Record (EHR) operating in the Republic of Kenya.
>
> **This document is a working draft prepared by the engineering team. Before any module processes real patient data in production, the controller and engineering lead must have it reviewed by qualified Kenyan health-IT and data-protection counsel and confirm registration status with the Office of the Data Protection Commissioner (ODPC).**

---

## 1. Identity of the data controller

| Field | Value |
|---|---|
| Legal name | _TODO: register / confirm legal entity (e.g., "NexCare Health Ltd")_ |
| Registered office | _TODO: physical address in Kenya_ |
| Principal contact | Kibet, Clinical Officer (Lead Clinician) |
| Email | kibet@jeremiahchebii.net |
| ODPC registration number | _TODO: register as a data controller under KDPA, then record number here_ |
| Designated Data Protection Officer (DPO) | _TODO: appoint DPO; record name, email, phone_ |

A DPO appointment is appropriate given that NexCare's core processing is large-scale processing of sensitive personal data (health data), per the Kenya Data Protection Act, 2019.

---

## 2. Regulatory framework NexCare operates under

| Instrument | Why it applies |
|---|---|
| Constitution of Kenya, 2010 — Article 31 (right to privacy) | Foundational right; patients' health data falls under the right to privacy |
| Data Protection Act, 2019 (KDPA) | Primary data protection statute; health data is "sensitive personal data" |
| Data Protection (General) Regulations, 2021 | Operationalizes KDPA; covers consent, retention, transfers |
| Data Protection (Registration of Data Controllers and Data Processors) Regulations, 2021 | Mandates ODPC registration |
| Data Protection (Complaints Handling and Enforcement Procedures) Regulations, 2021 | Sets out how complaints reach the ODPC |
| Health Act, 2017 | Governs the health sector; establishes patient confidentiality and rights to access health records |
| Clinical Officers Act, Cap. 260 (and COC standards) | Professional regulation of the lead clinician |
| Social Health Authority Act, 2023 (SHIF) | Health financing — relevant if NexCare integrates with SHA for member verification or claims |
| Computer Misuse and Cybercrimes Act, 2018 | Sets out unauthorized access, interception, and breach offences |
| HL7 FHIR R4 and DHIS2 standards (technical, not statute) | Interoperability and reporting alignment with the Kenya Health Information System |

---

## 3. Lawful bases for processing

NexCare processes personal data — including sensitive health data — under the following lawful bases (KDPA s. 30 and s. 45):

| Processing activity | Lawful basis | Notes |
|---|---|---|
| Booking appointments, scheduling | Performance of a service requested by the patient (s. 30(1)(b)) | Patient initiates the booking |
| Maintaining clinical records (history, encounters, prescriptions, results) | Provision of healthcare services (s. 45(1)(a)) | Health-data exemption to the prohibition on processing sensitive personal data |
| Billing and claims (cash, SHA, private insurance) | Performance of a contract; legal obligation | Tax / regulatory record-keeping |
| Audit logs, security monitoring | Legitimate interests of the controller; legal obligation | Required by KDPA accountability principles |
| Marketing communications (newsletters, health campaigns) | Explicit, opt-in consent | Patient may withdraw at any time |
| AI-assisted clinical note summarization | Provision of healthcare services + transparency notice; clinician remains decision-maker | Outputs are clinician-reviewed, not autonomous decisions |

---

## 4. Sensitive personal data (health data)

Health data is "sensitive personal data" under KDPA s. 2 and is subject to s. 44–46. NexCare:

- Processes only health data **necessary** for clinical care, billing, and statutory reporting (data minimization).
- Restricts access via role-based access control (`patient`, `clinician`, `admin`) and the principle of least privilege.
- Logs every read and write of health data in an append-only audit trail.
- Encrypts health data at rest (database-level + disk-level) and in transit (TLS 1.2+).

---

## 5. Data Protection Impact Assessment (DPIA)

A DPIA is required under KDPA s. 31 for processing that is likely to result in a high risk to the rights and freedoms of data subjects. Large-scale processing of health data meets this threshold.

| DPIA milestone | Status |
|---|---|
| Initial DPIA before first patient go-live | _TODO: schedule before Phase 2 deployment_ |
| Periodic DPIA review | Annually, and on any material processing change |
| ODPC consultation if residual high risk remains | As required by KDPA s. 31(7) |

---

## 6. Records of Processing Activities (RoPA)

NexCare maintains a Record of Processing Activities per KDPA s. 24, including:

- Categories of data subjects and personal data
- Purposes of processing and lawful bases
- Recipients and sub-processors
- Cross-border transfers and safeguards
- Retention periods
- Technical and organizational security measures

The RoPA is reviewed at least annually and on any material change. _TODO: maintain `RoPA.md` (or equivalent) alongside this document._

---

## 7. Sub-processors

NexCare uses the following third-party processors. Each processor is bound by a Data Processing Agreement (DPA) consistent with KDPA s. 41 and Reg. 17.

| Sub-processor | Service | Data category | Region | DPA in place |
|---|---|---|---|---|
| Vercel | Frontend hosting | Non-PHI marketing site, session metadata | US / global edge | _TODO: execute DPA; assess KDPA s. 48 transfer safeguards_ |
| Railway | Backend + Postgres hosting | Sensitive personal data (health) | _TODO: confirm region; prefer EU/regional region with adequacy or SCCs_ | _TODO_ |
| Anthropic (Claude API) | Server-side LLM for clinical note summarization | Sensitive personal data sent only with patient transparency notice; no model training opt-in | US | _TODO: review Anthropic DPA, confirm zero data retention / no training settings_ |
| GitHub | Source control, issues, CI | No patient data; engineering metadata only | US | Standard ToS |
| _TODO_ Backup provider | Encrypted database backups | Sensitive personal data | _TODO_ | _TODO_ |

---

## 8. Cross-border data transfers (KDPA s. 48)

Where NexCare transfers personal data outside Kenya, it relies on at least one of the following:

- Adequacy decision by the ODPC
- Appropriate safeguards (e.g., contractual clauses, binding corporate rules)
- Explicit consent of the data subject after being informed of the risks
- Necessity for the performance of a contract or for the establishment, exercise, or defence of a legal claim

The transfer mechanism for each sub-processor is documented in the RoPA.

---

## 9. Retention

| Data category | Retention period | Basis |
|---|---|---|
| Adult patient clinical records | _TODO: confirm with COC / Ministry of Health guidance — commonly retained for the patient's lifetime or a defined minimum after last contact_ | Health Act, professional standards |
| Paediatric clinical records | Until the patient attains the age of majority + the adult retention period | Common clinical-records practice |
| Appointment metadata (no clinical detail) | 24 months | Operational |
| Billing and tax records | 7 years | Tax laws of Kenya |
| Audit logs | 7 years minimum, archived thereafter | Forensic and regulatory |
| Marketing consent records | For the duration of the relationship + 3 years | Demonstrate consent on request |
| Backup snapshots | 30 days hot, _TODO_ cold | Operational + DR |

After retention expires, data is securely deleted or fully anonymized. Anonymization must be irreversible to fall outside the scope of personal data.

---

## 10. Patient (data subject) rights

NexCare honours the data subject rights set out in KDPA s. 26:

- Right to be informed of the use of their data
- Right of access to their data
- Right to object to processing
- Right to correction or deletion of false or misleading data
- Right of portability

The patient-facing process for exercising these rights is documented in `PRIVACY.md`. Requests are actioned within the timelines required by the KDPA and its regulations.

---

## 11. Breach notification

| Step | Timeline | Responsible |
|---|---|---|
| Internal breach detection / report | Immediately on discovery | Any team member; routed to DPO |
| Severity assessment | Within 24 hours | DPO + engineering lead |
| Notification to the ODPC (where notification thresholds are met) | Without undue delay, and where feasible within the timelines required by the KDPA and regulations | DPO |
| Notification to affected data subjects (where high risk) | Without undue delay | DPO + lead clinician |
| Post-incident review | Within 14 days of containment | Engineering lead |

The full incident response playbook lives in `SECURITY.md`.

---

## 12. Security controls (summary)

A NexCare module is patient-ready only when **all** of the following are in place:

- [ ] Authentication and role-based access control (`patient`, `clinician`, `admin`)
- [ ] Append-only audit log capturing actor, action, resource, timestamp, IP
- [ ] TLS 1.2+ in transit; encryption at rest for the database and backups
- [ ] Automated daily backups with a tested restore procedure
- [ ] Secrets stored in env / secret manager — never in source control
- [ ] Dependency audit clean (`npm audit`, equivalent for other ecosystems)
- [ ] Basic security review against OWASP ASVS L1
- [ ] Clinical workflow walkthrough completed and signed off by the lead clinician

These gates are tracked per module in the corresponding GitHub repo.

---

## 13. Document maintenance

| Owner | Review cadence | Trigger reviews |
|---|---|---|
| DPO + engineering lead | Quarterly | New module, new sub-processor, regulatory change, breach |

Last reviewed: _TODO_
Next review due: _TODO_
