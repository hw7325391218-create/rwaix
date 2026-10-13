// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BondModule} from "../src/BondModule.sol";
import {Dcnft} from "../src/Dcnft.sol";
import {Eip712Action} from "../src/Eip712Action.sol";
import {FeeModule} from "../src/FeeModule.sol";
import {FinalityGate} from "../src/FinalityGate.sol";
import {ObjectRegistry} from "../src/ObjectRegistry.sol";
import {RewardModule} from "../src/RewardModule.sol";
import {Roles} from "../src/Roles.sol";
import {RwaixTestToken} from "../src/RwaixTestToken.sol";
import {SupplyLedger} from "../src/SupplyLedger.sol";
import {TokenRegistry} from "../src/TokenRegistry.sol";

contract ReferenceTest is Test {
    address admin = address(0xA11CE);
    address user = address(0xBEEF);
    address slasher = address(0x511CE);
    address releaser = address(0xB0B);

    RwaixTestToken token;
    Dcnft dcnft;
    ObjectRegistry registry;
    TokenRegistry assets;
    FeeModule fees;
    BondModule bonds;
    RewardModule rewards;
    SupplyLedger supply;
    FinalityGate finality;
    Eip712Action eip712;

    bytes32 constant RWAIX = keccak256("RWAIX_TEST");
    bytes32 constant USD = keccak256("USD_TEST");
    address constant USD_TOKEN = address(0x00000000000000000000000000000000000000D5);

    function setUp() public {
        token = new RwaixTestToken(admin);
        dcnft = new Dcnft(admin);
        registry = new ObjectRegistry(admin);
        assets = new TokenRegistry(admin);
        fees = new FeeModule(admin, assets);
        bonds = new BondModule(admin);
        rewards = new RewardModule(admin);
        supply = new SupplyLedger(admin, 1000 ether);
        finality = new FinalityGate(admin);
        eip712 = new Eip712Action();

        vm.startPrank(admin);
        assets.register(RWAIX, address(token), 18);
        assets.register(USD, USD_TOKEN, 2);
        bonds.grantRole(keccak256("BOND_RELEASE"), releaser);
        bonds.grantRole(keccak256("SLASHER"), slasher);
        vm.stopPrank();
    }

    function test_section22_feeRightMismatch() public {
        vm.prank(admin);
        fees.openObligation(bytes32("rights"), FeeModule.Kind.Rights, USD, 100);
        vm.prank(admin);
        vm.expectRevert(FeeModule.FeeRightMismatch.selector);
        fees.reserve(bytes32("rights"), bytes32("a1"), USD, 1);
    }

    function test_section22_wrongContractAndDecimals() public {
        vm.prank(admin);
        vm.expectRevert(TokenRegistry.DecimalsMismatch.selector);
        assets.register(keccak256("bad-decimals"), address(token), 6);

        vm.prank(admin);
        fees.openObligation(bytes32("fee"), FeeModule.Kind.NetworkFee, RWAIX, 1000);
        vm.prank(admin);
        vm.expectRevert(FeeModule.AssetMismatch.selector);
        fees.acceptQuote(bytes32("q-contract"), RWAIX, address(0x1234), 18, 100, 80, uint64(block.timestamp + 1 days), bytes32("fee"));
        vm.prank(admin);
        vm.expectRevert(FeeModule.DecimalsMismatch.selector);
        fees.acceptQuote(bytes32("q-decimals"), RWAIX, address(token), 6, 100, 80, uint64(block.timestamp + 1 days), bytes32("fee"));
    }

    function test_section22_expiredQuoteAndPriceJump() public {
        vm.startPrank(admin);
        fees.openObligation(bytes32("fee"), FeeModule.Kind.NetworkFee, RWAIX, 1000);
        uint64 expiry = uint64(block.timestamp + 1 hours);
        fees.acceptQuote(bytes32("q1"), RWAIX, address(token), 18, 100, 80, expiry, bytes32("fee"));
        vm.warp(expiry + 1);
        vm.expectRevert(FeeModule.QuoteExpired.selector);
        fees.reserveQuote(bytes32("q1"), bytes32("a1"), 80);
        vm.warp(expiry - 10);
        vm.expectRevert(FeeModule.PriceDeviation.selector);
        fees.reserveQuote(bytes32("q1"), bytes32("a1"), 150);
        (, , , , , uint256 consumed, , , ) = fees.quotes(bytes32("q1"));
        assertEq(consumed, 0);
        fees.reserveQuote(bytes32("q1"), bytes32("a1"), 90);
        (, , , , , consumed, , , ) = fees.quotes(bytes32("q1"));
        assertEq(consumed, 80);
        vm.stopPrank();
    }

    function test_section22_concurrentOverspendAndUnknownPayment() public {
        vm.startPrank(admin);
        fees.openObligation(bytes32("fee"), FeeModule.Kind.NetworkFee, RWAIX, 100);
        fees.reserve(bytes32("fee"), bytes32("a1"), RWAIX, 60);
        vm.expectRevert(FeeModule.Overspend.selector);
        fees.reserve(bytes32("fee"), bytes32("a2"), RWAIX, 50);
        assertEq(fees.coverage(bytes32("fee")), 60);
        fees.markUnknown(bytes32("a1"));
        vm.expectRevert(FeeModule.OutcomeUnknown.selector);
        fees.reserve(bytes32("fee"), bytes32("a3"), keccak256("OTHER"), 1);
        vm.expectRevert(FeeModule.OutcomeUnknown.selector);
        fees.confirmFailed(bytes32("a1"));
        assertEq(fees.coverage(bytes32("fee")), 60);
        vm.stopPrank();
    }

    function test_section22_duplicateReward() public {
        vm.startPrank(admin);
        rewards.setBudget(bytes32("2026-10"), 100);
        rewards.approve(bytes32("c1"), bytes32("job"), user, bytes32("2026-10"), 40);
        vm.expectRevert(RewardModule.DuplicateReward.selector);
        rewards.approve(bytes32("c2"), bytes32("job"), user, bytes32("2026-10"), 40);
        vm.stopPrank();
        rewards.claim(bytes32("c1"));
        vm.expectRevert(RewardModule.DuplicateReward.selector);
        rewards.claim(bytes32("c1"));
        assertEq(rewards.budgetAllocated(bytes32("2026-10")), 40);
    }

    function test_section22_unauthorizedSlash() public {
        vm.prank(admin);
        bonds.lock(bytes32("b1"), user, RWAIX, 10);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(Roles.Unauthorized.selector, keccak256("SLASHER")));
        bonds.slash(bytes32("b1"));
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(Roles.Unauthorized.selector, keccak256("SLASHER")));
        bonds.slash(bytes32("b1"));
        vm.prank(releaser);
        vm.expectRevert(abi.encodeWithSelector(Roles.Unauthorized.selector, keccak256("SLASHER")));
        bonds.slash(bytes32("b1"));
        vm.prank(slasher);
        bonds.slash(bytes32("b1"));
        (, , , BondModule.State state) = bonds.bonds(bytes32("b1"));
        assertEq(uint256(state), uint256(BondModule.State.Slashed));
    }

    function test_section22_bridgeDoubleSupply() public {
        vm.startPrank(admin);
        supply.mintNative(1000 ether);
        supply.lockForBridge(bytes32("lock"), 100 ether);
        assertEq(supply.outstanding(), 1000 ether);
        supply.bridgeMint(bytes32("msg-1"), bytes32("lock"), 100 ether);
        vm.expectRevert(SupplyLedger.DoubleSupply.selector);
        supply.bridgeMint(bytes32("msg-1"), bytes32("lock"), 100 ether);
        vm.expectRevert(SupplyLedger.DoubleSupply.selector);
        supply.bridgeMint(bytes32("msg-2"), bytes32("lock"), 100 ether);
        vm.expectRevert(SupplyLedger.DoubleSupply.selector);
        supply.mintNative(1);
        assertEq(supply.circulating(), 1000 ether);
        assertEq(supply.outstanding(), 1000 ether);
        vm.stopPrank();
    }

    function test_section22_accessWithoutEitherToken() public {
        assertEq(token.balanceOf(user), 0);
        assertEq(dcnft.balanceOf(user), 0);
        vm.prank(user);
        registry.register(bytes32("obj"), user);
        assertTrue(registry.verificationOpen(user));
        (ObjectRegistry.Lifecycle state,,) = registry.objects(bytes32("obj"));
        assertEq(uint256(state), uint256(ObjectRegistry.Lifecycle.Draft));
    }

    function test_lifecyclePauseFinalityAndMetadata() public {
        vm.startPrank(admin);
        registry.register(bytes32("obj"), admin);
        registry.publish(bytes32("obj"), 1, bytes32("digest-1"));
        registry.publish(bytes32("obj"), 2, bytes32("digest-2"));
        assertEq(registry.versionDigest(bytes32("obj"), 1), bytes32("digest-1"));
        registry.transition(bytes32("obj"), ObjectRegistry.Lifecycle.Revoked);
        vm.expectRevert();
        registry.publish(bytes32("obj"), 3, bytes32("digest-3"));
        vm.expectRevert(Roles.PauseDuration.selector);
        registry.pause(8 days);
        registry.pause(1 days);
        vm.stopPrank();
        vm.expectRevert(Roles.Paused.selector);
        vm.prank(user);
        registry.register(bytes32("other"), user);

        vm.prank(admin);
        dcnft.mint(user, 1, bytes32("series"), bytes32("rights"), "ipfs://frozen");
        vm.expectRevert(Dcnft.MetadataFrozen.selector);
        dcnft.setTokenURI(1, "ipfs://changed");
        vm.prank(user);
        vm.expectRevert(Dcnft.TransfersDisabled.selector);
        dcnft.transferFrom(user, admin, 1);

        vm.startPrank(admin);
        finality.setInclusion(bytes32("op"), FinalityGate.Inclusion.Included);
        vm.stopPrank();
        vm.expectRevert(FinalityGate.FinalityNotReached.selector);
        finality.consume(bytes32("op"));
        vm.prank(admin);
        finality.setInclusion(bytes32("op"), FinalityGate.Inclusion.Reorged);
        vm.expectRevert(FinalityGate.Reorged.selector);
        finality.consume(bytes32("op"));
        vm.prank(admin);
        finality.setInclusion(bytes32("op"), FinalityGate.Inclusion.Final);
        assertTrue(finality.consume(bytes32("op")));
    }

    function test_mainnetMintIsRefused() public {
        vm.chainId(1);
        vm.expectRevert(Roles.MainnetForbidden.selector);
        new RwaixTestToken(admin);
        vm.prank(admin);
        vm.expectRevert(Roles.MainnetForbidden.selector);
        token.mint(user, 1);
    }

    function test_eip712ActionDigestMatchesTypescript() public {
        bytes32 payload = hex"abababababababababababababababababababababababababababababababab";
        bytes32 got = eip712.digest(
            31337,
            address(0x0000000000000000000000000000000000000001),
            "rwaix-0.1.0",
            "executeIntent",
            "rwaix:reference",
            "nonce-0001",
            1791763200,
            payload
        );
        assertEq(got, hex"4051484867bb06e748faac44ed73229ff2f6b1c6b736c21d619e0621ca2f8fe0");
    }
}
