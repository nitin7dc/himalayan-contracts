import { ethers, network, artifacts } from "hardhat";
import { increaseTo } from "./time";
import ORACLE_ABI from "../../constants/abis/OpynOracle.json";
import CHAINLINK_PRICER_ABI from "../../constants/abis/ChainLinkPricer.json";
import SAVAX_PRICER_ABI from "../../constants/abis/SAvaxPricer.json";
import {
  CHAINID,
  OPTION_PROTOCOL,
  GAMMA_ORACLE,
  GAMMA_WHITELIST,
  GAMMA_WHITELIST_OWNER,
  ORACLE_DISPUTE_PERIOD,
  ORACLE_LOCKING_PERIOD,
  ORACLE_OWNER,
  USDC_ADDRESS,
  APE_ADDRESS,
  WBTC_ADDRESS,
  SAVAX_ADDRESS,
  YEARN_PRICER_OWNER,
  SAVAX_PRICER,
  GAMMA_CONTROLLER,
  OTOKEN_FACTORY,
  MARGIN_POOL,
  TD_CONTROLLER,
  TD_OTOKEN_FACTORY,
  TD_MARGIN_POOL,
  TD_ORACLE,
  TD_ORACLE_OWNER,
  TD_WHITELIST,
  TD_WHITELIST_OWNER,
} from "../../constants/constants";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signers";
import { BigNumber, BigNumberish, Contract } from "ethers";
import { wmul } from "../helpers/math";

const { provider, getContractAt } = ethers;
const { parseEther } = ethers.utils;
const chainId = network.config.chainId;

export async function deployProxy(
  logicContractName: string,
  adminSigner: SignerWithAddress,
  initializeArgs: any[], // eslint-disable-line @typescript-eslint/no-explicit-any
  logicDeployParams = [],
  factoryOptions = {}
) {
  const AdminUpgradeabilityProxy = await ethers.getContractFactory(
    "AdminUpgradeabilityProxy",
    adminSigner
  );
  const LogicContract = await ethers.getContractFactory(
    logicContractName,
    factoryOptions || {}
  );
  const logic = await LogicContract.deploy(...logicDeployParams);

  const initBytes = LogicContract.interface.encodeFunctionData(
    "initialize",
    initializeArgs
  );

  const proxy = await AdminUpgradeabilityProxy.deploy(
    logic.address,
    await adminSigner.getAddress(),
    initBytes
  );
  return await ethers.getContractAt(logicContractName, proxy.address);
}

export async function parseLog(
  contractName: string,
  log: { topics: string[]; data: string }
) {
  if (typeof contractName !== "string") {
    throw new Error("contractName must be string");
  }
  const abi = (await artifacts.readArtifact(contractName)).abi;
  const iface = new ethers.utils.Interface(abi);
  const event = iface.parseLog(log);
  return event;
}

export const forceSend = async (receiver: string, amount: string) => {
  const forceSendContract = await ethers.getContractFactory("ForceSend");
  const forceSend = await forceSendContract.deploy(); // Some contract do not have receive(), so we force send
  await forceSend.deployed();
  await forceSend.go(receiver, {
    value: parseEther(amount),
  });
};

export async function getAssetPricer(pricer: string) {
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [pricer],
  });

  const ownerSigner = await provider.getSigner(pricer);

  const pricerContract = await ethers.getContractAt("IYearnPricer", pricer);

  await forceSend(pricer, "0.5");

  return await pricerContract.connect(ownerSigner);
}

export async function setAssetPricer(
  asset: string,
  pricer: string,
  protocol: OPTION_PROTOCOL
) {
  const oracleAddr =
    protocol === OPTION_PROTOCOL.GAMMA
      ? GAMMA_ORACLE[chainId]
      : TD_ORACLE[chainId];
  const oracleOwnerAddr =
    protocol === OPTION_PROTOCOL.GAMMA
      ? ORACLE_OWNER[chainId]
      : TD_ORACLE_OWNER[chainId];

  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [oracleOwnerAddr],
  });

  const ownerSigner = await provider.getSigner(oracleOwnerAddr);

  const oracle = await ethers.getContractAt("IOracle", oracleAddr);

  await oracle.connect(ownerSigner).setAssetPricer(asset, pricer);
}

