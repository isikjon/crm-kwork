import { FinanceLivePanel } from "../../../components/finance-live-panel";

export default function FinancePage(props: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  return <FinanceLivePanel searchParams={props.searchParams} />;
}
