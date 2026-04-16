import { HttpError } from "../http/errors.js";
import { actorRequiresBranchScope } from "./current-actor.js";
import type { CurrentActor } from "./request-context.js";

export function resolveActorBranchReadScope(
  actor: CurrentActor,
  required: string | string[],
  requestedBranchId?: string | null
) {
  if (!actorRequiresBranchScope(actor, required)) {
    return requestedBranchId?.trim() || null;
  }

  if (!actor.branchId) {
    throw new HttpError(403, "Для branch-scoped просмотра у пользователя не задана рабочая точка.");
  }

  if (requestedBranchId?.trim() && requestedBranchId.trim() !== actor.branchId) {
    throw new HttpError(403, "Нет доступа к данным другой точки.", {
      actorBranchId: actor.branchId,
      requestedBranchId: requestedBranchId.trim()
    });
  }

  return actor.branchId;
}
