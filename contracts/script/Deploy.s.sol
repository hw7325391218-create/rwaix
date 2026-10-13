// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {BondModule} from "../src/BondModule.sol";
import {Dcnft} from "../src/Dcnft.sol";
import {EntryPoint4337, SimpleAccount} from "../src/EntryPoint4337.sol";
import {FeeModule} from "../src/FeeModule.sol";
import {FinalityGate} from "../src/FinalityGate.sol";
import {ObjectRegistry} from "../src/ObjectRegistry.sol";
import {RewardModule} from "../src/RewardModule.sol";
import {RwaixTestToken} from "../src/RwaixTestToken.sol";
import {SupplyLedger} from "../src/SupplyLedger.sol";
import {Lockbox, RemoteMint} from "../src/TestBridge.sol";
import {TokenRegistry} from "../src/TokenRegistry.sol";

/// @notice Deploys the reference contracts to a local Anvil chain only.
/// Chain 31337 receives the registry, the lock side, and the local 4337 account.
/// Chain 31338 receives the remote mint side. Neither path accepts chain id 1.
contract Deploy is Script {
    function run() external {
        uint256 id = block.chainid;
        require(id == 31337 || id == 31338, "refusing non-local chain");
        address admin = msg.sender;
        vm.startBroadcast();
        RwaixTestToken token = new RwaixTestToken(admin);
        if (id == 31337) {
            new Dcnft(admin);
            new ObjectRegistry(admin);
            TokenRegistry registry = new TokenRegistry(admin);
            new FeeModule(admin, registry);
            new BondModule(admin);
            new RewardModule(admin);
            new SupplyLedger(admin, 1_000_000_000 ether);
            new FinalityGate(admin);
            new Lockbox(admin, address(token));
            EntryPoint4337 entry = new EntryPoint4337();
            new SimpleAccount(admin, address(entry), admin, uint64(block.timestamp + 365 days), bytes32(0));
        } else {
            new RemoteMint(admin, token);
        }
        vm.stopBroadcast();
    }
}
