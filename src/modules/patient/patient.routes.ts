// Patient HTTP routes — mounted at /api/v1/patients (see src/app.ts).
//
// The router is deliberately thin: each route validates its input via the
// `validate` middleware, then delegates to the service layer. Express 5 awaits
// async handlers and forwards rejections to the terminal error handler, so the
// service's thrown HttpProblem(404) becomes an RFC 7807 response without any
// try/catch here.
//
// Access control (#12): `authenticate` is applied at the router mount in
// src/app.ts, so every route below already has an authenticated `req.user`.
// Per-route `requireRole(...)` then narrows writes: reads are open to any
// authenticated role; create/update allow ADMIN/CLINICIAN/RECEPTIONIST; the
// hard-edged DELETE is ADMIN-only. Consent (#13) is owned by a later issue.
import { Router } from 'express';
import { validate } from '../../lib/validate.js';
import { requireRole } from '../../middleware/authorize.js';
import {
  createPatientSchema,
  idParamSchema,
  listQuerySchema,
  updatePatientSchema,
} from './patient.schema.js';
import type { ListQuery } from './patient.schema.js';
import {
  createPatient,
  deletePatient,
  getPatient,
  listPatients,
  updatePatient,
} from './patient.service.js';

export const patientRouter: Router = Router();

// Create a patient. Front-desk and clinical staff may register patients.
patientRouter.post(
  '/',
  requireRole('ADMIN', 'CLINICIAN', 'RECEPTIONIST'),
  validate(createPatientSchema, 'body'),
  async (req, res) => {
    const patient = await createPatient(req.body);
    // Expose the new id so the global audit middleware records entityId (#8).
    res.locals.auditEntityId = patient.id;
    res.status(201).json(patient);
  },
);

// List active patients, paginated.
patientRouter.get('/', validate(listQuerySchema, 'query'), async (req, res) => {
  const patients = await listPatients(req.validatedQuery as ListQuery);
  res.status(200).json(patients);
});

// Fetch one patient by id.
patientRouter.get('/:id', validate(idParamSchema, 'params'), async (req, res) => {
  const { id } = req.params as { id: string };
  const patient = await getPatient(id);
  res.status(200).json(patient);
});

// Partially update a patient. Same write privilege as create.
patientRouter.patch(
  '/:id',
  requireRole('ADMIN', 'CLINICIAN', 'RECEPTIONIST'),
  validate(idParamSchema, 'params'),
  validate(updatePatientSchema, 'body'),
  async (req, res) => {
    const { id } = req.params as { id: string };
    const patient = await updatePatient(id, req.body);
    res.status(200).json(patient);
  },
);

// Soft-delete a patient. Restricted to ADMIN — the most destructive action.
patientRouter.delete(
  '/:id',
  requireRole('ADMIN'),
  validate(idParamSchema, 'params'),
  async (req, res) => {
    const { id } = req.params as { id: string };
    await deletePatient(id);
    res.status(204).end();
  },
);
