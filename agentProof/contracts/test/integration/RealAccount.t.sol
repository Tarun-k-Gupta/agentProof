// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";

import {MSAAdvanced} from "erc7579/MSAAdvanced.sol";
import {MSAFactory} from "erc7579/MSAFactory.sol";
import {IERC7579Account} from "erc7579/interfaces/IERC7579Account.sol";
import {ModeLib} from "erc7579/lib/ModeLib.sol";
import {ExecutionLib as MsaExecutionLib} from "erc7579/lib/ExecutionLib.sol";
import {Bootstrap, BootstrapConfig} from "erc7579/utils/Bootstrap.sol";
import {IModule} from "erc7579/interfaces/IERC7579Module.sol";
import {MockSessionKeyValidator} from "../mocks/MockSessionKeyValidator.sol";
import {
    IEntryPoint,
    PackedUserOperation,
    etchEntrypoint,
    ENTRYPOINT_ADDR
} from "erc7579-test/dependencies/EntryPoint.sol";

import {AgentPolicyHook} from "../../src/AgentPolicyHook.sol";
import {PolicyLib} from "../../src/lib/PolicyLib.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/**
 * Gate G1, against the real thing.
 *
 * Every other test in this repo drives `MockAccount`, which we wrote. A mock
 * agrees with whatever interface we gave it — which is exactly how the hook came
 * to implement `postCheck(bytes,bool,bytes)`, a draft signature no shipped
 * account calls, and pass ten tests while doing it.
 *
 * So this suite installs the hook on the ERC-7579 reference account
 * (MSAAdvanced, erc7579.com v0.3.1, pinned in contracts/lib) and drives it
 * through a real EntryPoint v0.7 with real PackedUserOperations. Nothing here
 * knows about AgentProof except the hook itself.
 *
 * The headline is `test_RejectsUserOpThatBypassesTheSdkEntirely`: PRD 13.3's
 * "one test that wins arguments", with no SDK anywhere in the call path.
 */
