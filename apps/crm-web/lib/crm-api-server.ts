import "server-only";

import { cookies } from "next/headers";
import { getCrmApiBase } from "./crm-api-base";

export async function fetchCrmJsonServer<T>(path: string): Promise<T> {
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(`${getCrmApiBase()}${path}`, {
    cache: "no-store",
    ...(cookieHeader
      ? {
          headers: {
            cookie: cookieHeader
          }
        }
      : {})
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}
