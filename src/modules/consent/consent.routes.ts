// Consent HTTP routes — mounted at /api/v1/patients/:patientId/consents
// (see src/app.ts). The router uses { mergeParams: true } so it can read the
// parent route's :patientId param.
//
// The router is deliberately thin: each route validates its input via the
// `validate` middleware, then delegates to the service layer. Express 5 awaits
// async handlers and forwards rejections to the terminal error handler, so a
// service's thrown HttpProblem becomes an RFC 7807 response without try/catch.
//
// Access control (#12): `authenticate` is applied at the router mount in
// src/app.ts, so every route below already has an authenticated `req.user`.
// Per-route `requireRole(...)` then enforces the policy: recording a consent is
// front-desk + clinical (ADMIN/CLINICIAN/RECEPTIONIST); reading is open to any
// authenticated role; revoking — a consequential, audited act — is restricted
// to ADMIN/CLINICIAN.
import { Router } from 'express';
import { validate } from '../../lib/validate.js';
import { requireRole } from '../../middleware/authorize.js';
import {
  consentIdParamSchema,
  createConsentSchema,
  patientIdParamSchema,
} from './consent.schema.js';
import {
  listConsentsForPatient,
  recordConsent,
  revokeConsent,
} from './consent.service.js';

// mergeParams so :patientId from the parent /patients/:patientId mount is visible.
export const consentRouter: Router = Router({ mergeParams: true });

// Record a patient's consent. Front-desk and clinical staff may capture consent.
consentRouter.post(
  '/',
  requireRole('ADMIN', 'CLINICIAN', 'RECEPTIONIST'),
  validate(patientIdParamSchema, 'params'),
  validate(createConsentSchema, 'body'),
  async (req, res) => {
    const { patientId } = req.params as { patientId: string };
    // authenticate (#12) guarantees req.user here; requireRole already ran.
    const actorId = req.user!.id;
    const consent = await recordConsent(patientId, actorId, req.body);
    // Expose the new id so the global audit middleware records entityId (#8).
    res.locals.auditEntityId = consent.id;
    res.status(201).json(consent);
  },
);

// List a patient's consent records. Any authenticated role may read.
consentRouter.get(
  '/',
  validate(patientIdParamSchema, 'params'),
  async (req, res) => {
    const { patientId } = req.params as { patientId: string };
    const consents = await listConsentsForPatient(patientId);
    res.status(200).json(consents);
  },
);

// Revoke a consent. Restricted to ADMIN/CLINICIAN — a consequential clinical/
// compliance action. Idempotent-safe in the service.
consentRouter.post(
  '/:consentId/revoke',
  requireRole('ADMIN', 'CLINICIAN'),
  validate(consentIdParamSchema, 'params'),
  async (req, res) => {
    const { patientId, consentId } = req.params as {
      patientId: string;
      consentId: string;
    };
    const actorId = req.user!.id;
    const consent = await revokeConsent(patientId, consentId, actorId);
    // The mutation targets the consent row; record its id on the audit entry.
    res.locals.auditEntityId = consent.id;
    res.status(200).json(consent);
  },
);
