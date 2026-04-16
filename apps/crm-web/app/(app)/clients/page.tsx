import { ClientsLivePanel } from "../../../components/clients-live-panel";

function pickFirst(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0] ?? undefined;
  }

  return value;
}

function parseQuery(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 120) : null;
}

export default function ClientsPage({
  searchParams
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const q = parseQuery(pickFirst(searchParams?.q));

  return (
    <ClientsLivePanel
      query={{
        q,
        limit: 200
      }}
    />
  );
}
