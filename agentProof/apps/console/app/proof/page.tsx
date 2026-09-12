import { SubgraphPanel } from '../../components/SubgraphPanel';
import { STAGES, type Stage } from '@/lib/deployments';

/**
 * The evidence room.
 *
 * Everything AgentProof has actually deployed, in one place, with a link out to
 * a source we do not control wherever one exists. The claim this page has to
 * support is "go check for yourself" — so every row is either a link or a fact
 * stated precisely enough to be falsified.
 */
export default function ProofPage() {
  return (
    <>
      <div className="work__head">
        <div>
          <p className="kicker">Don’t take our word for it</p>
          <h1 className="work__title">See the receipts</h1>
          <p className="work__sub">
            Every contract, record and receipt, linked to a public explorer you can check yourself.
          </p>
        </div>
      </div>

      <div className="work__body ev">
        <section className="ev__section">
          <h2 className="ev__h">Indexed history — live from The Graph</h2>
          <p className="ev__lede">
            The subgraph indexes the enforcement hook’s own events. This is what the chain admitted, not what any agent
            intended, and it is queried directly from your browser.
          </p>
          <SubgraphPanel />
        </section>

        {STAGES.filter((stage) => stage.artifacts.length > 0).map((stage) => (
          <EvidenceBlock key={stage.id} stage={stage} />
        ))}
      </div>
    </>
  );
}

function EvidenceBlock({ stage }: { stage: Stage }) {
  return (
    <section className="ev__section">
      <h2 className="ev__h">
        {stage.name}
        <span className={`ap-chip ${stage.side === 'enforcing' ? 'ap-chip--allow' : ''}`}>
          {stage.side === 'enforcing' ? 'on-chain' : 'off-chain'}
        </span>
      </h2>
      <p className="ev__lede">{stage.what}</p>
      <dl className="ev__list">
        {stage.artifacts.map((artifact, index) => (
          <div key={`${artifact.label}-${index}`} className="ev__row">
            <dt>{artifact.label}</dt>
            <dd className={artifact.mono ? 'ap-mono' : undefined}>
              {artifact.href ? (
                <a href={artifact.href} target="_blank" rel="noreferrer noopener">
                  {artifact.value} ↗
                </a>
              ) : (
                artifact.value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