export async function whitelistProduct(
  underlying: string,
  strike: string,
  collateral: string,
  isPut: boolean,
  protocol: OPTION_PROTOCOL
) {
  const [adminSigner] = await ethers.getSigners();
  const whitelistAddr =
    protocol === OPTION_PROTOCOL.GAMMA
      ? GAMMA_WHITELIST[chainId]
      : TD_WHITELIST[chainId];
  const whitelistOwnerAddr =
    protocol === OPTION_PROTOCOL.GAMMA
      ? GAMMA_WHITELIST_OWNER[chainId]
      : TD_WHITELIST_OWNER[chainId];

  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [whitelistOwnerAddr],
  });

  const ownerSigner = await provider.getSigner(whitelistOwnerAddr);

  const whitelist = await ethers.getContractAt(
    "IGammaWhitelist",
    whitelistAddr
  );

  await adminSigner.sendTransaction({
    to: whitelistOwnerAddr,
    value: parseEther("5"),
  });

  await whitelist.connect(ownerSigner).whitelistCollateral(collateral);

  await whitelist
    .connect(ownerSigner)
    .whitelistProduct(underlying, strike, collateral, isPut);
}

export async function setupOracle(
  assetAddr: string,
  chainlinkPricer: string,
  signer: SignerWithAddress,
  protocol: OPTION_PROTOCOL
) {
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [chainlinkPricer],
  });

  const oracleAddr =
    protocol === OPTION_PROTOCOL.GAMMA
      ? GAMMA_ORACLE[chainId]
      : TD_ORACLE[chainId];
  const oracleOwnerAddr =
    protocol === OPTION_PROTOCOL.GAMMA
      ? ORACLE_OWNER[chainId]
      : TD_ORACLE_OWNER[chainId];

  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [oracleOwnerAddr],
  });
  const oracleOwnerSigner = await provider.getSigner(oracleOwnerAddr);

  const pricerSigner = await provider.getSigner(chainlinkPricer);

  await forceSend(chainlinkPricer, "1");

  const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, pricerSigner);

  await signer.sendTransaction({
    to: oracleOwnerAddr,
    value: parseEther("1"),
  });

  await oracle
    .connect(oracleOwnerSigner)
    .setStablePrice(USDC_ADDRESS[chainId], "100000000");

  if (protocol === OPTION_PROTOCOL.GAMMA) {
    await oracle
      .connect(oracleOwnerSigner)
      .setAssetPricer(assetAddr, chainlinkPricer);
  } else {
    await oracle
      .connect(oracleOwnerSigner)
      .updateAssetPricer(assetAddr, chainlinkPricer);
  }

  return oracle;
}

export async function setOpynOracleExpiryPrice(
  asset: string,
  oracle: Contract,
  pricer: string,
  expiry: BigNumber,
  settlePrice: BigNumber
) {
  const lockingPeriod = await oracle.getPricerLockingPeriod(pricer);
  const disputePeriod = await oracle.getPricerDisputePeriod(pricer);

  // NOTE: There's a timing issue due to the above RPCs pushing the timestamp forward,
  // adjust the block number a bit into the past to account for this
  await increaseTo(expiry.toNumber() + lockingPeriod.toNumber());

  const pricerSigner = await impersonate(pricer);
  const res = await oracle
    .connect(pricerSigner)
    .setExpiryPrice(asset, expiry, settlePrice);
  const receipt = await res.wait();
  const timestamp = (await provider.getBlock(receipt.blockNumber)).timestamp;
  await increaseTo(timestamp + disputePeriod.toNumber());
}

export async function setOpynOracleExpiryPriceYearn(
  underlyingAsset: string,
  underlyingOracle: Contract,
  underlyingSettlePrice: BigNumber,
  collateralPricer: Contract,
  expiry: BigNumber
) {
  await increaseTo(expiry.toNumber() + ORACLE_LOCKING_PERIOD + 1);

  const res = await underlyingOracle.setExpiryPrice(
    underlyingAsset,
    expiry,
    underlyingSettlePrice
  );
  await res.wait();
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [YEARN_PRICER_OWNER],
  });

  const oracleOwnerSigner = await provider.getSigner(YEARN_PRICER_OWNER);
  const res2 = await collateralPricer
    .connect(oracleOwnerSigner)
    .setExpiryPriceInOracle(expiry);
  const receipt = await res2.wait();

  const timestamp = (await provider.getBlock(receipt.blockNumber)).timestamp;
  await increaseTo(timestamp + ORACLE_DISPUTE_PERIOD + 1);
}

export async function addMinter(
  contract: Contract,
  contractOwner: string,
  minter: string
) {
  const tokenOwnerSigner = await ethers.provider.getSigner(contractOwner);

  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [contractOwner],
  });

  await forceSend(contractOwner, "10");

  await contract.connect(tokenOwnerSigner).addMinter(minter);

  await network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [contractOwner],
  });
}

