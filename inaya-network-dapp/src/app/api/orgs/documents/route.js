// app/api/orgs/documents/route.js
//
// POST /api/orgs/documents  { orgId, departmentId, projectId, filename, fileHash, sizeBytes, cidAlpha, cidBeta }
//   Registers an already-encrypted-and-pinned document on-chain and records
//   it under an org/department/project. The client does the actual work
//   (encrypt with a passkey, shard, pin to IPFS via Pinata) using the exact
//   same pipeline the existing wallet-connected flow uses — this route only
//   takes over from "file is encrypted and pinned" onward, the same handoff
//   point settlePaygUpload() in app/api/stripe-webhook/route.js uses for
//   card customers. The on-chain call itself is intentionally duplicated
//   from that function rather than extracted into a shared helper — that
//   file handles real payment webhooks, and refactoring it purely for
//   reuse here isn't worth the risk to something already working in
//   production for an unrelated reason.
//
// GET /api/orgs/documents?orgId=...&departmentId=...&projectId=...
//   Lists documents in a project — metadata only, never cidAlpha/cidBeta
//   (see the dedicated .../[documentId]/retrieve route for that, which
//   goes through the same permission resolution but is its own explicit
//   step, per the SOW's "never bypass authorization to reach retrieval"
//   requirement). Listable by anyone who can access the department OR is
//   a project member (Phase 3 — project membership is its own path to a
//   project's resources, not gated behind also being in the department);
//   each individual document is then filtered by its resolved access
//   level, so e.g. a PRIVATE document in an otherwise-visible project
//   still won't appear for someone without an explicit grant.

import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../lib/orgs.js";
import { logDocumentActivity } from "../../../../lib/document-workflow.js";
import { getBulkDocumentAccess, isProjectMember, ACCESS_LEVELS } from "../../../../lib/document-permissions.js";

const RPC_URL = process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545";
const CUSTODY_ADDRESS = "0x7F5E6cF1353beEE4fc19FD46Dd6EaD0B3895a888"; // matches page.js's liveContractAddress / stripe-webhook's CUSTODY_ADDRESS
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

export const maxDuration = 60; // on-chain confirmations can be slow, same reasoning as stripe-webhook's maxDuration

export async function POST(req) {
  try {
    const { orgId, departmentId, projectId, filename, fileHash, sizeBytes, cidAlpha, cidBeta, accessLevel = "DEPARTMENT" } = await req.json();

    if (!orgId || !departmentId || !projectId) {
      return NextResponse.json({ error: "orgId, departmentId, and projectId are required." }, { status: 400 });
    }
    if (!filename || !fileHash || !sizeBytes || !cidAlpha || !cidBeta) {
      return NextResponse.json({ error: "filename, fileHash, sizeBytes, cidAlpha, and cidBeta are required." }, { status: 400 });
    }
    if (!ACCESS_LEVELS.includes(accessLevel)) {
      return NextResponse.json({ error: `accessLevel must be one of: ${ACCESS_LEVELS.join(", ")}` }, { status: 400 });
    }

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessDepartment(auth.membership, departmentId)) {
      return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
    }

    const { departments, projects, orgDocuments } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const departmentObjectId = toObjectId(departmentId);
    const projectObjectId = toObjectId(projectId);

    const [department, project] = await Promise.all([
      departments.findOne({ _id: departmentObjectId, orgId: orgObjectId }),
      projects.findOne({ _id: projectObjectId, orgId: orgObjectId, departmentId: departmentObjectId }),
    ]);
    if (!department) return NextResponse.json({ error: "Department not found." }, { status: 404 });
    if (!project) return NextResponse.json({ error: "Project not found in this department." }, { status: 404 });

    const existing = await orgDocuments.findOne({ fileHash });
    if (existing) return NextResponse.json({ error: "This exact file has already been registered." }, { status: 409 });

    // Same on-chain registration pattern as settlePaygUpload() — treasury
    // wallet fronts whatever protocol fee applies and registers the asset,
    // since the org member has no wallet of their own to sign with.
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
    const insertResult = await orgDocuments.insertOne({
      orgId: orgObjectId,
      departmentId: departmentObjectId,
      projectId: projectObjectId,
      filename,
      fileHash,
      sizeBytes: Number(sizeBytes),
      cidAlpha,
      cidBeta,
      uploadedByEmail: auth.session.email,
      txHash: registerTx.hash,
      status: "DRAFT", // Phase 2 workflow — see src/lib/document-workflow.js
      accessLevel, // Phase 3 permissions — see src/lib/document-permissions.js
      createdAt: now,
      deletedAt: null,
    });

    await logDocumentActivity({
      organizationId: orgObjectId,
      documentId: insertResult.insertedId,
      actorId: auth.session.email,
      action: "CREATED",
      previousState: null,
      newState: "DRAFT",
      metadata: { filename },
    });

    return NextResponse.json({ registered: true, txHash: registerTx.hash, documentId: insertResult.insertedId.toString() });
  } catch (err) {
    console.error("orgs/documents POST failed:", err);
    return NextResponse.json({ error: "Could not register the document." }, { status: 500 });
  }
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const departmentId = searchParams.get("departmentId");
    const projectId = searchParams.get("projectId");
    if (!orgId || !departmentId || !projectId) {
      return NextResponse.json({ error: "orgId, departmentId, and projectId are required." }, { status: 400 });
    }

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const hasDeptAccess = canAccessDepartment(auth.membership, departmentId);
    const hasProjectAccess = hasDeptAccess || (await isProjectMember({ orgId, projectId, email: auth.session.email }));
    if (!hasProjectAccess) {
      return NextResponse.json({ error: "You don't have access to this project." }, { status: 403 });
    }

    const { orgDocuments } = await getOrgCollections();
    const list = await orgDocuments
      .find({ orgId: toObjectId(orgId), departmentId: toObjectId(departmentId), projectId: toObjectId(projectId), deletedAt: null })
      .sort({ createdAt: -1 })
      .toArray();

    // Per-document filtering — being able to see the project doesn't mean
    // every document inside it is visible (a PRIVATE one still needs an
    // explicit grant or ownership). One bulk resolution, not one query per doc.
    const accessByDoc = await getBulkDocumentAccess({ orgId, email: auth.session.email, membership: auth.membership, docs: list });
    const visible = list.filter((d) => accessByDoc.get(d._id.toString()));

    return NextResponse.json({
      documents: visible.map((d) => ({
        id: d._id.toString(),
        filename: d.filename,
        fileHash: d.fileHash,
        sizeBytes: d.sizeBytes,
        uploadedByEmail: d.uploadedByEmail,
        status: d.status,
        accessLevel: d.accessLevel || "DEPARTMENT",
        yourAccessLevel: accessByDoc.get(d._id.toString()),
        createdAt: d.createdAt,
      })),
    });
  } catch (err) {
    console.error("orgs/documents GET failed:", err);
    return NextResponse.json({ error: "Could not fetch documents." }, { status: 500 });
  }
}
