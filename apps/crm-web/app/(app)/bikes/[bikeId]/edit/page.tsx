import { cookies } from "next/headers";
import { BikeForm } from "../../../../../components/bike-form";
import { loadBikeDetail, loadBikeWorkspace } from "../../../../../lib/fleet-api";

export default async function EditBikePage(props: {
  params: Promise<{
    bikeId: string;
  }>;
}) {
  const params = await props.params;
  const cookieHeader = (await cookies()).toString();
  const [{ data: workspace, apiBase: workspaceApiBase, error: workspaceError }, { data: bikeData, apiBase: bikeApiBase, error: bikeError }] = await Promise.all([
    loadBikeWorkspace(cookieHeader),
    loadBikeDetail(params.bikeId, cookieHeader)
  ]);

  if (!workspace || !bikeData) {
    return (
      <section className="surface-card warning-card">
        <div className="surface-kicker">Fleet API</div>
        <h3>Редактирование велосипеда пока недоступно</h3>
        <p className="route-card-note">
          Workspace: <strong>{workspaceApiBase}</strong> · detail: <strong>{bikeApiBase}</strong>.
        </p>
        <ul className="surface-list">
          <li>Проверь `crm-api` и маршруты `/bikes/workspace`, `/bikes/:bikeId`.</li>
          <li>Workspace error: {workspaceError ?? "none"}.</li>
          <li>Bike error: {bikeError ?? "none"}.</li>
        </ul>
      </section>
    );
  }

  return <BikeForm bike={bikeData.bike} mode="edit" workspace={workspace} />;
}
