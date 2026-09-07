import { Dashboard } from '@/components/Dashboard';

/**
 * The dashboard is a client surface end to end.
 *
 * There is no server-side data fetching here on purpose: rendering a decision
 * on the server would put this process in the decision path, and the one
 * property the dashboard has to keep is that closing it changes nothing.
 */
export default function Page() {
  return <Dashboard />;
}