export async function mintToken(
  contract: Contract,
  contractOwner: string,
  recipient: string,
  spender: string,
  amount: BigNumberish
) {
  const tokenOwnerSigner = await ethers.provider.getSigner(contractOwner);

  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [contractOwner],
  });

  await forceSend(contractOwner, "10");

  if (isBridgeToken(chainId, contract.address)) {
    // Avax mainnet uses BridgeTokens which have a special mint function
    const txid = ethers.utils.formatBytes32String("Hello World!");
    await contract
      .connect(tokenOwnerSigner)
      .mint(recipient, amount, recipient, 0, txid);
  } else if (
    contract.address === USDC_ADDRESS[chainId] ||
    contract.address === SAVAX_ADDRESS[chainId] ||
    contract.address === APE_ADDRESS[chainId] ||
    chainId === CHAINID.AURORA_MAINNET
  ) {
    await contract.connect(tokenOwnerSigner).transfer(recipient, amount);
  } else {
    await contract.connect(tokenOwnerSigner).mint(recipient, amount);
  }

  const recipientSigner = await ethers.provider.getSigner(recipient);
  await contract.connect(recipientSigner).approve(spender, amount);

  await network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [contractOwner],
  });
}

export const isBridgeToken = (chainId: number, address: string) =>
  chainId === CHAINID.AVAX_MAINNET &&
  (address === WBTC_ADDRESS[chainId] || address === USDC_ADDRESS[chainId]);

export async function bidForOToken(
  gnosisAuction: Contract,
  assetContract: Contract,
  contractSigner: string,
  oToken: string,
  premium: BigNumber,
  assetDecimals: number,
  multiplier: string,
  auctionDuration: number
) {
  const userSigner = await ethers.provider.getSigner(contractSigner);

  const latestAuction = (await gnosisAuction.auctionCounter()).toString();
  const totalOptionsAvailableToBuy = BigNumber.from(
    await (
      await ethers.getContractAt("IERC20", oToken)
    ).balanceOf(gnosisAuction.address)
  )
    .mul(await gnosisAuction.FEE_DENOMINATOR())
    .div(
      (await gnosisAuction.FEE_DENOMINATOR()).add(
        await gnosisAuction.feeNumerator()
      )
    )
    .div(multiplier);

  let bid = wmul(
    totalOptionsAvailableToBuy.mul(BigNumber.from(10).pow(10)),
    premium
  );
  bid =
    assetDecimals > 18
      ? bid.mul(BigNumber.from(10).pow(assetDecimals - 18))
      : bid.div(BigNumber.from(10).pow(18 - assetDecimals));

  const queueStartElement =
    "0x0000000000000000000000000000000000000000000000000000000000000001";

  await assetContract
    .connect(userSigner)
    .approve(gnosisAuction.address, bid.toString());

  // BID OTOKENS HERE
  await gnosisAuction
    .connect(userSigner)
    .placeSellOrders(
      latestAuction,
      [totalOptionsAvailableToBuy.toString()],
      [bid.toString()],
      [queueStartElement],
      "0x"
    );

  await increaseTo(
    (await provider.getBlock("latest")).timestamp + auctionDuration
  );

  return [latestAuction, totalOptionsAvailableToBuy, bid];
}

export async function lockedBalanceForRollover(vault: Contract) {
  let currentBalance = await vault.totalBalance();
  let newPricePerShare = await vault.pricePerShare();

  let queuedWithdrawAmount = await sharesToAsset(
    (
      await vault.vaultState()
    ).queuedWithdrawShares,
    newPricePerShare,
    (
      await vault.vaultParams()
    ).decimals
  );

  let balanceSansQueued = currentBalance.sub(queuedWithdrawAmount);
  return [balanceSansQueued, queuedWithdrawAmount];
}

export async function closeAuctionAndClaim(
  gnosisAuction: Contract,
  thetaVault: Contract,
  vault: Contract,
  signer: string
) {
  const userSigner = await ethers.provider.getSigner(signer);
  await gnosisAuction
    .connect(userSigner)
    .settleAuction(await thetaVault.optionAuctionID());
  await vault.claimAuctionOtokens();
}

export interface Order {
  sellAmount: BigNumber;
  buyAmount: BigNumber;
  userId: BigNumber;
}

export function decodeOrder(bytes: string): Order {
  return {
    userId: BigNumber.from("0x" + bytes.substring(2, 18)),
    sellAmount: BigNumber.from("0x" + bytes.substring(43, 66)),
    buyAmount: BigNumber.from("0x" + bytes.substring(19, 42)),
  };
}

export function encodeOrder(order: Order): string {
  return (
    "0x" +
    order.userId.toHexString().slice(2).padStart(16, "0") +
    order.buyAmount.toHexString().slice(2).padStart(24, "0") +
    order.sellAmount.toHexString().slice(2).padStart(24, "0")
  );
}

async function sharesToAsset(
  shares: BigNumber,
  assetPerShare: BigNumber,
  decimals: BigNumber
) {
  return shares
    .mul(assetPerShare)
    .div(BigNumber.from(10).pow(decimals.toString()));
}

