// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Roles} from "./Roles.sol";

/// @notice Local/testnet placeholder for the proposed $RWAIX network token.
/// @dev Not an issued asset. Minting is refused on Ethereum mainnet (chain id 1).
///      CAP follows the whitepaper's candidate one-billion design budget. It is not an approved issuance or allocation.
contract RwaixTestToken is Roles {
    string public constant name = "RWAIX Test";
    string public constant symbol = "RWAIX_TEST";
    uint8 public constant decimals = 18;
    uint256 public constant CAP = 1_000_000_000 ether;
    string public constant disclaimer = "TESTNET_PLACEHOLDER_NOT_A_NETWORK_TOKEN_ISSUANCE";

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    error CapExceeded();
    error Insufficient();

    event Transfer(address indexed from, address indexed to, uint256 amount);

    constructor(address admin) {
        if (block.chainid == 1) revert MainnetForbidden();
        _grant(DEFAULT_ADMIN, admin);
        _grant(MINTER, admin);
        _grant(PAUSER, admin);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER) onlyNonMainnet whenNotPaused {
        if (totalSupply + amount > CAP) revert CapExceeded();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external whenNotPaused returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external whenNotPaused returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert Insufficient();
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (balanceOf[from] < amount) revert Insufficient();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
