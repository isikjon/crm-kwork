import { cookies } from "next/headers";
import { GpsSettingsPanel } from "../../../components/gps-settings-panel";
import { NotificationsSettingsPanel } from "../../../components/notifications-settings-panel";
import { fetchCurrentActorServer, type AuthActor } from "../../../lib/auth-api";
import { loadGpsWorkspace } from "../../../lib/gps-api";
import { loadNotificationsWorkspace } from "../../../lib/notifications-api";

function actorHasAnyPermission(actor: AuthActor | null, required: string[]) {
  if (!actor) {
    return false;
  }

  if (actor.isTenantOwner || actor.isSupportUser) {
    return true;
  }

  return required.some((code) => actor.permissionCodes.includes(code));
}

function renderUnavailableCard(params: {
  kicker: string;
  title: string;
  note: string;
  error: string | null;
}) {
  return (
    <section className="surface-card warning-card settings-warning-card">
      <div className="surface-kicker">{params.kicker}</div>
      <h3>{params.title}</h3>
      <p className="route-card-note">{params.note}</p>
      <ul className="surface-list">
        <li>Ошибка: {params.error ?? "unknown error"}.</li>
      </ul>
    </section>
  );
}

function pickFirst(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function SettingsPage(props: {
  searchParams?: Promise<Record<string, string | string[] | undefined>> | Record<string, string | string[] | undefined>;
}) {
  const searchParams = await Promise.resolve(props.searchParams ?? {});
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.toString();
  const actor = await fetchCurrentActorServer(cookieHeader);

  const canViewGps = actorHasAnyPermission(actor, ["gps.view"]);
  const canViewNotifications = actorHasAnyPermission(actor, ["notifications.view"]);

  const [gpsWorkspace, notificationsWorkspace] = await Promise.all([
    canViewGps ? loadGpsWorkspace({
      q: pickFirst(searchParams.gpsQ),
      quick: pickFirst(searchParams.gpsQuick) as "all" | "problems" | "unbound" | "rebind" | undefined,
      binding: pickFirst(searchParams.gpsBinding) as "all" | "bound" | "unbound" | "suggested" | undefined,
      match: pickFirst(searchParams.gpsMatch) as "all" | "auto_matched" | "unmatched" | "ambiguous" | "manual_binding" | "rebind_candidate" | undefined,
      network: pickFirst(searchParams.gpsNetwork) as "all" | "online" | "offline" | undefined,
      sync: pickFirst(searchParams.gpsSync) as "all" | "needs_sync" | undefined,
      review: pickFirst(searchParams.gpsReview) as "all" | "review_needed" | "rebind_candidate" | undefined
    }, cookieHeader) : Promise.resolve(null),
    canViewNotifications ? loadNotificationsWorkspace(cookieHeader) : Promise.resolve(null)
  ]);

  if (!canViewGps && !canViewNotifications) {
    return (
      <section className="surface-card warning-card settings-warning-card">
        <div className="surface-kicker">Настройки</div>
        <h3>Этот раздел пока недоступен</h3>
        <p className="route-card-note">
          Для просмотра нужен хотя бы один из доступов: `gps.view` или `notifications.view`.
        </p>
      </section>
    );
  }

  return (
    <section className="section-stack settings-workspace-stack">
      {canViewNotifications ? (
        notificationsWorkspace?.data ? (
          <NotificationsSettingsPanel workspace={notificationsWorkspace.data} />
        ) : renderUnavailableCard({
          kicker: "Уведомления",
          title: "Workspace уведомлений пока недоступен",
          note: "Проверь `crm-api`, Prisma sync и notifications routes.",
          error: notificationsWorkspace?.error ?? null
        })
      ) : null}

      {canViewGps ? (
        gpsWorkspace?.data ? (
          <GpsSettingsPanel workspace={gpsWorkspace.data} />
        ) : renderUnavailableCard({
          kicker: "GPS API",
          title: "Настройки GPS пока недоступны",
          note: "Проверь `crm-api`, Prisma sync и доступность GPS API.",
          error: gpsWorkspace?.error ?? null
        })
      ) : null}
    </section>
  );
}
