import { BikeDetailPanel } from "../../../../components/bike-detail-panel";

export default async function BikeDetailPage(props: {
  params: Promise<{
    bikeId: string;
  }>;
}) {
  const params = await props.params;

  return <BikeDetailPanel bikeId={params.bikeId} />;
}
