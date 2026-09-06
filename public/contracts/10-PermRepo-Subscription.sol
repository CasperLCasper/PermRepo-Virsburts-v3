// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title PermRepoSubscription
 * @dev Abonementa līgums — piesaistīts GitHub kontam, nevis makam.
 *      Viens abonements aptver visus lietotāja repozitorijus.
 */
contract PermRepoSubscription is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ==================================================
    // KONSTANTES
    // ==================================================

    uint256 public constant SUBSCRIPTION_PERIOD = 30 days;
    
    // ==================================================
    // STORAGE
    // ==================================================

    IERC20 public immutable usdc;
    
    /// @notice Abonementa cena (2.5 USDC ar 6 decimālzīmēm)
    uint256 public subscriptionPrice = 2.5 * 10**6;
    
    /// @notice GitHub username hash → derīguma termiņš
    mapping(bytes32 => uint256) public subscriptionExpiry;
    
    /// @notice Uzkrātie ieņēmumi
    uint256 public withdrawableFees;

    // ==================================================
    // EVENTS
    // ==================================================

    event Subscribed(
        bytes32 indexed githubHash,
        address indexed payer,
        uint256 activeUntil,
        uint256 amount
    );

    event SubscriptionExtended(
        bytes32 indexed githubHash,
        uint256 newExpiry,
        uint256 amount
    );

    event PriceUpdated(uint256 oldPrice, uint256 newPrice);
    event FundsWithdrawn(address indexed owner, uint256 amount);

    // ==================================================
    // ERRORS
    // ==================================================

    error ZeroAddress();
    error EmptyInput();
    error InvalidPrice();
    error NoFundsToWithdraw();
    error PriceAlreadySet();

    // ==================================================
    // CONSTRUCTOR
    // ==================================================

    constructor(address usdcAddress) Ownable(msg.sender) {
        if (usdcAddress == address(0)) revert ZeroAddress();
        usdc = IERC20(usdcAddress);
    }

    // ==================================================
    // ABONĒŠANA
    // ==================================================

    /**
     * @notice Iegādājas vai pagarina abonementu GitHub kontam
     * @param githubHash GitHub username keccak256 hash
     */
    function subscribe(bytes32 githubHash) external nonReentrant {
        if (githubHash == bytes32(0)) revert EmptyInput();

        uint256 currentExpiry = subscriptionExpiry[githubHash];
        uint256 start = currentExpiry > block.timestamp ? currentExpiry : block.timestamp;
        
        uint256 newExpiry = start + SUBSCRIPTION_PERIOD;
        
        subscriptionExpiry[githubHash] = newExpiry;
        withdrawableFees += subscriptionPrice;

        // Pārskaita USDC no lietotāja uz līgumu
        usdc.safeTransferFrom(msg.sender, address(this), subscriptionPrice);

        if (currentExpiry == 0) {
            emit Subscribed(githubHash, msg.sender, newExpiry, subscriptionPrice);
        } else {
            emit SubscriptionExtended(githubHash, newExpiry, subscriptionPrice);
        }
    }

    // ==================================================
    // VIEW
    // ==================================================

    /**
     * @notice Pārbauda, vai GitHub kontam ir aktīvs abonements
     */
    function isSubscribed(bytes32 githubHash) external view returns (bool) {
        return subscriptionExpiry[githubHash] > block.timestamp;
    }

    /**
     * @notice Iegūst abonementa derīguma termiņu
     */
    function getSubscriptionExpiry(bytes32 githubHash) external view returns (uint256) {
        return subscriptionExpiry[githubHash];
    }

    /**
     * @notice Iegūst atlikušo laiku sekundēs
     */
    function getRemainingTime(bytes32 githubHash) external view returns (uint256) {
        uint256 expiry = subscriptionExpiry[githubHash];
        if (expiry <= block.timestamp) return 0;
        return expiry - block.timestamp;
    }

    // ==================================================
    // ADMIN
    // ==================================================

    function setPrice(uint256 newPrice) external onlyOwner {
        if (newPrice == 0) revert InvalidPrice();
        if (newPrice == subscriptionPrice) revert PriceAlreadySet();
        
        uint256 oldPrice = subscriptionPrice;
        subscriptionPrice = newPrice;
        
        emit PriceUpdated(oldPrice, newPrice);
    }

    function withdrawUSDC() external onlyOwner {
        uint256 balance = withdrawableFees;
        if (balance == 0) revert NoFundsToWithdraw();
        
        withdrawableFees = 0;
        usdc.safeTransfer(owner(), balance);
        
        emit FundsWithdrawn(owner(), balance);
    }
}
