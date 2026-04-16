import type { NextFunction, Request, Response } from "express";
import { toHttpError } from "./errors.js";

export function errorMiddleware(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const httpError = toHttpError(error);
  res.status(httpError.statusCode).json({
    error: {
      message: httpError.message,
      details: httpError.details
    }
  });
}
