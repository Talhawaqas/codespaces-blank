// app/api/orgs/documents/[documentId]/versions/route.js
//
// POST /api/orgs/documents/:documentId/versions
//   { orgId, filename, fileHash, sizeBytes, cidAlpha, cidBeta }
//   Uploads a NEW version of an existing document, linked via
//   documentGroupId. Reuses the exact same on-chain-registration + plan-
//   quota logic as the original upload route (api/orgs/documents/route.js)
//   — intentionally duplicated rather than extracted into a shared helper,
//   matching that route's own header comment ("duplicated from
//   settlePaygUpload... isn't worth the risk to something already working
//   in production"). Any signing request still active against the OLD
//   version is auto-superseded (signing-workflow.js's
//   supersedeActiveSigningRequests) — a signature collected against one
//   version can never carry over to another.

import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../../lib/orgs.js";
import { getDocumentAccessLevel, meetsLevel } from "../../../../../../lib/document-permissions.js";
import { logDocumentActivity } from "../../../../../../lib/document-workflow.js";
import { supersedeActiveSigningRequests } from "../../../../../../lib/signing-workflow.js";
import { getOrgPlan, getOrgUsage } from "../../../../../../lib/orgPlans.js";

const BYTES_PER_MB = 1048576;
const BYTES_PER_GB = 1073741824;
const RPC_URL = process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545";
const CUSTODY_ADDRESS = "0x7F5E6cF1353beEE4fc19FD46Dd6EaD0B3895a888";
const USDT_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_MOCK_USDT_ADDRESS;
const INAYA_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_INAYA_TOKEN_ADDRESS;
const TREASURY_WALLET_PRIVATE_KEY = process.env.TREASURY_WALLET_PRIVATE_KEY;
const GB = 1073741824n;

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];
const CUSTODY_ABI = [
  "function batchRegisterAssets(bytes32[] fileHashes, uint256[] fileSizes, string[] shardACIDs, string[] shardBCIDs) external",
  "function usdtFeePerGB() public view returns (uint256)",
  "function inayaFeePerGB() public view returns (uint256)",
];

export const maxDuration = 60;

