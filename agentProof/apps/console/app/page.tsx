import { LiveDemo } from '../components/LiveDemo';
import { ArchitectureMap } from '../components/ArchitectureMap';
import { SponsorFooter } from '../components/SponsorFooter';
import { Install } from '../components/Install';

/**
 * The five-minute page.
 *
 * Structured for a judge who will not read: what it is (one line), what it does
 * (a demo that plays itself), how you use it (two commands), and only then the
 * system diagram for anyone still curious. The prose that used to live here now
 * lives inside the map's detail panels, where it is opt-in.
 */
export default function HomePage() {
  return (
    <>
      <header className="hero">
        <div className="hero__grid">
          <div>
            <p className="kicker">npm · @agentproof/sdk</p>
            <h1 className="hero__title">
              Spending limits an AI agent <span className="hero__em">can&rsquo;t argue with.</span>
            </h1>
            <p className="hero__lede">
              Drop-in guardrails for agents that hold a wallet. The SDK checks every transaction before it is signed
              — and the limit is enforced on-chain, so it holds even if the agent skips the check.
            </p>
            <Install />
          </div>

          <LiveDemo />
        </div>
      </header>

      <section className="mapwrap" aria-labelledby="map-h">
        <div className="mapwrap__head">
          <p className="kicker">Under the hood</p>
          <h2 id="map-h" className="mapwrap__h">
            Advice on the left. Enforcement on the right.
          </h2>
        </div>
        <ArchitectureMap />
      </section>

      <SponsorFooter />
    </>
  );
}
