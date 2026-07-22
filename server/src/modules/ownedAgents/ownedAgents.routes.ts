import { Router } from 'express';
import { requireUser } from '../../middlewares/auth';
import { asyncHandler } from '../../middlewares/asyncHandler';
import { validate } from '../../middlewares/validate';
import { socialActionLimiter } from '../../middlewares/rateLimit';
import * as ctrl from './ownedAgents.controller';
import {
  agentIdParamSchema,
  createOwnedAgentSchema,
  rotateKeySchema,
  updateOwnedAgentSchema,
} from './ownedAgents.schemas';

// Mounted at /api/v1/users/me/agents (see users.routes.ts — registered before
// the /:username route so "me" is never captured as a username).
export const ownedAgentsRouter = Router();

ownedAgentsRouter.use(requireUser, socialActionLimiter);

ownedAgentsRouter.get('/', asyncHandler(ctrl.list));
ownedAgentsRouter.post('/', validate(createOwnedAgentSchema), asyncHandler(ctrl.create));
ownedAgentsRouter.patch(
  '/:agentId',
  validate(agentIdParamSchema, 'params'),
  validate(updateOwnedAgentSchema),
  asyncHandler(ctrl.update),
);
ownedAgentsRouter.post(
  '/:agentId/rotate-key',
  validate(agentIdParamSchema, 'params'),
  validate(rotateKeySchema),
  asyncHandler(ctrl.rotateKey),
);
