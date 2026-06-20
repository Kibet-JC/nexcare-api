// Appointment HTTP routes — mounted at /api/v1/appointments (see src/app.ts).
//
// The router is deliberately thin: each route validates its input via the
// `validate` middleware, then delegates to the service layer. Express 5 awaits
// async handlers and forwards rejections to the terminal error handler, so the
// service's thrown HttpProblem(404) becomes an RFC 7807 response without any
// try/catch here. Mirrors src/modules/patient/patient.routes.ts.
//
// Access control (#12): `authenticate` is applied at the router mount in
// src/app.ts, so every route below already has an authenticated `req.user`.
// Per-route `requireRole(...)` then narrows writes: reads are open to any
// authenticated role; create/update allow ADMIN/CLINICIAN/RECEPTIONIST; DELETE
// allows ADMIN and CLINICIAN (a clinician may cancel a booking). Consent (#13)
// is owned by a later issue.
import { Router } from 'express';
import { validate } from '../../lib/validate.js';
import { requireRole } from '../../middleware/authorize.js';
import {
  createAppointmentSchema,
  idParamSchema,
  listQuerySchema,
  updateAppointmentSchema,
} from './appointment.schema.js';
import type { ListQuery } from './appointment.schema.js';
import {
  createAppointment,
  deleteAppointment,
  getAppointment,
  listAppointments,
  updateAppointment,
} from './appointment.service.js';

export const appointmentRouter: Router = Router();

// Book an appointment. Front-desk and clinical staff may create bookings.
appointmentRouter.post(
  '/',
  requireRole('ADMIN', 'CLINICIAN', 'RECEPTIONIST'),
  validate(createAppointmentSchema, 'body'),
  async (req, res) => {
    const appointment = await createAppointment(req.body);
    // Expose the new id so the global audit middleware records entityId (#8).
    res.locals.auditEntityId = appointment.id;
    res.status(201).json(appointment);
  },
);

// List active appointments, paginated and optionally filtered.
appointmentRouter.get('/', validate(listQuerySchema, 'query'), async (req, res) => {
  const appointments = await listAppointments(req.validatedQuery as ListQuery);
  res.status(200).json(appointments);
});

// Fetch one appointment by id.
appointmentRouter.get('/:id', validate(idParamSchema, 'params'), async (req, res) => {
  const { id } = req.params as { id: string };
  const appointment = await getAppointment(id);
  res.status(200).json(appointment);
});

// Partially update an appointment. Same write privilege as create.
appointmentRouter.patch(
  '/:id',
  requireRole('ADMIN', 'CLINICIAN', 'RECEPTIONIST'),
  validate(idParamSchema, 'params'),
  validate(updateAppointmentSchema, 'body'),
  async (req, res) => {
    const { id } = req.params as { id: string };
    const appointment = await updateAppointment(id, req.body);
    res.status(200).json(appointment);
  },
);

// Soft-delete an appointment. ADMIN or CLINICIAN (a clinician may cancel a
// booking); receptionists may not delete clinical records.
appointmentRouter.delete(
  '/:id',
  requireRole('ADMIN', 'CLINICIAN'),
  validate(idParamSchema, 'params'),
  async (req, res) => {
    const { id } = req.params as { id: string };
    await deleteAppointment(id);
    res.status(204).end();
  },
);
