// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";

import {AgentSubnameRegistrar} from "../src/AgentSubnameRegistrar.sol";
import {MockPermissionedRegistry} from "./mocks/MockPermissionedRegistry.sol";
import {MockPermissionedResolver} from "./mocks/MockPermissionedResolver.sol";

/**
 * The tamper attempt: the reason the ENS integration is more than a lookup.
 *
 * The claim, expressed over identity rather than funds:
 *
 *     owner key          may repoint agentproof.policy / agentproof.hook
 *     agent session key  may set agentproof.status, and nothing else
 *
 * Records live on the (mock) PermissionedResolver and every write is gated
 * by its EAC model — part resources, ADMIN-gated delegation — not by a
 * modifier on our own contract. The reverts below come from the resolver's
 * role check, except setPolicyHash's owner gate, which exists so a random
 * caller cannot spend the registrar's retained part-write.
 */
contract AgentSubnameRegistrarTest is Test {
    MockPermissionedRegistry internal registry;
    MockPermissionedResolver internal resolver;
    AgentSubnameRegistrar internal registrar;

    address internal owner = makeAddr("owner");
    address internal agentSessionKey = makeAddr("agentSessionKey");
    address internal account = makeAddr("smartAccount");
    address internal hook = makeAddr("agentPolicyHook");
    address internal outsider = makeAddr("outsider");

    string internal constant LABEL = "trader";
    bytes internal dns = "\x06trader\x0aagentproof\x03eth\x00";
    bytes32 internal node;
    bytes32 internal constant POLICY_HASH = keccak256("agentproof/v1 the policy the owner signed off on");
    bytes32 internal constant WIDER_POLICY = keccak256("agentproof/v1 a policy with a much larger daily limit");

    function setUp() public {
        node = keccak256(dns);
        registry = new MockPermissionedRegistry();
        resolver = new MockPermissionedResolver();

        vm.prank(owner);
        registrar = new AgentSubnameRegistrar(registry, resolver);

        // The registrar mints under the namespace, so it needs the root roles.
        registry.grantRootRoles((1 << 0) | (1 << 16), address(registrar));
        // …and node ADMIN so it can delegate the per-record roles below.
        resolver.authorizeNameRoles(dns, ((1 << 4) << 128) | ((1 << 0) << 128), address(registrar), true);

        vm.prank(owner);
        registrar.registerAgent(LABEL, node, dns, account, agentSessionKey, POLICY_HASH, hook, 365 days);
    }

    // ------------------------------------------------------ the name is real

    function test_MintsTheAgentNamespaceWithItsRecords() public view {
        assertEq(resolver.addr(node, 60), abi.encodePacked(account), "addr must point at the smart account");
        assertEq(resolver.text(node, "agentproof.policy"), _hex32(POLICY_HASH));
        assertEq(resolver.text(node, "agentproof.hook"), _hex20(hook));
        assertEq(resolver.text(node, "agentproof.status"), "active");
    }

    function test_RolesEncodeTheTrustModel() public view {
        // Owner holds policy + hook part-write; agent holds status only.
        assertTrue(_has(_textPart("agentproof.policy"), 1 << 4, owner), "owner writes policy");
        assertTrue(_has(_textPart("agentproof.hook"), 1 << 4, owner), "owner writes hook");
        assertTrue(_has(_textPart("agentproof.status"), 1 << 4, agentSessionKey), "agent writes status");
        assertFalse(_has(_textPart("agentproof.policy"), 1 << 4, agentSessionKey), "agent must NOT write policy");
        assertFalse(_has(_textPart("agentproof.hook"), 1 << 4, agentSessionKey), "agent must NOT write hook");
    }

    // ------------------------------------------------------ the tamper attempt

    function test_AgentKeyCannotWidenItsOwnPolicy() public {
        vm.expectRevert(AgentSubnameRegistrar.NotOwner.selector);
        vm.prank(agentSessionKey);
        registrar.setPolicyHash(LABEL, WIDER_POLICY);

        assertEq(resolver.text(node, "agentproof.policy"), _hex32(POLICY_HASH), "published policy untouched");
    }

    function test_AgentKeyCannotWritePolicyDirectly() public {
        vm.expectRevert(abi.encodeWithSelector(MockPermissionedResolver.Unauthorised.selector, agentSessionKey));
        vm.prank(agentSessionKey);
        resolver.setText(node, "agentproof.policy", _hex32(WIDER_POLICY));

        assertEq(resolver.text(node, "agentproof.policy"), _hex32(POLICY_HASH));
    }

    function test_OwnerKeyCanRepointThePolicy() public {
        vm.prank(owner);
        registrar.setPolicyHash(LABEL, WIDER_POLICY);

        assertEq(resolver.text(node, "agentproof.policy"), _hex32(WIDER_POLICY));
    }

    function test_AnOutsiderCannotRepointThePolicy() public {
        vm.expectRevert(AgentSubnameRegistrar.NotOwner.selector);
        vm.prank(outsider);
        registrar.setPolicyHash(LABEL, WIDER_POLICY);
    }

    function test_AgentKeyMaySuspendItself() public {
        vm.prank(agentSessionKey);
        registrar.suspend(LABEL);

        assertEq(resolver.text(node, "agentproof.status"), "suspended");
    }

    function test_AnOutsiderCannotSuspend() public {
        vm.expectRevert(AgentSubnameRegistrar.NotSessionKey.selector);
        vm.prank(outsider);
        registrar.suspend(LABEL);
    }

    // ------------------------------------------------------------ registration

    function test_AnAgentCannotRegisterItself() public {
        vm.expectRevert(AgentSubnameRegistrar.NotOwner.selector);
        vm.prank(agentSessionKey);
        registrar.registerAgent("rogue", node, dns, account, agentSessionKey, POLICY_HASH, hook, 365 days);
    }

    function test_LabelCannotBeTakenTwice() public {
        vm.expectRevert(abi.encodeWithSelector(AgentSubnameRegistrar.LabelTaken.selector, LABEL));
        vm.prank(owner);
        registrar.registerAgent(LABEL, node, dns, account, agentSessionKey, POLICY_HASH, hook, 365 days);
    }

    function test_UnknownAgentIsRejected() public {
        vm.expectRevert(abi.encodeWithSelector(AgentSubnameRegistrar.UnknownAgent.selector, "ghost"));
        vm.prank(owner);
        registrar.setPolicyHash("ghost", WIDER_POLICY);
    }

    // ---------------------------------------------------------------- helpers

    function _textPart(string memory key) internal view returns (uint256) {
        return uint256(keccak256(abi.encode(node, keccak256(bytes(key)))));
    }

    function _has(uint256 resource, uint256 bits, address who) internal view returns (bool) {
        return (resolver.roles(resource, who) & bits) == bits;
    }

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
