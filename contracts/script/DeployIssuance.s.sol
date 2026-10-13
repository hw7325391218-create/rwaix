// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {RwaixDcnft} from "../src/RwaixDcnft.sol";
import {RwaixToken} from "../src/RwaixToken.sol";

/// @notice Deploys the $RWAIX ERC-20 shell and the DCNFT shell. Does not mint.
/// @dev Chain id 1 also requires RWAIX_MAINNET_OPT_IN=1 and RWAIX_MAINNET_CONFIRMATION=MAINNET,
///      which the shell wrapper sets only after the operator types MAINNET.
///      The signer is the forge sender (hardware wallet or an unlocked local fork account).
///      This script has no private key. It does not grant MINTER or REGISTRAR.
contract DeployIssuance is Script {
    function run() external returns (RwaixToken token, RwaixDcnft dcnft) {
        uint256 id = block.chainid;
        if (id == 1) {
            require(keccak256(bytes(vm.envString("RWAIX_MAINNET_OPT_IN"))) == keccak256(bytes("1")), "mainnet opt-in missing");
            require(
                keccak256(bytes(vm.envString("RWAIX_MAINNET_CONFIRMATION"))) == keccak256(bytes("MAINNET")),
                "typed MAINNET confirmation missing"
            );
        } else if (id != 11155111 && id != 31337) {
            revert("unsupported chain");
        }

        address admin = msg.sender;
        vm.startBroadcast();
        token = new RwaixToken(admin);
        dcnft = new RwaixDcnft(admin);
        vm.stopBroadcast();

        require(token.totalSupply() == 0, "premine");
        require(token.issuanceEnabled() == false, "issuance enabled");
        require(token.hasRole(token.MINTER(), admin) == false, "minter granted");
        require(dcnft.issuanceEnabled() == false, "dcnft issuance enabled");
        require(dcnft.hasRole(dcnft.REGISTRAR(), admin) == false, "registrar granted");
        require(dcnft.transfersEnabled() == false, "transfers enabled");
    }
}
