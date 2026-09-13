import { AttackBench } from '../../components/AttackBench';

export default function RunPage() {
  return (
    <>
      <div className="work__head">
        <div>
          <p className="kicker">Your turn</p>
          <h1 className="work__title">Try to break it</h1>
          <p className="work__sub">
            Pick something an AI agent might try to do with your money. We&rsquo;ll show you what happens.
          </p>
        </div>
      </div>
      <div className="work__body">
        <AttackBench />
      </div>
    </>
  );
}
