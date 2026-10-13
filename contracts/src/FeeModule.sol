// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Roles} from "./Roles.sol";
import {TokenRegistry} from "./TokenRegistry.sol";

/// @notice Fee quotes, reservations, and coverage.
/// @dev Rights-distribution obligations cannot be drawn here. OUTCOME_UNKNOWN keeps coverage.
contract FeeModule is Roles {
    enum Kind {
        None,
        Service,
        NetworkFee,
        Rights
    }
    enum Outcome {
        None,
        Reserved,
        Unknown,
        Confirmed,
        Failed
    }

    struct Obligation {
        Kind kind;
        bytes32 assetId;
        uint256 approved;
        uint256 covered;
        bool hasUnknown;
        bool exists;
    }

    struct Quote {
        bytes32 assetId;
        address token;
        uint8 decimals_;
        uint256 maxDebit;
        uint256 settled;
        uint256 consumed;
        uint64 expiry;
        bytes32 obligationId;
        bool exists;
    }

    struct Attempt {
        bytes32 obligationId;
        bytes32 assetId;
        uint256 amount;
        Outcome outcome;
        bool exists;
    }

    TokenRegistry public immutable registry;
    mapping(bytes32 => Obligation) public obligations;
    mapping(bytes32 => Quote) public quotes;
    mapping(bytes32 => Attempt) public attempts;

    error NotFound();
    error StateConflict();
    error FeeRightMismatch();
    error AssetMismatch();
    error DecimalsMismatch();
    error QuoteExpired();
    error PriceDeviation();
    error Overspend();
    error OutcomeUnknown();
    error DuplicateAttempt();

    event Reserved(bytes32 indexed obligationId, bytes32 indexed attemptId, uint256 amount);
    event OutcomeChanged(bytes32 indexed attemptId, Outcome outcome);

    constructor(address admin, TokenRegistry registry_) {
        registry = registry_;
        _grant(DEFAULT_ADMIN, admin);
        _grant(FEE_OPERATOR, admin);
        _grant(PAUSER, admin);
    }

    function openObligation(bytes32 id, Kind kind, bytes32 assetId, uint256 approved) external onlyRole(FEE_OPERATOR) whenNotPaused {
        if (obligations[id].exists) revert StateConflict();
        if (kind == Kind.None) revert StateConflict();
        obligations[id] = Obligation(kind, assetId, approved, 0, false, true);
    }

    function acceptQuote(
        bytes32 quoteId,
        bytes32 assetId,
        address token,
        uint8 decimals_,
        uint256 maxDebit,
        uint256 settled,
        uint64 expiry,
        bytes32 obligationId
    ) external onlyRole(FEE_OPERATOR) whenNotPaused {
        if (quotes[quoteId].exists) revert StateConflict();
        TokenRegistry.Asset memory asset = registry.get(assetId);
        if (!asset.exists || asset.token != token) revert AssetMismatch();
        if (asset.decimals != decimals_) revert DecimalsMismatch();
        Obligation storage obligation = obligations[obligationId];
        if (!obligation.exists) revert NotFound();
        if (obligation.kind == Kind.Rights) revert FeeRightMismatch();
        if (obligation.assetId != assetId) revert AssetMismatch();
        if (block.timestamp > expiry) revert QuoteExpired();
        if (settled > maxDebit) revert PriceDeviation();
        quotes[quoteId] = Quote(assetId, token, decimals_, maxDebit, settled, 0, expiry, obligationId, true);
    }

    function reserveQuote(bytes32 quoteId, bytes32 attemptId, uint256 executionDebit) external onlyRole(FEE_OPERATOR) whenNotPaused {
        Quote storage quote = quotes[quoteId];
        if (!quote.exists) revert NotFound();
        if (block.timestamp > quote.expiry) revert QuoteExpired();
        if (executionDebit > quote.maxDebit) revert PriceDeviation();
        _reserve(quote.obligationId, attemptId, quote.assetId, quote.settled);
        quote.consumed += quote.settled;
    }

    function reserve(bytes32 obligationId, bytes32 attemptId, bytes32 assetId, uint256 amount) external onlyRole(FEE_OPERATOR) whenNotPaused {
        _reserve(obligationId, attemptId, assetId, amount);
    }

    function markUnknown(bytes32 attemptId) external onlyRole(FEE_OPERATOR) whenNotPaused {
        Attempt storage attempt = attempts[attemptId];
        if (!attempt.exists || attempt.outcome == Outcome.Failed) revert StateConflict();
        attempt.outcome = Outcome.Unknown;
        obligations[attempt.obligationId].hasUnknown = true;
        emit OutcomeChanged(attemptId, Outcome.Unknown);
    }

    function confirmFailed(bytes32 attemptId) external onlyRole(FEE_OPERATOR) whenNotPaused {
        Attempt storage attempt = attempts[attemptId];
        if (!attempt.exists) revert NotFound();
        if (attempt.outcome == Outcome.Unknown || obligations[attempt.obligationId].hasUnknown) revert OutcomeUnknown();
        if (attempt.outcome == Outcome.Confirmed) revert StateConflict();
        obligations[attempt.obligationId].covered -= attempt.amount;
        attempt.outcome = Outcome.Failed;
        emit OutcomeChanged(attemptId, Outcome.Failed);
    }

    function coverage(bytes32 obligationId) external view returns (uint256) {
        return obligations[obligationId].covered;
    }

    function _reserve(bytes32 obligationId, bytes32 attemptId, bytes32 assetId, uint256 amount) internal {
        Obligation storage obligation = obligations[obligationId];
        if (!obligation.exists) revert NotFound();
        if (obligation.kind == Kind.Rights) revert FeeRightMismatch();
        if (obligation.hasUnknown) revert OutcomeUnknown();
        if (obligation.assetId != assetId) revert AssetMismatch();
        if (attempts[attemptId].exists) revert DuplicateAttempt();
        if (obligation.covered + amount > obligation.approved) revert Overspend();
        obligation.covered += amount;
        attempts[attemptId] = Attempt(obligationId, assetId, amount, Outcome.Reserved, true);
        emit Reserved(obligationId, attemptId, amount);
    }
}