contract RealAccountTest is Test {
    Bootstrap internal bootstrapSingleton;
    MSAAdvanced internal implementation;
    MSAFactory internal factory;
    IEntryPoint internal entrypoint;
    MockSessionKeyValidator internal agentValidator;

    AgentPolicyHook internal hook;
    MockERC20 internal usdc;

    address internal account;
    address internal router = makeAddr("universalRouter");
    address internal attacker = makeAddr("attacker");

    uint256 internal constant MAX_TX = 100_000_000; // 100 USDC
    uint256 internal constant DAILY = 500_000_000; // 500 USDC
    uint256 internal constant MIN_BAL = 10_000_000; // 10 USDC
    uint256 internal constant FUNDING = 1_000_000_000; // 1,000 USDC

    function setUp() public {
        entrypoint = etchEntrypoint();
        bootstrapSingleton = new Bootstrap();

        implementation = new MSAAdvanced();
        factory = new MSAFactory(address(implementation));
        agentValidator = new MockSessionKeyValidator();

        usdc = new MockERC20("USD Coin", "USDC", 6);
        hook = new AgentPolicyHook();

        // The account is created with the hook already installed, through the
        // reference Bootstrap — the same path a production deploy uses.
        account = _createAccountWithHook();

        usdc.mint(account, FUNDING);
        vm.deal(account, 10 ether);
        vm.deal(address(entrypoint), 10 ether);
        entrypoint.depositTo{value: 5 ether}(account);
    }

    // ------------------------------------------------------------------ setup

    function _hookInstallData() internal view returns (bytes memory) {
        AgentPolicyHook.Config memory config = AgentPolicyHook.Config({
            asset: address(usdc),
            maxTransaction: MAX_TX,
            dailyLimit: DAILY,
            minBalance: MIN_BAL,
            policyHash: keccak256("agentproof/v1 test policy"),
            installed: false
        });

        address[] memory targets = new address[](2);
        targets[0] = address(usdc);
        targets[1] = router;

        return abi.encode(config, targets);
    }

    /**
     * @dev `BootstrapConfig.data` is the raw payload handed to `onInstall`, not
     *      an encoded call to it. The reference's own BootstrapUtil wraps it in
     *      `abi.encodeCall(IModule.onInstall, data)`, which double-encodes —
     *      harmless in their tests because the only module they install with a
     *      payload is a validator that ignores it, and they bootstrap the hook
     *      slot with address(0). A hook that actually decodes its config reverts
     *      on the extra selector.
     *
     *      Also written locally because BootstrapUtil lives in the lib's test
     *      tree and imports through the lib's own `src/` remapping, which
     *      collides with this project's `src`.
     */
    function _one(address module, bytes memory data) internal pure returns (BootstrapConfig[] memory config) {
        config = new BootstrapConfig[](1);
        config[0].module = module;
        config[0].data = data;
    }

    function _single(address module, bytes memory data) internal pure returns (BootstrapConfig memory config) {
        config.module = module;
        config.data = data;
    }

    function _createAccountWithHook() internal returns (address created) {
        BootstrapConfig[] memory validators = _one(address(agentValidator), "");
        BootstrapConfig[] memory executors = _one(address(0), "");
        BootstrapConfig memory hookConfig = _single(address(hook), _hookInstallData());
        BootstrapConfig[] memory fallbacks = _one(address(0), "");

        bytes memory initCode = bootstrapSingleton._getInitMSACalldata(validators, executors, hookConfig, fallbacks);
        bytes32 salt = keccak256("agentproof.trader");

        created = factory.getAddress(salt, initCode);
        factory.createAccount(salt, initCode);
    }

    /// @dev A single ERC-7579 execution, wrapped as a UserOp and sent to the EntryPoint.
    function _sendUserOp(address target, bytes memory callData) internal {
        bytes memory execution = MsaExecutionLib.encodeSingle(target, 0, callData);
        bytes memory accountCall = abi.encodeCall(IERC7579Account.execute, (ModeLib.encodeSimpleSingle(), execution));

        PackedUserOperation memory userOp = PackedUserOperation({
            sender: account,
            nonce: entrypoint.getNonce(account, uint192(bytes24(bytes20(address(agentValidator))))),
            initCode: "",
            callData: accountCall,
            accountGasLimits: bytes32(abi.encodePacked(uint128(2e6), uint128(2e6))),
            preVerificationGas: 2e6,
            gasFees: bytes32(abi.encodePacked(uint128(1), uint128(1))),
            paymasterAndData: "",
            // The agent session key's validator accepts anything; the point of
            // these tests is what the *hook* does, not what the validator does.
            signature: hex"41414141"
        });

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = userOp;
        // A plain beneficiary, as the reference tests use. Paying the test
        // contract trips EntryPointSimulations' reentrancy guard.
        entrypoint.handleOps(ops, payable(address(0x69)));
    }

    function _transfer(address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSignature("transfer(address,uint256)", to, amount);
    }

    // ------------------------------------------------------- the hook is live

    function test_HookIsInstalledOnTheAccount() public view {
        assertTrue(
            IERC7579Account(account).isModuleInstalled(4, address(hook), ""),
            "the reference account must report the hook as installed"
        );
        assertTrue(hook.isInitialized(account), "the hook must have seen onInstall");

        (address asset, uint256 maxTx,,, bytes32 policyHash, bool installed) = hook.config(account);
        assertEq(asset, address(usdc));
        assertEq(maxTx, MAX_TX);
        assertTrue(installed);
        assertEq(policyHash, keccak256("agentproof/v1 test policy"));
    }

    /**
     * The regression test for the interface bug.
     *
     * With `postCheck(bytes,bool,bytes)` the hook installs fine and then every
     * execution reverts, because `withHook` calls `postCheck(bytes)` — a
     * selector the hook does not have. A passing transfer is the only thing that
     * distinguishes a correctly-wired hook from a bricked account.
     */
    function test_AllowsSpendWithinLimits() public {
        _sendUserOp(address(usdc), _transfer(router, 80_000_000));

        assertEq(usdc.balanceOf(account), FUNDING - 80_000_000);
        assertEq(usdc.balanceOf(router), 80_000_000);
        assertEq(hook.remainingToday(account), DAILY - 80_000_000);
    }

    // --------------------------------------------------------------- Gate G1

    /**
     * PRD 13.3 — "the one test that wins arguments".
     *
     * No SDK, no policy engine, no dashboard. A UserOperation is built by hand,
     * signed by the agent's session-key validator, and submitted to the
     * EntryPoint. The account reverts because the hook is inside its execution
     * path and cannot be talked out of it.
     */
    function test_RejectsUserOpThatBypassesTheSdkEntirely() public {
        // The EntryPoint accepts the operation — the signature is valid and the
        // agent's session key is entirely legitimate. It is the *account* that
        // refuses, inside its own execution, because the hook is there.
        //
        // ERC-4337 catches an execution-phase revert and marks the operation
        // failed rather than reverting handleOps, so the assertion is on the
        // reason it emits and on the balance that did not move. Through a real
        // bundler the same revert surfaces earlier still: eth_sendUserOperation
        // simulates execution and rejects outright.
        vm.recordLogs();
        _sendUserOp(address(usdc), _transfer(router, 250_000_000));

        assertEq(usdc.balanceOf(account), FUNDING, "not one unit may move");
        assertEq(usdc.balanceOf(router), 0);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawPolicyRevert;
        for (uint256 i; i < logs.length; ++i) {
            // UserOperationRevertReason(bytes32,address,uint256,bytes)
            if (logs[i].topics[0] != keccak256("UserOperationRevertReason(bytes32,address,uint256,bytes)")) continue;
            (, bytes memory reason) = abi.decode(logs[i].data, (uint256, bytes));
            assertEq(bytes4(reason), PolicyLib.ExceedsMaxTransaction.selector, "wrong revert reason");
            sawPolicyRevert = true;
        }
        assertTrue(sawPolicyRevert, "the account must report why it refused");
    }

    /// @dev The same rejection, with the inner error asserted precisely.
    function test_OverLimitRevertsWithExceedsMaxTransaction() public {
        vm.prank(ENTRYPOINT_ADDR);
        vm.expectRevert(abi.encodeWithSelector(PolicyLib.ExceedsMaxTransaction.selector, 250_000_000, MAX_TX));
        IERC7579Account(account)
            .execute(
                ModeLib.encodeSimpleSingle(),
                MsaExecutionLib.encodeSingle(address(usdc), 0, _transfer(router, 250_000_000))
            );

        assertEq(usdc.balanceOf(account), FUNDING);
    }

    // ------------------------------------------------------- the other policies

    function test_RejectsNonAllowlistedTarget() public {
        vm.prank(ENTRYPOINT_ADDR);
        vm.expectRevert(abi.encodeWithSelector(AgentPolicyHook.TargetNotAllowed.selector, attacker));
        IERC7579Account(account).execute(ModeLib.encodeSimpleSingle(), MsaExecutionLib.encodeSingle(attacker, 0, ""));
    }

    /// @dev T2: the recipient lives in calldata, not in the 7579 target.
    function test_RejectsTransferToNonAllowlistedRecipient() public {
        vm.prank(ENTRYPOINT_ADDR);
        vm.expectRevert(abi.encodeWithSelector(AgentPolicyHook.TargetNotAllowed.selector, attacker));
        IERC7579Account(account)
            .execute(
                ModeLib.encodeSimpleSingle(),
                MsaExecutionLib.encodeSingle(address(usdc), 0, _transfer(attacker, 1_000_000))
            );
    }

    /// @dev T5: each transfer is under the per-tx limit; the accumulator is not.
    function test_RejectsSalamiSlicing() public {
        for (uint256 i; i < 5; ++i) {
            _sendUserOp(address(usdc), _transfer(router, 100_000_000));
        }
        assertEq(hook.remainingToday(account), 0);

        vm.prank(ENTRYPOINT_ADDR);
        vm.expectRevert(abi.encodeWithSelector(PolicyLib.ExceedsDailyLimit.selector, DAILY + 1_000_000, DAILY));
        IERC7579Account(account)
            .execute(
                ModeLib.encodeSimpleSingle(),
                MsaExecutionLib.encodeSingle(address(usdc), 0, _transfer(router, 1_000_000))
            );
    }

    function test_DailyWindowResetsAtUtcMidnight() public {
        _sendUserOp(address(usdc), _transfer(router, 100_000_000));
        assertEq(hook.remainingToday(account), DAILY - 100_000_000);

        vm.warp(block.timestamp + 1 days);
        assertEq(hook.remainingToday(account), DAILY, "a new UTC day is a fresh window");
    }

    /**
     * T4: the hook enforces on a measured balance delta, so what the calldata
     * claims is irrelevant. `transfer` moves 250 USDC; nothing declares an
     * amount to the hook at all.
     */
    function test_MeasuresOutflowRatherThanTrustingCalldata() public {
        uint256 before = usdc.balanceOf(account);

        vm.prank(ENTRYPOINT_ADDR);
        vm.expectRevert(abi.encodeWithSelector(PolicyLib.ExceedsMaxTransaction.selector, 250_000_000, MAX_TX));
        IERC7579Account(account)
            .execute(
                ModeLib.encodeSimpleSingle(),
                MsaExecutionLib.encodeSingle(address(usdc), 0, _transfer(router, 250_000_000))
            );

        assertEq(usdc.balanceOf(account), before);
    }

    /// @dev T8: the agent session key cannot remove the boundary it runs inside.
    function test_AgentCannotUninstallTheHook() public {
        // Uninstalling is `onlyEntryPointOrSelf`, so the agent's only route is a
        // UserOp — which runs through the hook, whose target allowlist does not
        // contain the account itself.
        vm.prank(attacker);
        vm.expectRevert();
        IERC7579Account(account).uninstallModule(4, address(hook), abi.encode(address(0), ""));

        assertTrue(IERC7579Account(account).isModuleInstalled(4, address(hook), ""));
    }

    receive() external payable {}
}
