import { RentalDetailPanel } from "../../../../components/rental-detail-panel";

export default async function RentalDealPage({
  params
}: {
  params: Promise<{ dealId: string }> | { dealId: string };
}) {
  const resolvedParams = await Promise.resolve(params);

  return <RentalDetailPanel dealId={resolvedParams.dealId} />;
}
