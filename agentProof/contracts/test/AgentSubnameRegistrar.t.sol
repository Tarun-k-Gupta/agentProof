// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";

import {AgentSubnameRegistrar} from "../src/AgentSubnameRegistrar.sol";
import {IPermissionedRegistry, IEnhancedAccessControl, ROOT_RESOURCE} from "../src/interfaces/IENSv2.sol";
import {MockPermissionedRegistry} from "./mocks/MockPermissionedRegistry.sol";

/**
 * The tamper attempt — demo shot 10, and the reason the ENS integration is more
 * than a name lookup.
 *
 * PRD 10.2 is explicit that reading a name does not qualify: ENSv2's features
 * have to be central. The feature we lean on is Enhanced Access Control, and
 * the claim it lets us make is an asymmetry:
 *
 *     owner key          may repoint agentproof.policy
 *     agent session key  may set agentproof.status, and nothing else
 *
 * That is the AgentProof thesis expressed over identity rather than funds. The
 * agent can act inside its namespace and cannot rewrite the namespace's rules.
 *
 * The tests below are the proof of it, and the failure they guard against is
 * specific: a permission enforced by a modifier we wrote would be a permission
 * we could quietly drop. These reverts come from the registry's role check.
 */
contract AgentSubnameRegistrarTest is Test {
    MockPermissionedRegistry internal registry;
    AgentSubnameRegistrar internal registrar;

    address internal owner = makeAddr("owner");
    address internal agentSessionKey = makeAddr("agentSessionKey");
    address internal account = makeAddr("smartAccount");
    address internal hook = makeAddr("agentPolicyHook");
    address internal resolver = makeAddr("permissionedResolver");
    address internal outsider = makeAddr("outsider");

    string internal constant LABEL = "trader";
    bytes32 internal constant POLICY_HASH = keccak256("agentproof/v1 the policy the owner signed off on");
    bytes32 internal constant WIDER_POLICY = keccak256("agentproof/v1 a policy with a much larger daily limit");

    uint256 internal tokenId;

    function setUp() public {
        registry = new MockPermissionedRegistry();

        vm.prank(owner);
        registrar = new AgentSubnameRegistrar(IPermissionedRegistry(address(registry)), resolver);

        // The registrar mints under the parent, so it needs the root role. In
        // production this grant is made once, by whoever controls
        // agentproof.eth.
        registry.grantRoles(ROOT_RESOURCE, registry.ROLE_REGISTRAR(), address(registrar));

        vm.prank(owner);
        tokenId = registrar.registerAgent(LABEL, account, agentSessionKey, POLICY_HASH, hook, 365 days);
    }

    // ------------------------------------------------------ the name is real

    function test_MintsTheAgentNamespaceWithItsRecords() public view {
        assertEq(registry.addr(tokenId), account, "addr must point at the smart account");
        assertEq(registry.text(tokenId, "agentproof.policy"), _hex32(POLICY_HASH));
        assertEq(registry.text(tokenId, "agentproof.hook"), _hex20(hook));
        assertEq(registry.text(tokenId, "agentproof.status"), "active");
    }

    function test_RolesEncodeTheTrustModel() public view {
        bytes32 resource = bytes32(tokenId);

        assertTrue(
            registry.hasRoles(resource, registry.ROLE_SET_POLICY_RECORD(), owner),
            "the owner must be able to repoint the policy"
        );
        assertTrue(
            registry.hasRoles(resource, registry.ROLE_SET_STATUS_RECORD(), agentSessionKey),
            "the agent must be able to suspend itself"
        );
        assertFalse(
            registry.hasRoles(resource, registry.ROLE_SET_POLICY_RECORD(), agentSessionKey),
            "the agent must NOT hold the policy role"
        );
        assertFalse(
            registry.hasRoles(resource, registry.ROLE_SET_HOOK_RECORD(), agentSessionKey),
            "the agent must NOT be able to repoint its own enforcement hook"
        );
    }

    // ------------------------------------------------------ the tamper attempt

    /**
     * Demo shot 10, first half. An operator — or a compromised agent process —
     * tries to widen the policy using the key the agent actually holds.
     */
    function test_AgentKeyCannotWidenItsOwnPolicy() public {
        // expectRevert before prank, not after: the cheatcode call itself
        // consumes a pending prank, so the reverting call would otherwise be
        // made by this test contract and the assertion would pass for the
        // wrong reason.
        vm.expectRevert(
            abi.encodeWithSelector(
                MockPermissionedRegistry.Unauthorised.selector,
                bytes32(tokenId),
                registry.ROLE_SET_POLICY_RECORD(),
                agentSessionKey
            )
        );
        vm.prank(agentSessionKey);
        registrar.setPolicyHash(LABEL, tokenId, WIDER_POLICY);

        assertEq(
            registry.text(tokenId, "agentproof.policy"), _hex32(POLICY_HASH), "the published policy must be untouched"
        );
    }

    /// @dev Demo shot 10, second half. The owner does the same thing and it works.
    function test_OwnerKeyCanRepointThePolicy() public {
        vm.prank(owner);
        registrar.setPolicyHash(LABEL, tokenId, WIDER_POLICY);

        assertEq(registry.text(tokenId, "agentproof.policy"), _hex32(WIDER_POLICY));
    }

    function test_AnOutsiderCannotRepointThePolicy() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                MockPermissionedRegistry.Unauthorised.selector,
                bytes32(tokenId),
                registry.ROLE_SET_POLICY_RECORD(),
                outsider
            )
        );
        vm.prank(outsider);
        registrar.setPolicyHash(LABEL, tokenId, WIDER_POLICY);
    }

    /**
     * The agent's one permission, exercised. This matters as much as the
     * refusals: a session key that can do nothing at all would be a simpler
     * design and a weaker claim. The agent can take itself off the field, which
     * is the action you want it to be able to take unilaterally.
     */
    function test_AgentKeyMaySuspendItself() public {
        vm.prank(agentSessionKey);
        registry.setTextAuthorised(tokenId, "agentproof.status", "suspended", agentSessionKey);

        assertEq(registry.text(tokenId, "agentproof.status"), "suspended");
    }

    function test_AgentKeyCannotRepointTheEnforcementHook() public {
        address attackerHook = makeAddr("attackerHook");

        vm.prank(agentSessionKey);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockPermissionedRegistry.Unauthorised.selector,
                bytes32(tokenId),
                registry.ROLE_SET_HOOK_RECORD(),
                agentSessionKey
            )
        );
        registry.setTextAuthorised(tokenId, "agentproof.hook", _hex20(attackerHook), agentSessionKey);

        assertEq(registry.text(tokenId, "agentproof.hook"), _hex20(hook));
    }

    // ------------------------------------------------------------ registration

    function test_AnAgentCannotRegisterItself() public {
        vm.expectRevert(AgentSubnameRegistrar.NotOwner.selector);
        vm.prank(agentSessionKey);
        registrar.registerAgent("rogue", account, agentSessionKey, POLICY_HASH, hook, 365 days);
    }

    function test_LabelCannotBeTakenTwice() public {
        vm.expectRevert(abi.encodeWithSelector(AgentSubnameRegistrar.LabelTaken.selector, LABEL));
        vm.prank(owner);
        registrar.registerAgent(LABEL, account, agentSessionKey, POLICY_HASH, hook, 365 days);
    }

    function test_UnknownAgentIsRejected() public {
        vm.expectRevert(abi.encodeWithSelector(AgentSubnameRegistrar.UnknownAgent.selector, "ghost"));
        vm.prank(owner);
        registrar.setPolicyHash("ghost", tokenId, WIDER_POLICY);
    }

    // ---------------------------------------------------------------- helpers

    function _hex32(bytes32 value) internal pure returns (string memory) {
        return _hex(uint256(value), 32);
    }

    function _hex20(address value) internal pure returns (string memory) {
        return _hex(uint256(uint160(value)), 20);
    }

    function _hex(uint256 value, uint256 length) internal pure returns (string memory) {
        bytes memory buffer = new bytes(2 * length + 2);
        buffer[0] = "0";
        buffer[1] = "x";
        for (uint256 i = 2 * length + 1; i > 1; --i) {
            uint8 nibble = uint8(value & 0xf);
            buffer[i] = nibble < 10 ? bytes1(nibble + 48) : bytes1(nibble + 87);
            value >>= 4;
        }
        return string(buffer);
    }
}
