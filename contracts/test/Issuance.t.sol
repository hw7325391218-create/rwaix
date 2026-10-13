// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuard} from "../src/ReentrancyGuard.sol";
import {Roles} from "../src/Roles.sol";
import {RwaixDcnft} from "../src/RwaixDcnft.sol";
import {RwaixToken} from "../src/RwaixToken.sol";
import {SupplyLedger} from "../src/SupplyLedger.sol";
import {ITransferFrom, Lockbox} from "../src/TestBridge.sol";

contract ReenteringToken is ITransferFrom {
    Lockbox public box;
    bool public entered;

    function setBox(Lockbox box_) external {
        box = box_;
    }

    function transferFrom(address, address, uint256 amount) external returns (bool) {
        if (!entered) {
            entered = true;
            box.lock(bytes32("nested"), address(this), amount, 1);
        }
        return true;
    }
}

contract IssuanceTest is Test {
    address admin = address(0xA11CE);
    address user = address(0xBEEF);
    address pauser = address(0xCA1FE);

    RwaixToken token;
    RwaixDcnft dcnft;
    bytes32 adminRole;
    bytes32 minterRole;
    bytes32 pauserRole;
    bytes32 registrarRole;

    function setUp() public {
        token = new RwaixToken(admin);
        dcnft = new RwaixDcnft(admin);
        adminRole = token.DEFAULT_ADMIN();
        minterRole = token.MINTER();
        pauserRole = token.PAUSER();
        registrarRole = dcnft.REGISTRAR();
    }

    function test_deployOnMainnetMintsNothing() public {
        vm.chainId(1);
        RwaixToken live = new RwaixToken(admin);
        RwaixDcnft nft = new RwaixDcnft(admin);
        assertEq(live.totalSupply(), 0);
        assertEq(live.balanceOf(admin), 0);
        assertFalse(live.issuanceEnabled());
        assertFalse(live.hasRole(live.MINTER(), admin));
        assertFalse(nft.issuanceEnabled());
        assertFalse(nft.hasRole(nft.REGISTRAR(), admin));
        assertFalse(nft.transfersEnabled());
        assertEq(nft.balanceOf(admin), 0);
    }

    function test_mintStaysBehindUnusedRoleAndDisabledGate() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Roles.Unauthorized.selector, minterRole));
        token.mint(user, 1 ether);

        vm.prank(admin);
        token.grantRole(minterRole, admin);
        vm.prank(admin);
        vm.expectRevert(RwaixToken.IssuanceDisabled.selector);
        token.mint(user, 1 ether);
        assertEq(token.totalSupply(), 0);
    }

    function test_strangerCannotEnableIssuanceOrGrantMinter() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Roles.Unauthorized.selector, adminRole));
        token.enableIssuance();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Roles.Unauthorized.selector, adminRole));
        token.grantRole(minterRole, user);
    }

    function test_dcnftMintAndTransferStayClosed() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Roles.Unauthorized.selector, registrarRole));
        dcnft.mint(user, 1, bytes32("series"), bytes32("rights"), "ipfs://test");

        vm.prank(admin);
        dcnft.grantRole(registrarRole, admin);
        vm.prank(admin);
        vm.expectRevert(RwaixDcnft.IssuanceDisabled.selector);
        dcnft.mint(user, 1, bytes32("series"), bytes32("rights"), "ipfs://test");

        vm.prank(user);
        vm.expectRevert(RwaixDcnft.TransfersDisabled.selector);
        dcnft.transferFrom(user, admin, 1);
    }

    function test_pauseBlocksTransferAndEmergencyPauseIsBounded() public {
        vm.prank(admin);
        token.enableIssuance();
        vm.prank(admin);
        token.grantRole(minterRole, admin);
        vm.prank(admin);
        token.mint(admin, 5 ether);
        vm.prank(admin);
        token.transfer(user, 1 ether);

        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Roles.Unauthorized.selector, pauserRole));
        token.pause(1 hours);

        vm.prank(admin);
        vm.expectRevert(Roles.PauseDuration.selector);
        token.pause(0);
        vm.prank(admin);
        vm.expectRevert(Roles.PauseDuration.selector);
        token.pause(8 days);

        vm.prank(admin);
        token.emergencyPause();
        assertEq(token.pausedUntil(), uint64(block.timestamp + 7 days));
        vm.prank(admin);
        vm.expectRevert(Roles.Paused.selector);
        token.transfer(user, 1 ether);

        vm.prank(user);
        token.approve(admin, 1 ether);

        vm.prank(admin);
        token.unpause();
        vm.prank(admin);
        token.transfer(user, 1 ether);
        assertEq(token.balanceOf(user), 2 ether);
    }

    function test_revokePauserAndRejectZeroAdmin() public {
        vm.prank(admin);
        token.grantRole(pauserRole, pauser);
        vm.prank(admin);
        token.revokeRole(pauserRole, pauser);
        vm.prank(pauser);
        vm.expectRevert(abi.encodeWithSelector(Roles.Unauthorized.selector, pauserRole));
        token.emergencyPause();

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Roles.Unauthorized.selector, adminRole));
        token.revokeRole(adminRole, admin);

        vm.expectRevert(Roles.ZeroAddress.selector);
        new RwaixToken(address(0));
        vm.expectRevert(Roles.ZeroAddress.selector);
        new RwaixDcnft(address(0));
    }

    function test_transferDoesNotCallbackRecipient() public {
        vm.startPrank(admin);
        token.enableIssuance();
        token.grantRole(minterRole, admin);
        token.mint(admin, 1 ether);
        vm.stopPrank();
        Sink sink = new Sink();
        vm.prank(admin);
        token.transfer(address(sink), 1 ether);
        assertEq(token.balanceOf(address(sink)), 1 ether);
        assertEq(sink.calls(), 0);
    }

    function test_lockboxReentrancyReverts() public {
        ReenteringToken evil = new ReenteringToken();
        Lockbox box = new Lockbox(admin, address(evil));
        evil.setBox(box);
        vm.expectRevert(ReentrancyGuard.Reentered.selector);
        box.lock(bytes32("first"), user, 1 ether, 31338);
        assertEq(box.locked(), 0);
        assertEq(box.locks(bytes32("first")), 0);
    }

    function test_pausedSupplyCannotMint() public {
        SupplyLedger supply = new SupplyLedger(admin, 1000 ether);
        vm.prank(admin);
        supply.emergencyPause();
        vm.prank(admin);
        vm.expectRevert(Roles.Paused.selector);
        supply.mintNative(1 ether);
    }
}

contract Sink {
    uint256 public calls;

    receive() external payable {
        calls += 1;
    }
}
