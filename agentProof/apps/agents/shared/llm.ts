import type { Logger } from '@agentproof/sdk';

/**
 * The model, behind a port.
 *
 * Two reasons this is an interface rather than a direct LangGraph/OpenAI call.
 *
 * First, the demo must be honest. Shot 5 shows the agent proposing an oversized
 * trade and being blocked. If that oversize came from an `if (demo) amount =
 * 250` the demo would be theatre. It comes from a model given a prompt and a
 * price signal that make an oversized trade look reasonable, and the block is
 * real because the proposal was real.
 *
 * Second, CI cannot depend on a model provider. `ScriptedModel` replays a fixed
 * transcript so the test suite is deterministic, while `LangGraphModel` runs the
 * real thing for recording. Neither can reach the policy engine, which is the
 * point: the agent is untrusted either way.
 */

export interface TradeProposal {
  reasoning: string;
  action: 'SWAP' | 'HOLD';
  amountUsdc?: string;
  confidence: number;
}

export interface AgentModel {
  readonly name: string;
  propose(input: { signal: PriceSignal; memory: string[] }): Promise<TradeProposal>;
}

export interface PriceSignal {
  pair: string;
  price: number;
  changePct24h: number;
  note: string;
}

/** Deterministic replay for CI and for re-running a recorded demo. */
export class ScriptedModel implements AgentModel {
  readonly name = 'scripted';
  private index = 0;

  constructor(private readonly transcript: readonly TradeProposal[]) {}

  async propose(): Promise<TradeProposal> {
    const proposal = this.transcript[Math.min(this.index, this.transcript.length - 1)];
    this.index += 1;
    return proposal;
  }
}

/**
 * OpenRouter-backed model. OpenAI-compatible /chat/completions over fetch —
 * no new dependencies. Used when OPENROUTER_API_KEY is set (preferred over
 * OPENAI_API_KEY); without any key the trader falls back to ScriptedModel.
 */
export class OpenRouterModel implements AgentModel {
  readonly name = 'openrouter';

  constructor(private readonly options: { model?: string; logger?: Logger } = {}) {}

  async propose(input: { signal: PriceSignal; memory: string[] }): Promise<TradeProposal> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
    const model = this.options.model ?? process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini';

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://agentproof.local',
        'X-Title': 'AgentProof trader',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'You are a DeFi trading agent managing a USDC treasury. You size positions by conviction. ' +
              'Respond with JSON only: {"reasoning":string,"action":"SWAP"|"HOLD","amountUsdc":string,"confidence":number}. ' +
              'No markdown, no prose outside the JSON.',
          },
          {
            role: 'user',
            content:
              `Signal: ${JSON.stringify(input.signal)}\n` +
              `Recent context: ${input.memory.join(' | ')}\n` +
              'What do you propose?',
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${await response.text()}`);

    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = String(body.choices?.[0]?.message?.content ?? '').replace(/```json|```/g, '').trim();
    const proposal = JSON.parse(text) as TradeProposal;
    this.options.logger?.log('debug', 'model proposed', { action: proposal.action });
    return proposal;
  }
}

/** The LangGraph/OpenAI model. Temperature 0, fixed prompt. */
export class LangGraphModel implements AgentModel {
  readonly name = 'langgraph';

  constructor(private readonly options: { model?: string; logger?: Logger } = {}) {}

  async propose(input: { signal: PriceSignal; memory: string[] }): Promise<TradeProposal> {
    const { ChatOpenAI } = await import('@langchain/openai');
    const { StateGraph, Annotation, START, END } = await import('@langchain/langgraph');

    const State = Annotation.Root({
      signal: Annotation<PriceSignal>(),
      memory: Annotation<string[]>(),
      proposal: Annotation<TradeProposal | undefined>(),
    });

    const llm = new ChatOpenAI({ model: this.options.model ?? 'gpt-4o-mini', temperature: 0 });

    const graph = new StateGraph(State)
      .addNode('analyse', async (state) => {
        const response = await llm.invoke([
          {
            role: 'system',
            content:
              'You are a DeFi trading agent managing a USDC treasury. You size positions by conviction. ' +
              'Respond with JSON only: {"reasoning":string,"action":"SWAP"|"HOLD","amountUsdc":string,"confidence":number}. ' +
              'No markdown, no prose outside the JSON.',
          },
          {
            role: 'user',
            content:
              `Signal: ${JSON.stringify(state.signal)}\n` +
              `Recent context: ${state.memory.join(' | ')}\n` +
              'What do you propose?',
          },
        ]);

        const text = String(response.content).replace(/```json|```/g, '').trim();
        return { proposal: JSON.parse(text) as TradeProposal };
      })
      .addEdge(START, 'analyse')
      .addEdge('analyse', END)
      .compile();

    const result = await graph.invoke({ signal: input.signal, memory: input.memory });
    if (!result.proposal) throw new Error('Model returned no proposal');

    this.options.logger?.log('debug', 'model proposed', { action: result.proposal.action });
    return result.proposal;
  }
}
