// src/app/api/aws-ec2/route.js
//
// Gap-closure round, Phase B (closes INFRA-AWS-001/002): a real, tested
// SUBSET of EC2's query-protocol API -- RunInstances, DescribeInstances,
// StartInstances, StopInstances, TerminateInstances, CreateVolume,
// DescribeVolumes, DeleteVolume, CreateVpc, DescribeVpcs, DeleteVpc. Not
// full AWS coverage: a real, `aws-cli`/boto3-interoperable subset, per the
// original SOW's own §220 standard ("only an operation set with real AWS
// CLI/SDK tests may be labeled compatible"). No new state model -- every
// action maps straight onto the existing operations.js functions.
//
// Single entry point, dispatching on the `Action` form field exactly like
// real EC2's own query protocol (not a REST-style path per action).

import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { verifySigV4, SigV4Error, extractAccessKeyId } from "../../../lib/infrastructure/awsSigV4.js";
import { resolveAccessKey } from "../../../lib/infrastructure/awsCredentials.js";
import { listClusters, InfrastructureError } from "../../../lib/infrastructure/nodes.js";
import * as O from "../../../lib/infrastructure/operations.js";
import * as X from "../../../lib/infrastructure/awsEc2Xml.js";

const XML_HEADERS = { "Content-Type": "text/xml;charset=UTF-8", "Cache-Control": "no-store" };

function xml(body, status = 200) {
  return new NextResponse(body, { status, headers: XML_HEADERS });
}

function ec2Error(requestId, code, message, status = 400) {
  return xml(X.errorResponse({ requestId, code, message }), status);
}

// Real EC2 instance-type shape (e.g. "t3.micro") isn't meaningful on this
// hardware -- a small, honestly-named synthetic catalog instead, matching
// the compute crate's own real vcpu/memoryMib model, not AWS's.
const INSTANCE_TYPES = {
  "inaya.small": { vcpu: 1, memoryMib: 1024 },
  "inaya.medium": { vcpu: 2, memoryMib: 2048 },
  "inaya.large": { vcpu: 4, memoryMib: 4096 },
  "inaya.xlarge": { vcpu: 8, memoryMib: 8192 },
};

function collectIndexed(form, prefix) {
  // botocore's query protocol sends list params as Prefix.1, Prefix.2, ...
  // -- also accept the bare singular form for a one-element list, since
  // some SDK code paths (and manual curl testing) send that instead.
  const out = [];
  if (form.has(prefix)) out.push(form.get(prefix));
  for (let i = 1; form.has(`${prefix}.${i}`); i++) out.push(form.get(`${prefix}.${i}`));
  return out;
}

function findTagValue(form, key) {
  for (let i = 1; form.has(`TagSpecification.${i}.ResourceType`); i++) {
    for (let j = 1; form.has(`TagSpecification.${i}.Tag.${j}.Key`); j++) {
      if (form.get(`TagSpecification.${i}.Tag.${j}.Key`) === key) return form.get(`TagSpecification.${i}.Tag.${j}.Value`);
    }
  }
  return null;
}

