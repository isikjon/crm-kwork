import { LegacyImportDashboard } from "../../../components/legacy-import-dashboard";
import { SectionScreen } from "../../../components/section-screen";

export default function ImportsPage() {
  return (
    <div className="section-stack">
      <SectionScreen slug="imports" />
      <LegacyImportDashboard />
    </div>
  );
}
