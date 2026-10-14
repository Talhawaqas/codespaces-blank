// src/lib/infrastructure/awsEc2Xml.js
//
// Gap-closure round, Phase B: real EC2-shaped XML responses. botocore's
// bundled EC2 model is a "query" protocol service and parses XML, not
// JSON -- a JSON response here would not work with the real `aws` CLI /
// boto3 regardless of how correct the rest of this route is.

const EC2_XMLNS = "http://ec2.amazonaws.com/doc/2016-11-15/";

function escapeXml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}

function tag(name, value) {
  return value === undefined || value === null ? "" : `<${name}>${escapeXml(value)}</${name}>`;
}

// Our internal state strings -> real EC2 (code, name) pairs. EC2's real
// numeric codes: pending=0, running=16, shutting-down=32, terminated=48,
// stopping=64, stopped=80 -- a real `aws ec2 describe-instances
// --query 'Reservations[].Instances[].State'` expects exactly this shape.
const INSTANCE_STATE_MAP = {
  PROVISIONING: [0, "pending"],
  RUNNING: [16, "running"],
  STOPPED: [80, "stopped"],
  TERMINATED: [48, "terminated"],
  ERROR: [80, "stopped"], // honest fallback: a real EC2 state has no "error" value; closest real code is stopped, not a fabricated one
};

function instanceXml(inst) {
  const [code, name] = INSTANCE_STATE_MAP[inst.state] || [0, "pending"];
  return (
    `<item>` +
    tag("instanceId", inst.instanceId) +
    `<instanceState>${tag("code", code)}${tag("name", name)}</instanceState>` +
    tag("instanceType", `inaya.vcpu${inst.vcpu}.mem${inst.memoryMib}`) +
    tag("privateIpAddress", inst.staticIp) +
    tag("vpcId", inst.vpcId) +
    `<tagSet/>` + // tags aren't modeled yet -- a real empty set, never fabricated entries
    `</item>`
  );
}

export function runInstancesResponse({ requestId, instance }) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<RunInstancesResponse xmlns="${EC2_XMLNS}">` +
    tag("requestId", requestId) +
    tag("reservationId", `r-${instance.instanceId.replace(/-/g, "").slice(0, 17)}`) +
    `<instancesSet>${instanceXml(instance)}</instancesSet>` +
    `</RunInstancesResponse>`
  );
}

export function describeInstancesResponse({ requestId, instances }) {
  const items = instances.map((inst) => `<item><reservationId>r-${inst.instanceId.replace(/-/g, "").slice(0, 17)}</reservationId><instancesSet>${instanceXml(inst)}</instancesSet></item>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n` + `<DescribeInstancesResponse xmlns="${EC2_XMLNS}">` + tag("requestId", requestId) + `<reservationSet>${items}</reservationSet>` + `</DescribeInstancesResponse>`;
}

function instanceStateChangeResponse(rootTag, { requestId, instanceId, previousState, state }) {
  const [prevCode, prevName] = INSTANCE_STATE_MAP[previousState] || [0, "pending"];
  const [curCode, curName] = INSTANCE_STATE_MAP[state] || [0, "pending"];
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<${rootTag} xmlns="${EC2_XMLNS}">` +
    tag("requestId", requestId) +
    `<instancesSet><item>` +
    tag("instanceId", instanceId) +
    `<currentState>${tag("code", curCode)}${tag("name", curName)}</currentState>` +
    `<previousState>${tag("code", prevCode)}${tag("name", prevName)}</previousState>` +
    `</item></instancesSet>` +
    `</${rootTag}>`
  );
}
export const startInstancesResponse = (args) => instanceStateChangeResponse("StartInstancesResponse", args);
export const stopInstancesResponse = (args) => instanceStateChangeResponse("StopInstancesResponse", args);
export const terminateInstancesResponse = (args) => instanceStateChangeResponse("TerminateInstancesResponse", args);

// EBS real volume-state strings: creating, available, in-use, deleting,
// deleted, error -- our internal states already use this exact vocabulary
// (CREATING/AVAILABLE/IN_USE/DELETING/DELETED/FAILED), just upper vs
// lower/hyphenated.
const VOLUME_STATE_MAP = { CREATING: "creating", AVAILABLE: "available", ATTACHING: "in-use", IN_USE: "in-use", DELETING: "deleting", DELETED: "deleted", FAILED: "error" };

function volumeXml(vol) {
  return `<item>` + tag("volumeId", vol.volumeId) + tag("size", vol.sizeGib) + tag("status", VOLUME_STATE_MAP[vol.status] || "error") + tag("volumeType", "inaya-standard") + `</item>`;
}

export function createVolumeResponse({ requestId, volume }) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n` + `<CreateVolumeResponse xmlns="${EC2_XMLNS}">` + tag("requestId", requestId) + tag("volumeId", volume.volumeId) + tag("size", volume.sizeGib) + tag("status", VOLUME_STATE_MAP[volume.status] || "creating") + `</CreateVolumeResponse>`;
}

export function describeVolumesResponse({ requestId, volumes }) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n` + `<DescribeVolumesResponse xmlns="${EC2_XMLNS}">` + tag("requestId", requestId) + `<volumeSet>${volumes.map(volumeXml).join("")}</volumeSet>` + `</DescribeVolumesResponse>`;
}

export function deleteVolumeResponse({ requestId }) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n` + `<DeleteVolumeResponse xmlns="${EC2_XMLNS}">` + tag("requestId", requestId) + tag("return", "true") + `</DeleteVolumeResponse>`;
}

const VPC_STATE_MAP = { CREATING: "pending", AVAILABLE: "available", DELETING: "pending", DELETED: "available", FAILED: "available" };

function vpcXml(vpc) {
  return `<item>` + tag("vpcId", vpc.vpcId) + tag("state", VPC_STATE_MAP[vpc.status] || "pending") + tag("cidrBlock", vpc.cidr) + `</item>`;
}

export function createVpcResponse({ requestId, vpc }) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n` + `<CreateVpcResponse xmlns="${EC2_XMLNS}">` + tag("requestId", requestId) + `<vpc>${tag("vpcId", vpc.vpcId)}${tag("state", VPC_STATE_MAP[vpc.status] || "pending")}${tag("cidrBlock", vpc.cidr)}</vpc>` + `</CreateVpcResponse>`;
}

export function describeVpcsResponse({ requestId, vpcs }) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n` + `<DescribeVpcsResponse xmlns="${EC2_XMLNS}">` + tag("requestId", requestId) + `<vpcSet>${vpcs.map(vpcXml).join("")}</vpcSet>` + `</DescribeVpcsResponse>`;
}

export function deleteVpcResponse({ requestId }) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n` + `<DeleteVpcResponse xmlns="${EC2_XMLNS}">` + tag("requestId", requestId) + tag("return", "true") + `</DeleteVpcResponse>`;
}

/** EC2's query-protocol error shape -- distinct from most other AWS
 *  services' <ErrorResponse> wrapper. botocore's EC2 model specifically
 *  parses this shape; using the generic AWS error envelope here would not
 *  actually be understood by a real `aws-cli` call. */
export function errorResponse({ requestId, code, message }) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n` + `<Response><Errors><Error>${tag("Code", code)}${tag("Message", message)}</Error></Errors>${tag("RequestID", requestId)}</Response>`;
}