export async function POST(req) {
  const requestId = crypto.randomUUID();
  const rawBody = await req.text();
  const headers = Object.fromEntries([...req.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));

  // --- Authentication: real SigV4, identity derives only from the
  // credential itself (same discipline as api-keys.js/nodes.js's node
  // auth) -- the caller never gets to assert its own orgId. ---
  const accessKeyId = extractAccessKeyId(headers["authorization"]);
  if (!accessKeyId) return ec2Error(requestId, "AuthFailure", "Missing or malformed AWS SigV4 Authorization header.", 401);
  const resolved = await resolveAccessKey({ accessKeyId });
  if (!resolved) return ec2Error(requestId, "AuthFailure", "The AWS access key ID you provided does not exist or has been revoked.", 401);

  let orgId;
  try {
    verifySigV4({ method: "POST", url: req.url, headers, body: rawBody, getSecretForAccessKey: () => resolved.secretAccessKey });
    orgId = resolved.orgId;
  } catch (err) {
    if (err instanceof SigV4Error) return ec2Error(requestId, "SignatureDoesNotMatch", err.message, 401);
    throw err;
  }

  const form = new URLSearchParams(rawBody);
  const action = form.get("Action");

  try {
    switch (action) {
      case "RunInstances": {
        const instanceType = form.get("InstanceType") || "inaya.small";
        const sizing = INSTANCE_TYPES[instanceType];
        if (!sizing) return ec2Error(requestId, "InvalidParameterValue", `Unknown InstanceType "${instanceType}". Known types: ${Object.keys(INSTANCE_TYPES).join(", ")}.`);
        const explicitClusterId = findTagValue(form, "clusterId");
        let clusterId = explicitClusterId;
        if (!clusterId) {
          const clusters = await listClusters({ orgId });
          if (clusters.length === 0) return ec2Error(requestId, "InvalidParameterValue", "This org has no infrastructure cluster yet -- create one first, or pass a clusterId tag.");
          if (clusters.length > 1) return ec2Error(requestId, "InvalidParameterValue", "This org has multiple clusters -- pass a clusterId tag (TagSpecification) to pick one.");
          clusterId = clusters[0].clusterId;
        }
        const name = form.get("TagSpecification.1.Tag.1.Value") || `aws-ec2-${Date.now()}`;
        const result = await O.createInstance({ orgId, membership: { email: null }, clusterId, name, vcpu: sizing.vcpu, memoryMib: sizing.memoryMib });
        const instance = await O.getInstance({ orgId, instanceId: result.instanceId });
        return xml(X.runInstancesResponse({ requestId, instance }));
      }
      case "DescribeInstances": {
        const ids = collectIndexed(form, "InstanceId");
        let instances = await O.listInstances({ orgId });
        if (ids.length > 0) instances = instances.filter((i) => ids.includes(i.instanceId));
        return xml(X.describeInstancesResponse({ requestId, instances }));
      }
      case "StartInstances":
      case "StopInstances":
      case "TerminateInstances": {
        const ids = collectIndexed(form, "InstanceId");
        if (ids.length === 0) return ec2Error(requestId, "MissingParameter", "InstanceId.N is required.");
        const instanceId = ids[0];
        const before = await O.getInstance({ orgId, instanceId });
        const fn = { StartInstances: O.startInstance, StopInstances: O.stopInstance, TerminateInstances: O.terminateInstance }[action];
        await fn({ orgId, membership: { email: null }, instanceId });
        const target = { StartInstances: "RUNNING", StopInstances: "STOPPED", TerminateInstances: "TERMINATED" }[action];
        const rootTag = { StartInstances: "StartInstancesResponse", StopInstances: "StopInstancesResponse", TerminateInstances: "TerminateInstancesResponse" }[action];
        const builder = { StartInstances: X.startInstancesResponse, StopInstances: X.stopInstancesResponse, TerminateInstances: X.terminateInstancesResponse }[action];
        return xml(builder({ requestId, instanceId, previousState: before.state, state: target }));
      }
      case "CreateVolume": {
        const clusterId = findTagValue(form, "clusterId") || (await firstClusterOrError(orgId, requestId));
        if (clusterId instanceof NextResponse) return clusterId;
        const sizeGib = Number(form.get("Size"));
        const nodeId = form.get("NodeId");
        if (!nodeId) return ec2Error(requestId, "MissingParameter", "This API requires a NodeId parameter (no automatic node scheduling for volumes yet).");
        const result = await O.createVolume({ orgId, membership: { email: null }, clusterId, nodeId, sizeGib });
        const volume = await O.getVolume({ orgId, volumeId: result.volumeId });
        return xml(X.createVolumeResponse({ requestId, volume }));
      }
      case "DescribeVolumes": {
        const ids = collectIndexed(form, "VolumeId");
        let volumes = await O.listVolumes({ orgId });
        if (ids.length > 0) volumes = volumes.filter((v) => ids.includes(v.volumeId));
        return xml(X.describeVolumesResponse({ requestId, volumes }));
      }
      case "DeleteVolume": {
        const volumeId = form.get("VolumeId");
        if (!volumeId) return ec2Error(requestId, "MissingParameter", "VolumeId is required.");
        await O.deleteVolume({ orgId, membership: { email: null }, volumeId });
        return xml(X.deleteVolumeResponse({ requestId }));
      }
      case "CreateVpc": {
        const clusterId = findTagValue(form, "clusterId") || (await firstClusterOrError(orgId, requestId));
        if (clusterId instanceof NextResponse) return clusterId;
        const cidr = form.get("CidrBlock");
        const nodeId = form.get("NodeId");
        if (!nodeId) return ec2Error(requestId, "MissingParameter", "This API requires a NodeId parameter (no automatic node scheduling for networks yet).");
        const result = await O.createVpc({ orgId, membership: { email: null }, clusterId, nodeId, cidr });
        const vpc = await O.getVpc({ orgId, vpcId: result.vpcId });
        return xml(X.createVpcResponse({ requestId, vpc }));
      }
      case "DescribeVpcs": {
        const ids = collectIndexed(form, "VpcId");
        let vpcs = await O.listVpcs({ orgId });
        if (ids.length > 0) vpcs = vpcs.filter((v) => ids.includes(v.vpcId));
        return xml(X.describeVpcsResponse({ requestId, vpcs }));
      }
      case "DeleteVpc": {
        const vpcId = form.get("VpcId");
        if (!vpcId) return ec2Error(requestId, "MissingParameter", "VpcId is required.");
        await O.deleteVpc({ orgId, membership: { email: null }, vpcId });
        return xml(X.deleteVpcResponse({ requestId }));
      }
      default:
        return ec2Error(requestId, "InvalidAction", `The action "${action}" is not supported by this endpoint. Supported: RunInstances, DescribeInstances, StartInstances, StopInstances, TerminateInstances, CreateVolume, DescribeVolumes, DeleteVolume, CreateVpc, DescribeVpcs, DeleteVpc.`);
    }
  } catch (err) {
    if (err instanceof InfrastructureError) return ec2Error(requestId, "InvalidParameterValue", err.message, err.status >= 400 && err.status < 500 ? 400 : 500);
    console.error("aws-ec2 route failed:", action, err?.name, String(err?.message || "").slice(0, 200));
    return ec2Error(requestId, "InternalError", "Something went wrong. Please try again.", 500);
  }
}

async function firstClusterOrError(orgId, requestId) {
  const clusters = await listClusters({ orgId });
  if (clusters.length === 0) return ec2Error(requestId, "InvalidParameterValue", "This org has no infrastructure cluster yet.");
  if (clusters.length > 1) return ec2Error(requestId, "InvalidParameterValue", "This org has multiple clusters -- pass a clusterId tag to pick one.");
  return clusters[0].clusterId;
}