export async function POST(req, { params }) {
  try {
    const { documentId } = params;
    const { orgId, filename, fileHash, sizeBytes, cidAlpha, cidBeta } = await req.json();
    if (!orgId || !filename || !fileHash || !sizeBytes || !cidAlpha || !cidBeta) {
      return NextResponse.json({ error: "orgId, filename, fileHash, sizeBytes, cidAlpha, and cidBeta are required." }, { status: 400 });
    }

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { orgs, orgDocuments } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const previousDoc = await orgDocuments.findOne({ _id: toObjectId(documentId), orgId: orgObjectId, deletedAt: null });
    if (!previousDoc) return NextResponse.json({ error: "Document not found." }, { status: 404 });
    if (!canAccessDepartment(auth.membership, previousDoc.departmentId)) {
      return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
    }
    const accessLevel = await getDocumentAccessLevel({ orgId, doc: previousDoc, membership: auth.membership, email: auth.session.email });
    if (!meetsLevel(accessLevel, "EDIT")) {
      return NextResponse.json({ error: "You don't have permission to upload a new version of this document." }, { status: 403 });
    }

    const existing = await orgDocuments.findOne({ fileHash });
    if (existing) return NextResponse.json({ error: "This exact file has already been registered." }, { status: 409 });

    const org = await orgs.findOne({ _id: orgObjectId });
    const plan = getOrgPlan(org);
    const sizeBytesNum = Number(sizeBytes);
    if (plan.maxFileSizeMB !== Infinity && sizeBytesNum > plan.maxFileSizeMB * BYTES_PER_MB) {
      return NextResponse.json({ error: `Your ${plan.name} plan allows files up to ${plan.maxFileSizeMB} MB. Upgrade to upload larger files.` }, { status: 413 });
    }
    if (plan.maxStorageGB !== Infinity) {
      const { storageUsedBytes } = await getOrgUsage(orgId);
      if (storageUsedBytes + sizeBytesNum > plan.maxStorageGB * BYTES_PER_GB) {
        return NextResponse.json({ error: `Your ${plan.name} plan's ${plan.maxStorageGB} GB storage limit is full. Upgrade for more space.` }, { status: 403 });
      }
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const treasuryWallet = new ethers.Wallet(TREASURY_WALLET_PRIVATE_KEY, provider);
    const custodyRead = new ethers.Contract(CUSTODY_ADDRESS, CUSTODY_ABI, provider);
    const custody = new ethers.Contract(CUSTODY_ADDRESS, CUSTODY_ABI, treasuryWallet);

    const [usdtFeePerGB, inayaFeePerGB] = await Promise.all([custodyRead.usdtFeePerGB(), custodyRead.inayaFeePerGB()]);
    const sizeBigInt = BigInt(sizeBytes);
    const usdtFee = (sizeBigInt * usdtFeePerGB) / GB;
    const inayaFee = (sizeBigInt * inayaFeePerGB) / GB;

    if (usdtFee > 0n) {
      const usdt = new ethers.Contract(USDT_TOKEN_ADDRESS, ERC20_ABI, treasuryWallet);
      const allowance = await usdt.allowance(treasuryWallet.address, CUSTODY_ADDRESS);
      if (allowance < usdtFee) await (await usdt.approve(CUSTODY_ADDRESS, ethers.MaxUint256)).wait();
    }
    if (inayaFee > 0n) {
      const inaya = new ethers.Contract(INAYA_TOKEN_ADDRESS, ERC20_ABI, treasuryWallet);
      const allowance = await inaya.allowance(treasuryWallet.address, CUSTODY_ADDRESS);
      if (allowance < inayaFee) await (await inaya.approve(CUSTODY_ADDRESS, ethers.MaxUint256)).wait();
    }

    const registerTx = await custody.batchRegisterAssets([fileHash], [sizeBytes], [cidAlpha], [cidBeta]);
    await registerTx.wait();

    const now = new Date().toISOString();
    const newDocumentId = new ObjectId();
    const documentGroupId = previousDoc.documentGroupId || previousDoc._id;
    await orgDocuments.insertOne({
      _id: newDocumentId,
      orgId: orgObjectId,
      departmentId: previousDoc.departmentId,
      projectId: previousDoc.projectId,
      filename,
      fileHash,
      sizeBytes: sizeBytesNum,
      cidAlpha,
      cidBeta,
      uploadedByEmail: auth.session.email,
      txHash: registerTx.hash,
      status: "DRAFT",
      accessLevel: previousDoc.accessLevel || "DEPARTMENT",
      documentGroupId,
      version: (previousDoc.version || 1) + 1,
      supersedesId: previousDoc._id,
      createdAt: now,
      deletedAt: null,
    });

    await logDocumentActivity({
      organizationId: orgObjectId, documentId: newDocumentId, actorId: auth.session.email,
      action: "NEW_VERSION_UPLOADED", previousState: null, newState: "DRAFT",
      metadata: { filename, version: (previousDoc.version || 1) + 1, supersedesId: previousDoc._id.toString() },
    });

    const { supersededCount } = await supersedeActiveSigningRequests({ orgId, oldDocumentId: previousDoc._id, actorEmail: auth.session.email });

    return NextResponse.json({
      registered: true, txHash: registerTx.hash, documentId: newDocumentId.toString(),
      version: (previousDoc.version || 1) + 1, documentGroupId: documentGroupId.toString(), supersededSigningRequests: supersededCount,
    });
  } catch (err) {
    console.error("orgs/documents/[documentId]/versions POST failed:", err);
    return NextResponse.json({ error: "Could not register the new document version." }, { status: 500 });
  }
}
