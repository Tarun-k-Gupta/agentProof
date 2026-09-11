// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AgentSubnameRegistrar} from "../src/AgentSubnameRegistrar.sol";
import {IPermissionedRegistry, IPermissionedResolver} from "../src/interfaces/IENSv2.sol";

/**
 * @notice Deploys AgentSubnameRegistrar and mints one agent namespace.
 *
 * Canonical ENSv2 (Sepolia beta) flow, per
 * docs.ens.domains/ensv2/tutorial-contract-developers:
 *
 *   1. deploy the registrar (plain contract, owner = deployer)
 *   2. grant it REGISTRAR|RENEW on the namespace root
 *   3. grant it text/addr ADMIN on the agent's node (via authorizeNameRoles)
 *   4. registerAgent mints the name, delegates per-record roles, writes records
 *
 *   forge script script/DeployEns.s.sol:DeployEns \
 *     --rpc-url $SEPOLIA_RPC_URL --broadcast
 *
 * Required environment:
 *   DEPLOYER_PRIVATE_KEY      pays gas, owns the parent, becomes registrar owner
 *   NAMESPACE_REGISTRY        our UserRegistry proxy (DeployNamespace)
 *   NAMESPACE_RESOLVER        our PermissionedResolver proxy (DeployResolver)
 *   AGENT_LABEL               e.g. "trader"
 *   AGENT_NODE                namehash(label.parent), 0x-prefixed bytes32
 *   AGENT_DNS                 DNS-encoded label.parent, 0x-prefixed bytes
 *   SMART_ACCOUNT_ADDRESS     the agent's ERC-7579 account
 *   AGENT_SESSION_KEY_ADDRESS the address of the agent's scoped key (not the key)
 *   AGENT_POLICY_HASH         keccak256 of the canonical policy JSON
 *   AGENT_POLICY_HOOK_ADDRESS the deployed AgentPolicyHook
 *
 * @dev `node` and `dns` are computed off-chain (cast namehash + DNS encoding)
 *      so the contracts never parse names on-chain.
 */
contract DeployEns is Script {
    uint256 internal constant ROLE_REGISTRAR = 1 << 0;
    uint256 internal constant ROLE_RENEW = 1 << 16;
    uint256 internal constant SET_TEXT_ADMIN = (1 << 4) << 128;
    uint256 internal constant SET_ADDR_ADMIN = (1 << 0) << 128;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        IPermissionedRegistry registry = IPermissionedRegistry(vm.envAddress("NAMESPACE_REGISTRY"));
        IPermissionedResolver resolver = IPermissionedResolver(vm.envAddress("NAMESPACE_RESOLVER"));

        string memory label = vm.envString("AGENT_LABEL");
        bytes32 node = vm.envBytes32("AGENT_NODE");
        bytes memory dnsName = vm.envBytes("AGENT_DNS");
        address account = vm.envAddress("SMART_ACCOUNT_ADDRESS");
        address sessionKey = vm.envAddress("AGENT_SESSION_KEY_ADDRESS");
        bytes32 policyHash = vm.envBytes32("AGENT_POLICY_HASH");
        address hook = vm.envAddress("AGENT_POLICY_HOOK_ADDRESS");

        require(account != address(0), "SMART_ACCOUNT_ADDRESS is unset");
        require(hook != address(0), "AGENT_POLICY_HOOK_ADDRESS is unset - deploy the hook first");
        require(sessionKey != vm.addr(deployerKey), "the agent session key must not be the owner key");

        vm.startBroadcast(deployerKey);

        AgentSubnameRegistrar registrar = new AgentSubnameRegistrar(registry, resolver);

        registry.grantRootRoles(ROLE_REGISTRAR | ROLE_RENEW, address(registrar));

        resolver.authorizeNameRoles(
            dnsName, SET_TEXT_ADMIN | SET_ADDR_ADMIN, address(registrar), true
        );

        uint256 tokenId = registrar.registerAgent(
            label, node, dnsName, account, sessionKey, policyHash, hook, 365 days
        );

        vm.stopBroadcast();

        console2.log("AgentSubnameRegistrar :", address(registrar));
        console2.log("agent tokenId         :", tokenId);
    }
}
