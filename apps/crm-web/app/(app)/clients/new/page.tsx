import { ClientCreateForm } from "../../../../components/client-create-form";
import { loadClientWorkplaces } from "../../../../lib/clients-api";

export default async function ClientNewPage() {
  const workplaces = await loadClientWorkplaces().catch(() => null);

  return <ClientCreateForm workplaces={workplaces?.rows ?? []} />;
}
