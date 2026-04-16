import { BuyoutsLivePanel } from "../../../components/buyouts-live-panel";
import { SectionScreen } from "../../../components/section-screen";

export default function BuyoutsPage() {
  return (
    <div className="section-stack">
      <SectionScreen slug="buyouts" />
      <BuyoutsLivePanel />
    </div>
  );
}
