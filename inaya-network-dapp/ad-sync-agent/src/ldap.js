// ad-sync-agent/src/ldap.js
//
// Real LDAP access to a real Active Directory domain controller, using
// AD's own standard, documented incremental-sync mechanism: the
// uSNChanged attribute (an Update Sequence Number, monotonically
// increasing on every object write, forest-wide, that DC's own
// highestCommittedUSN advances). A first run does a full pull (no
// watermark); every run after that queries only objects whose
// uSNChanged is greater than the last watermark saved to disk -- the
// same technique every real AD-integrating product (DirSync, AAD
// Connect, etc.) uses, not a polling-everything hack.

import ldap from "ldapjs";

const USER_ATTRS = [
  "objectGUID", "objectSid", "userPrincipalName", "sAMAccountName", "mail",
  "employeeID", "displayName", "department", "title", "manager", "memberOf",
  "userAccountControl", "whenChanged", "uSNChanged", "distinguishedName",
];

function bind({ url, bindDN, bindPassword, tlsOptions }) {
  return new Promise((resolve, reject) => {
    const client = ldap.createClient({ url, tlsOptions, reconnect: false });
    client.on("error", reject);
    client.bind(bindDN, bindPassword, (err) => {
      if (err) return reject(err);
      resolve(client);
    });
  });
}

/** A fire-and-forget client.unbind() lets the process (or the next await
 *  in agent.js) move on before ldapjs/libuv has actually finished tearing
 *  down the underlying TCP handle -- on Windows specifically, that race
 *  crashed the whole process on exit with "Assertion failed:
 *  !(handle->flags & UV_HANDLE_CLOSING)" (src/win/async.c), confirmed
 *  live, after every real unit of work had already completed
 *  successfully. Awaiting the real unbind callback closes the handle
 *  properly before this function returns. */
function unbind(client) {
  return new Promise((resolve) => {
    client.unbind((err) => {
      if (err) console.error(`[ad-sync-agent] ldap unbind warning: ${err.message}`);
      resolve();
    });
  });
}

/** GUID comes back from AD as a raw 16-byte Buffer over LDAP -- this
 *  renders it as the standard hyphenated hex form so it's a stable,
 *  human-comparable externalId, not opaque binary. */
function guidToString(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length !== 16) return undefined;
  const h = [...buf].map((b) => b.toString(16).padStart(2, "0"));
  return [
    h[3] + h[2] + h[1] + h[0],
    h[5] + h[4],
    h[7] + h[6],
    h[8] + h[9],
    h[10] + h[11] + h[12] + h[13] + h[14] + h[15],
  ].join("-");
}

/** AD's whenChanged comes back in LDAP GeneralizedTime format
 *  ("20261229031500.0Z" -- YYYYMMDDHHMMSS[.fraction](Z|+-HHMM)), not
 *  ISO-8601. src/lib/identity/normalize.js's validateCanonical() uses
 *  Date.parse() on occurredAt and rejects anything it can't parse --
 *  AD's raw format fails that check silently different from ISO, so
 *  this converts it for real rather than dropping the actual AD
 *  timestamp in favor of "whenever the agent happened to run". */
export function generalizedTimeToIso(gt) {
  if (!gt || typeof gt !== "string") return undefined;
  const m = gt.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?(Z|[+-]\d{4})?$/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, frac, tz] = m;
  const ms = frac ? frac.slice(0, 3).padEnd(3, "0") : "000";
  let iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}`;
  if (!tz || tz === "Z") {
    iso += "Z";
  } else {
    iso += `${tz.slice(0, 3)}:${tz.slice(3)}`;
  }
  const parsed = new Date(iso);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function entryToRawAd(entry) {
  const get = (name) => {
    const attr = entry.attributes.find((a) => a.type.toLowerCase() === name.toLowerCase());
    if (!attr) return undefined;
    const vals = attr.values;
    return vals.length <= 1 ? vals[0] : vals;
  };
  const objectGUIDAttr = entry.attributes.find((a) => a.type.toLowerCase() === "objectguid");
  const objectGUID = objectGUIDAttr?.buffers?.[0] ? guidToString(objectGUIDAttr.buffers[0]) : undefined;

  return {
    objectGUID,
    objectSid: get("objectSid"),
    userPrincipalName: get("userPrincipalName"),
    sAMAccountName: get("sAMAccountName"),
    mail: get("mail"),
    employeeID: get("employeeID"),
    displayName: get("displayName"),
    department: get("department"),
    title: get("title"),
    manager: get("manager"),
    memberOf: (() => { const m = get("memberOf"); return m === undefined ? [] : Array.isArray(m) ? m : [m]; })(),
    userAccountControl: get("userAccountControl"),
    whenChanged: generalizedTimeToIso(get("whenChanged")),
    uSNChanged: get("uSNChanged"),
    distinguishedName: get("distinguishedName"),
  };
}

/** Real LDAP search against a real DC. filterUsnFloor, when set, restricts
 *  to objects changed since that watermark (real incremental sync);
 *  omitted, this is a real full pull. Excludes computer/service accounts
 *  the same way AD Connect does: objectCategory=person AND
 *  objectClass=user, explicitly not objectClass=computer (a computer
 *  account also satisfies a naive objectClass=user filter in AD's own
 *  schema, since computer is a subclass of user). */
export async function fetchUsers({ url, bindDN, bindPassword, baseDN, tlsOptions, filterUsnFloor }) {
  const client = await bind({ url, bindDN, bindPassword, tlsOptions });
  const usnClause = filterUsnFloor ? `(uSNChanged>=${Number(filterUsnFloor) + 1})` : "";
  const filter = `(&(objectCategory=person)(objectClass=user)(!(objectClass=computer))${usnClause})`;

  const results = [];
  try {
    await new Promise((resolve, reject) => {
      client.search(baseDN, { filter, scope: "sub", attributes: USER_ATTRS, paged: { pageSize: 500 } }, (err, res) => {
        if (err) return reject(err);
        res.on("searchEntry", (entry) => results.push(entryToRawAd(entry)));
        res.on("error", reject);
        res.on("end", (result) => {
          if (result?.status !== 0) return reject(new Error(`LDAP search ended with status ${result?.status}`));
          resolve();
        });
      });
    });
  } finally {
    await unbind(client);
  }
  return results;
}

/** Real RootDSE read for highestCommittedUSN -- this DC's own current
 *  watermark ceiling, saved after a successful sync so the next run's
 *  incremental filter has an accurate floor. */
export async function fetchHighestCommittedUsn({ url, bindDN, bindPassword, tlsOptions }) {
  const client = await bind({ url, bindDN, bindPassword, tlsOptions });
  try {
    return await new Promise((resolve, reject) => {
      client.search("", { filter: "(objectClass=*)", scope: "base", attributes: ["highestCommittedUSN"] }, (err, res) => {
        if (err) return reject(err);
        let value;
        res.on("searchEntry", (entry) => {
          const attr = entry.attributes.find((a) => a.type.toLowerCase() === "highestcommittedusn");
          if (attr) value = Number(attr.values[0]);
        });
        res.on("error", reject);
        res.on("end", () => resolve(value));
      });
    });
  } finally {
    await unbind(client);
  }
}
