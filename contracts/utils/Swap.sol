// SPDX-License-Identifier: MIT
// Source: https://github.com/airswap/airswap-protocols/blob/main/source/swap/contracts/Swap.sol

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "../interfaces/ISwap.sol";
import {IERC20Detailed} from "../interfaces/IERC20Detailed.sol";
import {SafeMath} from "@openzeppelin/contracts/utils/math/SafeMath.sol";

contract Swap is ISwap, Ownable {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256(
            abi.encodePacked(
                "EIP712Domain(",
                "string name,",
                "string version,",
                "uint256 chainId,",
                "address verifyingContract",
                ")"
            )
        );

    bytes32 public constant BID_TYPEHASH =
        keccak256(
            abi.encodePacked(
                "Bid(",
                "uint256 swapId,",
                "uint256 nonce,",
                "address signerWallet,",
                "uint256 sellAmount,",
                "uint256 buyAmount,",
                "address referrer",
                ")"
            )
        );

    bytes32 public constant DOMAIN_NAME = keccak256("RIBBON SWAP");
    bytes32 public constant DOMAIN_VERSION = keccak256("1");
    uint256 public immutable DOMAIN_CHAIN_ID;
    bytes32 public immutable DOMAIN_SEPARATOR;

    uint256 internal constant MAX_PERCENTAGE = 10000;
    uint256 internal constant MAX_ERROR_COUNT = 7;

    uint256 public offersCounter = 0;

    mapping(uint256 => Offer) public swapOffers;

    mapping(address => uint256) public referralFees;

    /**
     * @notice Double mapping of signers to nonce groups to nonce states
     * @dev The nonce group is computed as nonce / 256, so each group of 256 sequential nonces uses the same key
     * @dev The nonce states are encoded as 256 bits, for each nonce in the group 0 means available and 1 means used
     */
    mapping(address => mapping(uint256 => uint256)) internal _nonceGroups;

    /************************************************
     *  CONSTRUCTOR
     ***********************************************/

    constructor() {
        uint256 currentChainId = getChainId();
        DOMAIN_CHAIN_ID = currentChainId;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                DOMAIN_NAME,
                DOMAIN_VERSION,
                currentChainId,
                this
            )
        );
    }

    /************************************************
     *  SETTER
     ***********************************************/

    /**
     * @notice Sets the referral fee for a specific referrer
     * @param referrer is the address of the referrer
     * @param fee is the fee in percent in 2 decimals
     */
    function setFee(address referrer, uint256 fee) external onlyOwner {
        require(referrer != address(0), "!referrer");
        require(fee < MAX_PERCENTAGE, "Fee exceeds maximum");

        referralFees[referrer] = fee;
    }

    /************************************************
     *  OFFER CREATION AND SETTLEMENT
     ***********************************************/

    /**
     * @notice Create a new offer available for swap
     * @param offeredToken token offered by seller
     * @param biddingToken token asked by seller
     * @param minPrice minimum price of offeredToken in terms of biddingToken
     * @param minBidSize minimum size allowed in terms of biddingToken
     * @param totalSize amount of offeredToken offered by seller
     */
    function createOffer(
        address offeredToken,
        address biddingToken,
        uint96 minPrice,
        uint96 minBidSize,
        uint128 totalSize
    ) external override returns (uint256 swapId) {
        require(offeredToken != address(0), "!offeredToken");
        require(biddingToken != address(0), "!biddingToken");
        require(minPrice > 0, "!minPrice");
        require(minBidSize > 0, "!minBidSize");
        require(totalSize > 0, "!totalSize");

        offersCounter += 1;

        swapId = offersCounter;

        swapOffers[swapId] = Offer({
            seller: msg.sender,
            offeredToken: offeredToken,
            biddingToken: biddingToken,
            isOpen: true,
            minBidSize: minBidSize,
            minPrice: minPrice,
            totalSize: totalSize,
            availableSize: totalSize,
            totalSales: 0
        });

        emit NewOffer(
            swapId,
            msg.sender,
            offeredToken,
            biddingToken,
            minPrice,
            minBidSize,
            totalSize
        );
    }

    /**
     * @notice Settles the swap offering by iterating through the bids
     * @param swapId unique identifier of the swap offer
     * @param bids bids for swaps
     */
    function settleOffer(uint256 swapId, Bid[] calldata bids)
        external
        override
    {
        Offer storage offer = swapOffers[swapId];

        require(offer.seller != address(0), "Offer does not exist");
        require(msg.sender == offer.seller, "Only seller can settle");
        require(offer.isOpen, "Offer already closed");

        for (uint256 i = 0; i < bids.length; i++) {
            _swap(offer, bids[i]);
        }

        if (offer.availableSize == 0) {
            offer.isOpen = false;

            emit SettleOffer(swapId);
        }
    }

    /**
     * @notice Close offer
     * @param swapId swapId unique identifier of the swap offer
     */
    function closeOffer(uint256 swapId) external override {
        Offer storage offer = swapOffers[swapId];
        require(offer.seller != address(0), "Offer does not exist");
        require(msg.sender == offer.seller, "Only seller can close offer");
        require(offer.isOpen, "Offer already closed");

        offer.isOpen = false;

        emit CloseOffer(swapId);
    }

    /**
     * @notice Cancel one or more nonces
     * @dev Cancelled nonces are marked as used
     * @dev Emits a Cancel event
     * @dev Out of gas may occur in arrays of length > 400
     * @param nonces uint256[] List of nonces to cancel
     */
    function cancelNonce(uint256[] calldata nonces) external override {
        for (uint256 i = 0; i < nonces.length; i++) {
            uint256 nonce = nonces[i];
            if (_markNonceAsUsed(msg.sender, nonce)) {
                emit Cancel(nonce, msg.sender);
            }
        }
    }

    /************************************************
     *  PUBLIC VIEW FUNCTIONS
     ***********************************************/

    /**
     * @notice Validates Swap bid for any potential errors
     * @param bid Bid struct containing bid details
     * @return tuple of error count and bytes32[] memory array of error messages
     */
    function check(Bid calldata bid)
        public
        view
        returns (uint256, bytes32[] memory)
    {
        Offer memory offer = swapOffers[bid.swapId];
        require(offer.seller != address(0), "Offer does not exist");

        bytes32[] memory errors = new bytes32[](MAX_ERROR_COUNT);

        uint256 errCount;

        // Check signature
        address signatory = _getSignatory(bid);

        if (signatory == address(0)) {
            errors[errCount] = "SIGNATURE_INVALID";
            errCount++;
        }

        if (signatory != bid.signerWallet) {
            errors[errCount] = "SIGNATURE_MISMATCHED";
            errCount++;
        }

        // Check nonce
        if (nonceUsed(signatory, bid.nonce)) {
            errors[errCount] = "NONCE_ALREADY_USED";
            errCount++;
        }

        // Check bid size
        if (bid.buyAmount < offer.minBidSize) {
            errors[errCount] = "BID_TOO_SMALL";
            errCount++;
        }

        // Check bid price
        uint256 offeredTokenDecimals =
            IERC20Detailed(offer.offeredToken).decimals();
        uint256 bidPrice =
            bid.sellAmount.mul(uint256(10)**offeredTokenDecimals).div(
                bid.buyAmount
            );
        if (bidPrice < offer.minPrice) {
            errors[errCount] = "PRICE_TOO_LOW";
            errCount++;
        }

        // Check signer allowance
        uint256 signerAllowance =
            IERC20(offer.biddingToken).allowance(
                bid.signerWallet,
                address(this)
            );
        if (signerAllowance < bid.sellAmount) {
            errors[errCount] = "SIGNER_ALLOWANCE_LOW";
            errCount++;
        }

        // Check signer balance
        uint256 signerBalance =
            IERC20(offer.biddingToken).balanceOf(bid.signerWallet);
        if (signerBalance < bid.sellAmount) {
            errors[errCount] = "SIGNER_BALANCE_LOW";
            errCount++;
        }

        return (errCount, errors);
    }

    /**
     * @notice Returns true if the nonce has been used
     * @param signer address Address of the signer
     * @param nonce uint256 Nonce being checked
     */
    function nonceUsed(address signer, uint256 nonce)
        public
        view
        override
        returns (bool)
    {
        uint256 groupKey = nonce / 256;
        uint256 indexInGroup = nonce % 256;
        return (_nonceGroups[signer][groupKey] >> indexInGroup) & 1 == 1;
    }

    /************************************************
     *  INTERNAL FUNCTIONS
     ***********************************************/

    /**
     * @notice Swap Atomic ERC20 Swap
     * @param offer Offer struct containing offer details
     * @param bid Bid struct containing bid details
     */
    function _swap(Offer storage offer, Bid calldata bid) internal {
        require(DOMAIN_CHAIN_ID == getChainId(), "CHAIN_ID_CHANGED");

        address signatory = _getSignatory(bid);
        require(signatory != address(0), "SIGNATURE_INVALID");
        require(signatory == bid.signerWallet, "SIGNATURE_MISMATCHED");
        require(_markNonceAsUsed(signatory, bid.nonce), "NONCE_ALREADY_USED");
        require(offer.availableSize > 0, "ZERO_AVAILABLE_SIZE");
        require(bid.buyAmount >= offer.minBidSize, "BID_TOO_SMALL");

        // Ensure min. price is met
        uint256 offeredTokenDecimals =
            IERC20Detailed(offer.offeredToken).decimals();
        uint256 bidPrice =
            bid.sellAmount.mul(uint256(10)**offeredTokenDecimals).div(
                bid.buyAmount
            );
        require(bidPrice >= offer.minPrice, "PRICE_TOO_LOW");

        // Check for partial fill
        uint256 buyAmount =
            bid.buyAmount <= offer.availableSize
                ? bid.buyAmount
                : offer.availableSize;

        uint256 sellAmount =
            bid.buyAmount <= offer.availableSize
                ? bid.sellAmount
                : buyAmount.mul(bidPrice).div(
                    uint256(10)**offeredTokenDecimals
                );

        // Transfer token from sender to signer
        IERC20(offer.offeredToken).safeTransferFrom(
            offer.seller,
            bid.signerWallet,
            buyAmount
        );

        // Transfer to referrer if any
        uint256 feeAmount;
        uint256 feePercent = referralFees[bid.referrer];
        if (feePercent > 0) {
            feeAmount = sellAmount.mul(feePercent).div(MAX_PERCENTAGE);

            IERC20(offer.biddingToken).safeTransferFrom(
                bid.signerWallet,
                bid.referrer,
                feeAmount
            );
        }

        // Transfer token from signer to recipient
        IERC20(offer.biddingToken).safeTransferFrom(
            bid.signerWallet,
            offer.seller,
            sellAmount.sub(feeAmount)
        );

        offer.availableSize -= uint128(buyAmount);
        offer.totalSales += sellAmount;

        // Emit a Swap event
        emit Swap(
            bid.swapId,
            bid.nonce,
            bid.signerWallet,
            sellAmount,
            offer.seller,
            buyAmount,
            bid.referrer,
            feeAmount
        );
    }

    /**
     * @notice Marks a nonce as used for the given signer
     * @param signer address Address of the signer for which to mark the nonce as used
     * @param nonce uint256 Nonce to be marked as used
     * @return bool True if the nonce was not marked as used already
     */
    function _markNonceAsUsed(address signer, uint256 nonce)
        internal
        returns (bool)
    {
        uint256 groupKey = nonce / 256;
        uint256 indexInGroup = nonce % 256;
        uint256 group = _nonceGroups[signer][groupKey];

        // If it is already used, return false
        if ((group >> indexInGroup) & 1 == 1) {
            return false;
        }

        _nonceGroups[signer][groupKey] = group | (uint256(1) << indexInGroup);

        return true;
    }

    /**
     * @notice Recover the signatory from a signature
     * @param bid Bid struct containing bid details
     */
    function _getSignatory(Bid calldata bid) internal view returns (address) {
        return
            ecrecover(
                keccak256(
                    abi.encodePacked(
                        "\x19\x01",
                        DOMAIN_SEPARATOR,
                        keccak256(
                            abi.encode(
                                BID_TYPEHASH,
                                bid.swapId,
                                bid.nonce,
                                bid.signerWallet,
                                bid.sellAmount,
                                bid.buyAmount,
                                bid.referrer
                            )
                        )
                    )
                ),
                bid.v,
                bid.r,
                bid.s
            );
    }

    /**
     * @notice Returns the current chainId using the chainid opcode
     * @return id uint256 The chain id
     */
    function getChainId() internal view returns (uint256 id) {
        // no-inline-assembly
        assembly {
            id := chainid()
        }
    }
}