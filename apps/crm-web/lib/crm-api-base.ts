export function getCrmApiBase() {
  return process.env.CRM_API_INTERNAL_BASE
    ?? process.env.NEXT_PUBLIC_CRM_API_BASE
    ?? "http://localhost:4200/api/v1";
}

export async function fetchCrmJson<T>(path: string): Promise<T> {
  const apiBase = getCrmApiBase();
  const response = await fetch(`${apiBase}${path}`, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}
