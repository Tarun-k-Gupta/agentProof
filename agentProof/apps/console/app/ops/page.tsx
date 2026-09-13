import { Ops } from '../../components/Ops';

export default function OpsPage() {
  return (
    <>
      <div className="work__head">
        <div>
          <p className="kicker">Right now</p>
          <h1 className="work__title">Watch it run</h1>
          <p className="work__sub">
            The screen you&rsquo;d actually leave open. Not everything can be a yes or a no — when a trade is big
            enough that you said you wanted a say, the agent stops here and waits for you.
          </p>
        </div>
      </div>
      <div className="work__body">
        <Ops />
      </div>
    </>
  );
}
