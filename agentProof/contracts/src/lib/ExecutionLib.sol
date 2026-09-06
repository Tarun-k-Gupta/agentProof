// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title ExecutionLib
 * @notice Decodes the ERC-7579 `execute(bytes32 mode, bytes executionCalldata)`
 *         payload the account passes into a hook's preCheck.
 *
 * @dev ExecutionMode layout (ERC-7579):
 *        [0]      CallType     0x00 single | 0x01 batch | 0xff delegatecall
 *        [1]      ExecType
 *        [2:6]    unused
 *        [6:10]   ModeSelector
 *        [10:32]  ModePayload
 *
 *      MVP scope: CALLTYPE_SINGLE only. Batch and delegatecall revert.
 *      This is a deliberate, documented scope limit — a batch that splits a
 *      spend across calls is a real bypass of a per-call target check, so
 *      rejecting batches is the safe default rather than the lazy one.
 */
library ExecutionLib {
    bytes1 internal constant CALLTYPE_SINGLE = 0x00;
    bytes1 internal constant CALLTYPE_BATCH = 0x01;
    bytes1 internal constant CALLTYPE_DELEGATECALL = 0xff;

    // execute(bytes32,bytes)
    bytes4 internal constant EXECUTE_SELECTOR = 0xe9ae5c53;
    // executeFromExecutor(bytes32,bytes)
    bytes4 internal constant EXECUTE_FROM_EXECUTOR_SELECTOR = 0xd691c964;

    error UnsupportedCallType(bytes1 callType);
    error UnsupportedSelector(bytes4 selector);
    error MalformedExecution();

    // ERC-20 selectors whose counterparty we can recover from calldata.
    bytes4 internal constant TRANSFER = 0xa9059cbb; // transfer(address,uint256)
    bytes4 internal constant APPROVE = 0x095ea7b3; // approve(address,uint256)
    bytes4 internal constant TRANSFER_FROM = 0x23b872dd; // transferFrom(address,address,uint256)

    /**
     * @notice Returns the target and inner calldata of a single ERC-7579
     *         execution.
     * @dev Single execution packs abi.encodePacked(target, value, callData).
     */
    function decodeSingleExecution(bytes calldata msgData)
        internal
        pure
        returns (address target, bytes calldata innerCalldata)
    {
        if (msgData.length < 4) revert MalformedExecution();

        bytes4 sel = bytes4(msgData[0:4]);
        if (sel != EXECUTE_SELECTOR && sel != EXECUTE_FROM_EXECUTOR_SELECTOR) {
            revert UnsupportedSelector(sel);
        }

        bytes32 mode;
        uint256 dataOffset;
        uint256 dataLength;
        assembly {
            mode := calldataload(add(msgData.offset, 4))
            // offset of the `bytes executionCalldata` head, relative to args
            let rel := calldataload(add(msgData.offset, 36))
            dataOffset := add(add(msgData.offset, 4), add(rel, 32))
            dataLength := calldataload(sub(dataOffset, 32))
        }

        bytes1 callType = bytes1(mode);
        if (callType != CALLTYPE_SINGLE) revert UnsupportedCallType(callType);
        if (dataLength < 52) revert MalformedExecution();

        assembly {
            target := shr(96, calldataload(dataOffset))
            // target (20) + value (32) = 52 bytes of prefix
            innerCalldata.offset := add(dataOffset, 52)
            innerCalldata.length := sub(dataLength, 52)
        }
    }

    /**
     * @notice Recovers the counterparty (recipient or spender) of a known ERC-20
     *         call. Returns address(0) for shapes we do not recognise, which the
     *         caller treats as "no counterparty claim to check".
     * @dev DECODED provenance. Never used to size a spend — only to decide
     *      whether a known-shaped call points somewhere allowlisted. The amount
     *      that matters is measured in postCheck.
     */
    function decodeErc20Counterparty(bytes calldata callData) internal pure returns (address) {
        if (callData.length < 4) return address(0);
        bytes4 sel = bytes4(callData[0:4]);

        if (sel == TRANSFER || sel == APPROVE) {
            if (callData.length < 68) revert MalformedExecution();
            return address(uint160(uint256(bytes32(callData[4:36]))));
        }
        if (sel == TRANSFER_FROM) {
            if (callData.length < 100) revert MalformedExecution();
            return address(uint160(uint256(bytes32(callData[36:68])))); // `to`
        }
        return address(0);
    }
}
