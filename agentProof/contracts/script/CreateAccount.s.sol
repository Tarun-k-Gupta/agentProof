// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MSAAdvanced} from "erc7579/MSAAdvanced.sol";
import {MSAFactory} from "erc7579/MSAFactory.sol";
import {Bootstrap, BootstrapConfig} from "erc7579/utils/Bootstrap.sol";
import {SimpleExecutionValidator} from "erc7579/modules/SimpleExecutionValidator.sol";

/**
 * @notice Deploys the ERC-7579 account stack and creates the agent's account.
 *
 * Mirrors contracts/test/integration/RealAccount.t.sol::_createAccountWithHook,
 * minus the hook: the hook carries the canonical policy hash, which covers the
 * account address, so it cannot be part of the counterfactual initCode. It is
 * installed afterwards with the final hash (see phase 4).
 *
 *   forge script script/CreateAccount.s.sol:CreateAccount \
 *     --rpc-url $SEPOLIA_RPC_URL --broadcast
 *
 * Required environment:
 *   DEPLOYER_PRIVATE_KEY  pays gas
 */
contract CreateAccount is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        MSAAdvanced implementation = new MSAAdvanced();
        MSAFactory factory = new MSAFactory(address(implementation));
        Bootstrap bootstrap = new Bootstrap();
        SimpleExecutionValidator validator = new SimpleExecutionValidator();

        BootstrapConfig[] memory validators = new BootstrapConfig[](1);
        validators[0].module = address(validator);
        validators[0].data = "";

        BootstrapConfig[] memory executors = new BootstrapConfig[](1);
        executors[0].module = address(0);
        executors[0].data = "";

        // No hook yet (see notice above). Installed with the final policy
        // hash via a UserOp once agent.policy.json carries real addresses.
        BootstrapConfig memory hookConfig;
        hookConfig.module = address(0);
        hookConfig.data = "";

        BootstrapConfig[] memory fallbacks = new BootstrapConfig[](1);
        fallbacks[0].module = address(0);
        fallbacks[0].data = "";

        bytes memory initCode =
            bootstrap._getInitMSACalldata(validators, executors, hookConfig, fallbacks);
        bytes32 salt = keccak256("agentproof.trader");

        address account = factory.getAddress(salt, initCode);
        factory.createAccount(salt, initCode);

        vm.stopBroadcast();

        console2.log("MSAAdvanced impl :", address(implementation));
        console2.log("MSAFactory       :", address(factory));
        console2.log("Bootstrap        :", address(bootstrap));
        console2.log("Validator        :", address(validator));
        console2.log("Account          :", account);
    }
}
