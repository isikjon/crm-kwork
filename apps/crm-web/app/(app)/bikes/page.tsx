import { FleetLivePanel } from "../../../components/fleet-live-panel";
import { SectionScreen } from "../../../components/section-screen";

export default async function BikesPage(props: {
  searchParams?: Promise<{
    q?: string;
    status?: string;
    quick?: string;
    focusBikeId?: string;
  }>;
}) {
  const searchParams = await props.searchParams;

  return (
    <div className="section-stack">
      <SectionScreen slug="bikes" />
      <FleetLivePanel
        query={{
          q: searchParams?.q ?? null,
          status: searchParams?.status ?? null,
          quick: searchParams?.quick ?? null,
          focusBikeId: searchParams?.focusBikeId ?? null,
          limit: 24
        }}
      />
    </div>
  );
}
