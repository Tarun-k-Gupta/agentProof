// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AgentSubnameRegistrar} from "../src/AgentSubnameRegistrar.sol";
import {IPermissionedRegistry, IEnhancedAccessControl, ROOT_RESOURCE} from "../src/interfaces/IENSv2.sol";

/**
 * @notice Deploys AgentSubnameRegistrar and registers one agent namespace.
 *
 *   forge script script/DeployEns.s.sol:DeployEns \
 *     --rpc-url $SEPOLIA_RPC_URL --broadcast
 *
 * Required environment:
 *   DEPLOYER_PRIVATE_KEY      pays gas and ends up holding the owner roles
 *   ENS_REGISTRY_ADDRESS      ENSv2 Permissioned Registry on Sepolia
 *   ENS_RESOLVER_ADDRESS      ENSv2 Permissioned Resolver
 *   AGENT_LABEL               e.g. "trader" for trader.agentproof.eth
 *   SMART_ACCOUNT_ADDRESS     the agent's ERC-7579 account
 *   AGENT_SESSION_KEY_ADDRESS the address of the agent's scoped key (not the key)
 *   AGENT_POLICY_HASH         keccak256 of the canonical policy JSON
 *   AGENT_POLICY_HOOK_ADDRESS the deployed AgentPolicyHook
 *
 * @dev ENSv2 is beta and its contracts are explicitly not final, so this script
 *      takes the registry and resolver as addresses rather than importing them.
 *      Record whatever you pass in deployments/ensv2-sepolia.json; when the beta
 *      moves under you, a diff of that file is the difference between a
 *      five-minute fix and an afternoon.
 *
 *      The registrar needs ROLE_REGISTRAR on ROOT_RESOURCE before it can mint.
 *      That grant is made by whoever controls agentproof.eth and is deliberately
 *      a separate transaction: it is the one moment a human decides that this
 *      contract may create names under their parent.
 */
contract DeployEns is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        IPermissionedRegistry registry = IPermissionedRegistry(vm.envAddress("ENS_REGISTRY_ADDRESS"));
        address resolver = vm.envAddress("ENS_RESOLVER_ADDRESS");

        string memory label = vm.envString("AGENT_LABEL");
        address account = vm.envAddress("SMART_ACCOUNT_ADDRESS");
        address sessionKey = vm.envAddress("AGENT_SESSION_KEY_ADDRESS");
        bytes32 policyHash = vm.envBytes32("AGENT_POLICY_HASH");
        address hook = vm.envAddress("AGENT_POLICY_HOOK_ADDRESS");

        require(account != address(0), "SMART_ACCOUNT_ADDRESS is unset");
        require(hook != address(0), "AGENT_POLICY_HOOK_ADDRESS is unset - deploy the hook first");
        require(sessionKey != deployer, "the agent session key must not be the owner key");

        vm.startBroadcast(deployerKey);

        AgentSubnameRegistrar registrar = new AgentSubnameRegistrar(registry, resolver);

        // Minting authority. Skipped when the deployer cannot grant it — on the
        // real registry the parent's controller does this, and it may not be us.
        (bool granted,) = address(registry)
            .call(
                abi.encodeCall(
                    IEnhancedAccessControl.grantRoles,
                    (ROOT_RESOURCE, registrar.ROLE_REGISTRAR() | registrar.ROLE_RENEW(), address(registrar))
                )
            );

        uint256 tokenId = registrar.registerAgent(label, account, sessionKey, policyHash, hook, 365 days);

        vm.stopBroadcast();

        console2.log("AgentSubnameRegistrar :", address(registrar));
        console2.log("registry              :", address(registry));
        console2.log("resolver              :", resolver);
        console2.log("agent tokenId         :", tokenId);
        console2.log("root role granted here:", granted);
        if (!granted) {
            console2.log("  -> grant ROLE_REGISTRAR|ROLE_RENEW on ROOT_RESOURCE to the registrar");
            console2.log("     from the account that controls the parent name, then re-run.");
        }

        string memory json = "ensv2";
        vm.serializeAddress(json, "agentSubnameRegistrar", address(registrar));
        vm.serializeAddress(json, "permissionedRegistry", address(registry));
        vm.serializeAddress(json, "permissionedResolver", resolver);
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeString(json, "agentSubname", string.concat(label, ".agentproof.eth"));
        string memory out = vm.serializeUint(json, "agentTokenId", tokenId);

        vm.writeJson(out, "../deployments/ensv2-sepolia.json");
    }
}
