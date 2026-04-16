import { ClientDetailPanel } from "../../../../components/client-detail-panel";

export default function ClientDetailPage({
  params
}: {
  params: {
    clientId: string;
  };
}) {
  return <ClientDetailPanel clientId={params.clientId} />;
}
