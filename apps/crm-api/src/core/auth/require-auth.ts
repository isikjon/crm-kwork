import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../http/errors.js";
import { getCurrentActor } from "./current-actor.js";

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!getCurrentActor(req)) {
    next(new HttpError(401, "Требуется авторизация"));
    return;
  }

  next();
}
