import { INTEGRATIONS } from '@/lib/integrations';

/**
 * Sponsor strip.
 *
 * Footer placement is deliberate: these are what the product is built on, not
 * what it is. A judge should meet the product first and find the stack here
 * when they go looking for it.
 */
export function SponsorFooter() {
  return (
    <footer className="foot">
      <div className="foot__row">
        <span className="foot__label">Built on</span>
        <ul className="foot__list">
          {INTEGRATIONS.map((integration) => (
            <li key={integration.name} className="foot__item">
              {integration.links[0] ? (
                <a href={integration.links[0].href} target="_blank" rel="noreferrer noopener">
                  {integration.name}
                </a>
              ) : (
                <span>{integration.name}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
      <p className="foot__fine">
        Sepolia · MIT licensed · <a href="/proof">every deployed address</a>
      </p>
    </footer>
  );
}
