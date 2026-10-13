// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {EntryPoint4337, SimpleAccount} from "../src/EntryPoint4337.sol";

contract Counter {
    uint256 public value;
    function bump() external { value += 1; }
}

contract Account4337Test is Test {
    function test_sessionKeyScopeExpiryAndNonce() public {
        uint256 ownerKey = 0xA11CE;
        uint256 sessionKey = 0xBEEF;
        address owner = vm.addr(ownerKey);
        address session = vm.addr(sessionKey);
        EntryPoint4337 entry = new EntryPoint4337();
        bytes32 scope = keccak256("render");
        SimpleAccount account = new SimpleAccount(owner, address(entry), session, uint64(block.timestamp + 1 days), scope);
        Counter counter = new Counter();
        bytes memory callData = abi.encodeWithSelector(SimpleAccount.execute.selector, address(counter), 0, abi.encodeWithSelector(Counter.bump.selector));
        EntryPoint4337.UserOperation memory op = EntryPoint4337.UserOperation({
            sender: address(account),
            nonce: 0,
            callData: callData,
            validUntil: uint64(block.timestamp + 1 hours),
            scopeHash: scope,
            signature: ""
        });
        bytes32 hash = entry.getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionKey, hash);
        op.signature = abi.encodePacked(r, s, v);
        entry.handleOp(op);
        assertEq(counter.value(), 1);
        vm.expectRevert(EntryPoint4337.BadNonce.selector);
        entry.handleOp(op);
        op.nonce = 1;
        op.scopeHash = keccak256("other");
        hash = entry.getUserOpHash(op);
        (v, r, s) = vm.sign(sessionKey, hash);
        op.signature = abi.encodePacked(r, s, v);
        vm.expectRevert(SimpleAccount.Scope.selector);
        entry.handleOp(op);
        op.scopeHash = scope;
        op.validUntil = uint64(block.timestamp + 3 days);
        hash = entry.getUserOpHash(op);
        (v, r, s) = vm.sign(sessionKey, hash);
        op.signature = abi.encodePacked(r, s, v);
        vm.expectRevert(SimpleAccount.Expired.selector);
        entry.handleOp(op);
    }
}
