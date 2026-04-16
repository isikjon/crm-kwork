import { RentalsLivePanel } from "../../../components/rentals-live-panel";
import { SectionScreen } from "../../../components/section-screen";

export default function RentalsPage() {
  return (
    <div className="section-stack">
      <SectionScreen slug="rentals" />
      <RentalsLivePanel />
    </div>
  );
}
