import { BigInt, Bytes } from '@graphprotocol/graph-ts';
import {
  PolicyInstalled,
  PolicyUninstalled,
  SpendRecorded,
  TargetAllowed,
} from '../generated/AgentPolicyHook/AgentPolicyHook';
import { Agent, DailyAggregate, Execution, PolicyInstall, TargetPermission } from '../generated/schema';

/**
 * Mappings for the AgentProof spend history.
 *
 * One rule governs everything here: we index SpendRecorded, which the hook
 * emits in postCheck from a measured balance delta. We do not index proposed
 * actions, intents or anything an agent said it would do. The subgraph is a
 * record of what the chain permitted, which is the only history a spend limit
 * can safely be computed from.
 */

export function handlePolicyInstalled(event: PolicyInstalled): void {
  const account = event.params.account;
  let agent = Agent.load(account.toHexString());

  if (agent == null) {
    agent = new Agent(account.toHexString());
    agent.totalOutflow = BigInt.zero();
    agent.executionCount = 0;
    agent.allowedTargets = new Array<Bytes>();
  }

  agent.policyHash = event.params.policyHash;
  agent.asset = event.params.asset;
  agent.hook = event.address;
  agent.installedAt = event.block.timestamp;
  agent.save();

  const install = new PolicyInstall(event.transaction.hash.toHexString() + '-' + event.logIndex.toString());
  install.account = account;
  install.policyHash = event.params.policyHash;
  install.asset = event.params.asset;
  install.blockNumber = event.block.number;
  install.timestamp = event.block.timestamp;
  install.transactionHash = event.transaction.hash;
  install.save();
}

export function handleSpendRecorded(event: SpendRecorded): void {
  const account = event.params.account;
  const agent = Agent.load(account.toHexString());
  if (agent == null) return; // spend before install is not possible; ignore defensively

  const execution = new Execution(event.transaction.hash.toHexString() + '-' + event.logIndex.toString());
  execution.agent = agent.id;
  execution.account = account;
  execution.target = event.params.target;
  execution.outflow = event.params.amount;
  execution.dayTotal = event.params.dayTotal;
  execution.day = event.params.day.toI32();
  execution.blockNumber = event.block.number;
  execution.timestamp = event.block.timestamp;
  execution.transactionHash = event.transaction.hash;
  execution.save();

  agent.totalOutflow = agent.totalOutflow.plus(event.params.amount);
  agent.executionCount = agent.executionCount + 1;
  agent.save();

  const day = event.params.day.toI32();
  const aggregateId = account.toHexString() + '-' + day.toString();
  let aggregate = DailyAggregate.load(aggregateId);

  if (aggregate == null) {
    aggregate = new DailyAggregate(aggregateId);
    aggregate.agent = agent.id;
    aggregate.account = account;
    aggregate.day = day;
    aggregate.totalOutflow = BigInt.zero();
    aggregate.executionCount = 0;
    aggregate.largestOutflow = BigInt.zero();
  }

  // dayTotal comes straight from the hook's accumulator rather than being
  // summed here. If our arithmetic ever disagreed with the contract's, the
  // contract is right, and taking its number directly removes the chance to be
  // subtly wrong.
  aggregate.totalOutflow = event.params.dayTotal;
  aggregate.executionCount = aggregate.executionCount + 1;
  if (event.params.amount.gt(aggregate.largestOutflow)) {
    aggregate.largestOutflow = event.params.amount;
  }
  aggregate.lastUpdatedBlock = event.block.number;
  aggregate.save();
}

export function handleTargetAllowed(event: TargetAllowed): void {
  const id = event.params.account.toHexString() + '-' + event.params.target.toHexString();
  let permission = TargetPermission.load(id);
  if (permission == null) {
    permission = new TargetPermission(id);
    permission.account = event.params.account;
    permission.target = event.params.target;
  }
  permission.allowed = event.params.allowed;
  permission.updatedAt = event.block.timestamp;
  permission.save();
}

export function handlePolicyUninstalled(event: PolicyUninstalled): void {
  const agent = Agent.load(event.params.account.toHexString());
  if (agent == null) return;
  // The agent record is kept. An account that removed its enforcement layer is
  // exactly the history an auditor most wants to still be able to read.
  agent.installedAt = BigInt.zero();
  agent.save();
}
