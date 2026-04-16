import { BuyoutDetailPanel } from "../../../../components/buyout-detail-panel";

export default async function BuyoutDealPage({
  params
}: {
  params: Promise<{ dealId: string }> | { dealId: string };
}) {
  const resolvedParams = await Promise.resolve(params);

  return <BuyoutDetailPanel dealId={resolvedParams.dealId} />;
}
