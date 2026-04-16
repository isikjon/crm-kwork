import { OrdersLivePanel } from "../../../components/orders-live-panel";
import type { OrdersStatusGroup } from "../../../lib/orders-api";

function pickFirst(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0] ?? undefined;
  }

  return value;
}

function parseStatusGroup(value: string | undefined): OrdersStatusGroup {
  if (
    value === "RENTAL"
    || value === "BUYOUT"
    || value === "RENTAL_COMPLETED"
    || value === "BUYOUT_COMPLETED"
    || value === "PROBLEM"
    || value === "REPAIR"
  ) {
    return value;
  }

  return "ALL_ACTIVE";
}

function parseQuery(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 120) : null;
}

function parseFocusKind(value: string | undefined) {
  return value === "RENTAL" || value === "BUYOUT" ? value : null;
}

function parseFocusDealId(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 128) : null;
}

export default function OrdersPage({
  searchParams
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const statusGroup = parseStatusGroup(pickFirst(searchParams?.statusGroup));
  const q = parseQuery(pickFirst(searchParams?.q));
  const focusKind = parseFocusKind(pickFirst(searchParams?.focusKind));
  const focusDealId = parseFocusDealId(pickFirst(searchParams?.focusDealId));

  return (
    <OrdersLivePanel
      query={{
        q,
        statusGroup,
        focusKind,
        focusDealId,
        limit: 36
      }}
    />
  );
}
