import { BanksLivePanel } from "../../../components/banks-live-panel";
import { SectionScreen } from "../../../components/section-screen";

export default function BanksPage() {
  return (
    <div className="section-stack">
      <SectionScreen slug="banks" />
      <BanksLivePanel />
    </div>
  );
}
