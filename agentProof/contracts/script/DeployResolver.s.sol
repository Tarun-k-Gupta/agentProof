// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";

interface IVerifiableFactory {
    function deployProxy(address implementation, uint256 salt, bytes memory data) external returns (address proxy);
}

interface IPermissionedResolverInit {
    function initialize(address admin, uint256 roleBitmap, bytes[] calldata setters) external;
}

/**
 * @notice Deploys our namespace resolver (a PermissionedResolver proxy) via
 *         ENS's VerifiableFactory.
 *
 * The deployer keeps the ADMIN roles at root so it can authorize per-name
 * record roles afterwards. Record writes themselves are always gated by
 * EAC — the deployer authorizes, the resolver enforces.
 */
contract DeployResolver is Script {
    address internal constant FACTORY = 0x10dC6333CDFe1FCEf624c6e0a8221b91804Cd7ef;
    address internal constant RESOLVER_IMPL = 0x9EAe5C2730a7dD16BDD1DeE6421a1B91e3B0365e;

    // Canonical PermissionedResolverLib ADMIN bitmaps (root positions).
    uint256 internal constant SET_TEXT_ADMIN = (1 << 4) << 128;
    uint256 internal constant SET_ADDR_ADMIN = (1 << 0) << 128;
    uint256 internal constant UPGRADE_ADMIN = (1 << 124) << 128;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        bytes[] memory setters;
        bytes memory initData = abi.encodeCall(
            IPermissionedResolverInit.initialize,
            (deployer, SET_TEXT_ADMIN | SET_ADDR_ADMIN | UPGRADE_ADMIN, setters)
        );

        vm.startBroadcast(deployerKey);
        address proxy = IVerifiableFactory(FACTORY).deployProxy(
            RESOLVER_IMPL, uint256(keccak256("agentproof-resolver-v1")), initData
        );
        vm.stopBroadcast();

        console2.log("Namespace resolver:", proxy);
    }
}
