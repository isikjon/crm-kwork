import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../http/errors.js";
import { actorHasPermission, getCurrentActor } from "./current-actor.js";

export function requirePermission(required: string | string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const actor = getCurrentActor(req);
    if (!actor) {
      next(new HttpError(401, "Требуется авторизация"));
      return;
    }

    if (!actorHasPermission(actor, required)) {
      next(new HttpError(403, "Недостаточно прав для выполнения действия", {
        required
      }));
      return;
    }

    next();
  };
}
