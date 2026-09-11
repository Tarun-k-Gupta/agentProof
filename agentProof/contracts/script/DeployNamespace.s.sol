// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";

interface IVerifiableFactory {
    function deployProxy(address implementation, uint256 salt, bytes memory data) external returns (address proxy);
}

interface IUserRegistryInit {
    function initialize(address rootAccount, uint256 roleBitmap) external;
}

/**
 * @notice Deploys our namespace registry (a UserRegistry proxy) via ENS's
 *         VerifiableFactory, following docs.ens.domains/ensv2/tutorial-contract-developers.
 *
 * The deployer keeps the ADMIN variants so it can authorize our agent
 * registrar afterwards; the tutorial's troubleshooting calls this out
 * explicitly (grantRootRoles reverts without them).
 */
contract DeployNamespace is Script {
    address internal constant FACTORY = 0x10dC6333CDFe1FCEf624c6e0a8221b91804Cd7ef;
    address internal constant USER_REGISTRY_IMPL = 0x624a25d67B59D587752EbEc8DdeD8827dAe52050;

    // Canonical RegistryRolesLib ADMIN bitmaps (root positions).
    uint256 internal constant REGISTRAR_ADMIN = 1 << 128;
    uint256 internal constant RENEW_ADMIN = (1 << 16) << 128;
    uint256 internal constant UPGRADE_ADMIN = (1 << 124) << 128;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        uint256 bitmap = REGISTRAR_ADMIN | RENEW_ADMIN | UPGRADE_ADMIN;
        bytes memory initData =
            abi.encodeCall(IUserRegistryInit.initialize, (deployer, bitmap));

        vm.startBroadcast(deployerKey);
        address proxy = IVerifiableFactory(FACTORY).deployProxy(
            USER_REGISTRY_IMPL, uint256(keccak256("agentproof-namespace-v1")), initData
        );
        vm.stopBroadcast();

        console2.log("Namespace registry:", proxy);
        console2.log("root roles to     :", deployer);
    }
}
