// Patient HTTP routes — mounted at /api/v1/patients (see src/app.ts).
//
// The router is deliberately thin: each route validates its input via the
// `validate` middleware, then delegates to the service layer. Express 5 awaits
// async handlers and forwards rejections to the terminal error handler, so the
// service's thrown HttpProblem(404) becomes an RFC 7807 response without any
// try/catch here.
//
// These endpoints are intentionally OPEN for now. Authentication/RBAC (#10/#12),
// audit logging (#8), and consent (#13) are owned by later issues.
import { Router } from 'express';
import { validate } from '../../lib/validate.js';
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

// Create a patient.
patientRouter.post('/', validate(createPatientSchema, 'body'), async (req, res) => {
  const patient = await createPatient(req.body);
  res.status(201).json(patient);
});

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

// Partially update a patient.
patientRouter.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(updatePatientSchema, 'body'),
  async (req, res) => {
    const { id } = req.params as { id: string };
    const patient = await updatePatient(id, req.body);
    res.status(200).json(patient);
  },
);

// Soft-delete a patient.
patientRouter.delete('/:id', validate(idParamSchema, 'params'), async (req, res) => {
  const { id } = req.params as { id: string };
  await deletePatient(id);
  res.status(204).end();
});
