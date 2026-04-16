import { SECTION_CONTENT } from "../lib/site-data";

export function SectionScreen({ slug }: { slug: keyof typeof SECTION_CONTENT }) {
  const section = SECTION_CONTENT[slug];

  return (
    <div className="section-stack">
      <section className="hero-panel">
        <div className="hero-copy">
          <div className="hero-eyebrow">{section.eyebrow}</div>
          <h2 className="hero-title">{section.title}</h2>
          <p className="hero-summary">{section.summary}</p>
        </div>
      </section>

      <section className="metrics-grid">
        {section.metrics.map((metric) => (
          <article className="metric-card" key={metric.label}>
            <div className="metric-label">{metric.label}</div>
            <div className="metric-value">{metric.value}</div>
            <div className="metric-note">{metric.note}</div>
          </article>
        ))}
      </section>

      <section className="content-grid">
        <article className="surface-card">
          <div className="surface-kicker">Приоритеты</div>
          <h3>Что важно на первом проходе</h3>
          <ul className="surface-list">
            {section.priorities.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </article>

        <article className="surface-card">
          <div className="surface-kicker">Backend modules</div>
          <h3>Какие сервисы держат раздел</h3>
          <div className="tag-cloud">
            {section.modules.map((moduleName) => (
              <span className="tag-chip" key={moduleName}>
                {moduleName}
              </span>
            ))}
          </div>
        </article>
      </section>
    </div>
  );
}
