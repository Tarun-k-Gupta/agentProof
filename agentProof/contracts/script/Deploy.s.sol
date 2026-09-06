// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AgentPolicyHook} from "../src/AgentPolicyHook.sol";

/**
 * @notice Deploys the hook and emits the address map the SDK, API and dashboard
 *         all read. deployments/sepolia.json is the single source of truth for
 *         addresses — nothing is hardcoded in two places.
 *
 *   forge script script/Deploy.s.sol:Deploy \
 *     --rpc-url $SEPOLIA_RPC_URL --broadcast --verify
 *
 * Installing the hook on the account is a separate, deliberate step
 * (`pnpm deploy:install-hook`) because it must be signed by the owner key,
 * which never lives in a deploy script's environment.
 */
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address usdc = vm.envAddress("USDC_ADDRESS");

        vm.startBroadcast(deployerKey);
        AgentPolicyHook hook = new AgentPolicyHook();
        vm.stopBroadcast();

        console2.log("AgentPolicyHook:", address(hook));
        console2.log("tracked asset  :", usdc);

        string memory json = "deployment";
        vm.serializeAddress(json, "agentPolicyHook", address(hook));
        vm.serializeAddress(json, "usdc", usdc);
        vm.serializeUint(json, "chainId", block.chainid);
        string memory out = vm.serializeUint(json, "deployedAtBlock", block.number);

        vm.writeJson(out, "../deployments/sepolia.json");
    }
}
