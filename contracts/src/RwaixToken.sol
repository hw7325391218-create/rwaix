// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "./ReentrancyGuard.sol";
import {Roles} from "./Roles.sol";

/// @notice Deployable $RWAIX ERC-20 shell.
/// @dev Construction grants admin and pauser only. It does not mint, premine, or sell.
///      MINTER is not granted. `issuanceEnabled` stays false until a later transaction
///      that this repository's deploy script never sends. Turning issuance on, and
///      granting MINTER, requires legal and compliance sign-off outside this codebase.
///      This contract is not a certification that the token is a permitted instrument.
contract RwaixToken is Roles, ReentrancyGuard {
    string public constant name = "RWAIX";
    string public constant symbol = "RWAIX";
    uint8 public constant decimals = 18;
    string public constant issuanceNotice = "ISSUANCE_DISABLED_UNTIL_LEGAL_AND_COMPLIANCE_SIGNOFF";

    uint256 public totalSupply;
    bool public issuanceEnabled;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    error IssuanceDisabled();
    error Insufficient();

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event IssuanceEnabled(address indexed admin);

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grant(DEFAULT_ADMIN, admin);
        _grant(PAUSER, admin);
    }

    /// @notice Opens the issuance gate. Does not grant MINTER and does not mint.
    ///         Legal and compliance sign-off is required before anyone sends this transaction.
    function enableIssuance() external onlyRole(DEFAULT_ADMIN) {
        issuanceEnabled = true;
        emit IssuanceEnabled(msg.sender);
    }

    function mint(address to, uint256 amount) external nonReentrant onlyRole(MINTER) whenNotPaused {
        if (!issuanceEnabled) revert IssuanceDisabled();
        if (to == address(0) || amount == 0) revert ZeroAddress();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == address(0)) revert ZeroAddress();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external nonReentrant whenNotPaused returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external nonReentrant whenNotPaused returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert Insufficient();
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        if (balanceOf[from] < amount) revert Insufficient();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
