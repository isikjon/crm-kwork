import { createHmac } from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../../config/env.js";

const SESSION_COOKIE_NAME = "crm_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

interface SessionPayload {
  sub: string;
  tenantId: string;
  tenantSlug: string;
  iat: number;
  exp: number;
}

function base64UrlEncode(input: string) {
  return Buffer.from(input, "utf8").toString("base64url");
}

function base64UrlDecode(input: string) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function sign(raw: string) {
  return createHmac("sha256", env.JWT_SECRET).update(raw).digest("base64url");
}

function parseCookieHeader(cookieHeader: string | undefined) {
  if (!cookieHeader) {
    return new Map<string, string>();
  }

  return new Map(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf("=");
        if (separatorIndex === -1) {
          return [part, ""];
        }

        return [part.slice(0, separatorIndex), decodeURIComponent(part.slice(separatorIndex + 1))];
      })
  );
}

export function createSessionToken(payload: {
  userId: string;
  tenantId: string;
  tenantSlug: string;
}) {
  const issuedAt = Date.now();
  const sessionPayload: SessionPayload = {
    sub: payload.userId,
    tenantId: payload.tenantId,
    tenantSlug: payload.tenantSlug,
    iat: issuedAt,
    exp: issuedAt + SESSION_TTL_MS
  };

  const encodedPayload = base64UrlEncode(JSON.stringify(sessionPayload));
  const signature = sign(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function verifySessionToken(token: string): SessionPayload | null {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  if (sign(encodedPayload) !== signature) {
    return null;
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as SessionPayload;
    if (
      typeof payload.sub !== "string"
      || typeof payload.tenantId !== "string"
      || typeof payload.tenantSlug !== "string"
      || typeof payload.iat !== "number"
      || typeof payload.exp !== "number"
    ) {
      return null;
    }

    if (payload.exp <= Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

export function readSessionTokenFromRequest(req: Request) {
  return parseCookieHeader(req.headers.cookie).get(SESSION_COOKIE_NAME) ?? null;
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/"
  });
}
