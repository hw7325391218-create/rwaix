// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Roles} from "./Roles.sol";

/// @notice One claim per service, provider, and period. Allocated budget is not freed by a second address.
contract RewardModule is Roles {
    struct Claim {
        uint256 amount;
        bool exists;
        bool claimed;
    }

    mapping(bytes32 => uint256) public budgetCap;
    mapping(bytes32 => uint256) public budgetAllocated;
    mapping(bytes32 => bool) public usedKey;
    mapping(bytes32 => Claim) public claims;

    error Overspend();
    error DuplicateReward();
    error NotFound();

    event RewardApproved(bytes32 indexed claimId, uint256 amount);
    event RewardClaimed(bytes32 indexed claimId);

    constructor(address admin) {
        _grant(DEFAULT_ADMIN, admin);
        _grant(REWARD_APPROVER, admin);
        _grant(PAUSER, admin);
    }

    function setBudget(bytes32 period, uint256 cap) external onlyRole(REWARD_APPROVER) whenNotPaused {
        if (cap < budgetAllocated[period]) revert Overspend();
        budgetCap[period] = cap;
    }

    function approve(bytes32 claimId, bytes32 serviceId, address provider, bytes32 period, uint256 amount)
        external
        onlyRole(REWARD_APPROVER)
        whenNotPaused
    {
        bytes32 key = keccak256(abi.encode(serviceId, provider, period));
        if (usedKey[key] || claims[claimId].exists) revert DuplicateReward();
        if (budgetAllocated[period] + amount > budgetCap[period]) revert Overspend();
        usedKey[key] = true;
        budgetAllocated[period] += amount;
        claims[claimId] = Claim(amount, true, false);
        emit RewardApproved(claimId, amount);
    }

    function claim(bytes32 claimId) external whenNotPaused {
        Claim storage stored = claims[claimId];
        if (!stored.exists) revert NotFound();
        if (stored.claimed) revert DuplicateReward();
        stored.claimed = true;
        emit RewardClaimed(claimId);
    }
}
