// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Lockbox, RemoteMint} from "../src/TestBridge.sol";
import {RwaixTestToken} from "../src/RwaixTestToken.sol";

contract BridgeTest is Test {
    address admin = address(0xA11CE);
    address user = address(0xB0B);
    address recipient = address(0xCA1);

    function test_relayOnceAndConserveSupply() public {
        vm.chainId(31337);
        RwaixTestToken source = new RwaixTestToken(admin);
        vm.chainId(31338);
        RwaixTestToken remote = new RwaixTestToken(admin);
        vm.chainId(31337);
        Lockbox box = new Lockbox(admin, address(source));
        vm.chainId(31338);
        RemoteMint mint = new RemoteMint(admin, remote);
        bytes32 minter = remote.MINTER();
        vm.prank(admin);
        remote.grantRole(minter, address(mint));
        vm.prank(admin);
        source.mint(user, 100 ether);
        vm.prank(user);
        source.approve(address(box), 100 ether);
        vm.prank(user);
        box.lock(bytes32("lock-1"), recipient, 40 ether, 31338);
        vm.prank(admin);
        mint.relay(31337, bytes32("lock-1"), recipient, 40 ether);
        assertEq(source.balanceOf(address(box)), 40 ether);
        assertEq(remote.balanceOf(recipient), 40 ether);
        assertEq(box.locked(), mint.minted());
        vm.prank(admin);
        vm.expectRevert(RemoteMint.Replay.selector);
        mint.relay(31337, bytes32("lock-1"), recipient, 40 ether);
        vm.prank(user);
        vm.expectRevert();
        mint.relay(31337, bytes32("lock-2"), recipient, 1 ether);
    }
}