/* eslint @typescript-eslint/no-explicit-any: "off" */
export const objectEquals = (a: any, b: any) => {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  if (!a || !b || (typeof a !== "object" && typeof b !== "object"))
    return a === b;
  /* eslint no-undefined: "off" */
  if (a === null || a === undefined || b === null || b === undefined)
    return false;
  if (a.prototype !== b.prototype) return false;
  let keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => objectEquals(a[k], b[k]));
};

export const serializeMap = (map: Record<string, unknown>) => {
  return Object.fromEntries(
    Object.keys(map).map((key) => {
      return [key, serializeToObject(map[key])];
    })
  );
};

export const serializeToObject = (solidityValue: unknown) => {
  if (BigNumber.isBigNumber(solidityValue)) {
    return solidityValue.toString();
  }
  // Handle structs recursively
  if (Array.isArray(solidityValue)) {
    return solidityValue.map((val) => serializeToObject(val));
  }
  return solidityValue;
};

export const getDeltaStep = (asset: string) => {
  switch (asset) {
    case "WBTC":
      return BigNumber.from("1000");
    case "AAVE":
      return BigNumber.from("10");
    case "SAVAX":
    case "NEAR":
    case "AURORA":
    case "APE":
      return BigNumber.from("5");
    case "SUSHI":
      return BigNumber.from("1");
    case "WETH":
      if (chainId === CHAINID.AVAX_MAINNET) {
        return BigNumber.from("3");
      }
      return BigNumber.from("100");
    default:
      throw new Error(`Delta Step not found for asset: ${asset}`);
  }
};

export const getPricerABI = (pricer: string) => {
  switch (pricer) {
    case SAVAX_PRICER:
      return SAVAX_PRICER_ABI;
    default:
      return CHAINLINK_PRICER_ABI;
  }
};

export const getPricerAsset = async (pricer: Contract) => {
  switch (pricer.address) {
    case SAVAX_PRICER:
      return await pricer.sAVAX();
    default:
      return await pricer.asset();
  }
};

export const getProtocolAddresses = (
  protocol: OPTION_PROTOCOL,
  chainId: number
) => {
  switch (protocol) {
    case OPTION_PROTOCOL.GAMMA:
      return [
        GAMMA_CONTROLLER[chainId],
        OTOKEN_FACTORY[chainId],
        MARGIN_POOL[chainId],
        ORACLE_OWNER[chainId],
      ];
    case OPTION_PROTOCOL.TD:
      return [
        TD_CONTROLLER[chainId],
        TD_OTOKEN_FACTORY[chainId],
        TD_MARGIN_POOL[chainId],
        TD_ORACLE_OWNER[chainId],
      ];
    default:
      throw new Error("Protocol not found");
  }
};

export const getNextOptionReadyAt = async (vault: Contract) => {
  const optionState = await vault.optionState();
  return optionState.nextOptionReadyAt;
};

export const getCurrentOptionExpiry = async (vault: Contract) => {
  const currentOption = await vault.currentOption();
  const otoken = await getContractAt("IOtoken", currentOption);
  return otoken.expiryTimestamp();
};

export const isDisputePeriodOver = async (asset: string, expiry: number) => {
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [ORACLE_OWNER[chainId]],
  });

  const oracle = await ethers.getContractAt("IOracle", GAMMA_ORACLE[chainId]);
  return oracle.isDisputePeriodOver(asset, expiry);
};

export const rollToNextOption = async (
  vault: Contract,
  strikeSelection: Contract
) => {
  const ownerSigner = await impersonate(await strikeSelection.owner());
  const keeperSigner = await impersonate(await vault.keeper());

  await sendEth(await ownerSigner.getAddress(), "10");

  await vault.connect(keeperSigner).commitAndClose();
  await strikeSelection.connect(ownerSigner).setDelta(BigNumber.from("1000"));
  await vault.connect(keeperSigner).rollToNextOption();
};

export const sendEth = async (receiver: string, amount: string) => {
  const WHALE_WALLET = {
    [CHAINID.ETH_MAINNET]: "0x72a53cdbbcc1b9efa39c834a540550e23463aacb",
    [CHAINID.AVAX_MAINNET]: "0x4aefa39caeadd662ae31ab0ce7c8c2c9c0a013e8",
  };
  const whaleSigner = await impersonate(WHALE_WALLET[chainId]);
  await whaleSigner.sendTransaction({
    to: receiver,
    value: parseEther(amount),
  });
};

export const impersonate = async (address: string) => {
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [address],
  });
  return await provider.getSigner(address);
};

export const resetBlock = async (jsonRpcUrl: string, blockNumber: number) => {
  await network.provider.request({
    method: "hardhat_reset",
    params: [
      {
        forking: {
          jsonRpcUrl,
          blockNumber,
        },
      },
    ],
  });
};
